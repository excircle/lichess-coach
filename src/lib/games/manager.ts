import { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { Chess } from "chess.js";
import {
  applyUci,
  newGameFromFen,
  phaseOfFen,
  toWhitePov,
  uciLineToSan,
  winPctDrop,
  winPctFromEval,
  judgmentFromDrop,
  formatEval,
} from "@/lib/chess";
import {
  buildAutoPrompt,
  buildHintPrompt,
  buildOpeningPrompt,
  OPENING_SYSTEM_PROMPT,
} from "@/lib/coach/prompts";
import { CoachUnavailableError, requestCoachText } from "@/lib/coach/service";
import { db } from "@/lib/db";
import {
  coachComments,
  games,
  moves as movesTable,
  openingPlies,
} from "@/lib/db/schema";
import { getStoredCredentials } from "@/lib/lichess/client";
import { streamNdjson } from "@/lib/lichess/ndjson";
import { isBookMove, lookupOpening, studentWdl } from "@/lib/openings/book";
import { STARTPOS } from "@/lib/openings/explorer";
import { evalLive } from "@/lib/stockfish/service";
import type { EngineEval } from "@/lib/stockfish/engine";
import {
  type BoardGameFull,
  type BoardGameState,
  type BoardLine,
  type BookMove,
  type CoachCommentView,
  type CoachEvent,
  type CoachMode,
  type GameEventPayload,
  type GameSnapshot,
  type OpeningState,
  type SnapshotMove,
  deriveResult,
  isTerminalStatus,
  plyLabel,
} from "./types";

type GameRow = typeof games.$inferSelect;

// ---------------------------------------------------------------------------
// GameManager — the architectural heart (PLAN.md): consumes one board stream,
// holds canonical state, persists to SQLite, evaluates every ply on the live
// Stockfish instance, triggers the coach once per full move cycle (after the
// AI reply's eval lands), and emits state/eval/coach/finish events for SSE.
// Lifecycle per amendment A2: a clean close is the NORMAL end-of-game signal
// once a terminal status was seen; reconnect only while created/started.
// ---------------------------------------------------------------------------

export class GameManager extends EventEmitter {
  readonly gameId: string;
  readonly userColor: "white" | "black";
  private chess: Chess;
  private movesList: SnapshotMove[] = [];
  private comments: CoachCommentView[] = [];
  private status: string;
  private winner: string | null = null;
  private wtime: number | null = null;
  private btime: number | null = null;
  private clockAt = Date.now();
  private initialFen: string | null;
  private startedAtSet: boolean;
  private stopped = false;
  private started = false;
  private abortStream?: () => void;
  private coachAbort?: AbortController;
  private hintPending = false;
  private row: GameRow;
  // Opening study state (PLAN OS §5.5): rehydrated from opening_plies.
  private openingByPly = new Map<number, OpeningState>();
  private openingChain: Promise<unknown> = Promise.resolve(); // D3 ordering
  private leftBookPly: number | null = null; // sticky, first non-book ply
  private leftBookAnnounced = false; // "just left theory" said once (D6)

  constructor(row: GameRow) {
    super();
    this.setMaxListeners(50);
    this.row = row;
    this.gameId = row.id;
    this.userColor = row.userColor;
    this.status = row.status;
    this.winner = row.winner;
    this.initialFen = row.initialFen;
    this.startedAtSet = row.startedAt != null;
    this.chess = newGameFromFen(row.initialFen);
    // Rehydrate prior moves (boot re-attach): replay from the stored string.
    if (row.movesUci) {
      try {
        this.applyMovesString(row.movesUci, null);
      } catch (error) {
        console.error(`[game ${this.gameId}] rehydrate failed, resetting:`, error);
        this.resetReplayState();
      }
    }
    // Rehydrate stored eval annotations + coach comments.
    const storedMoves = db
      .select()
      .from(movesTable)
      .where(eq(movesTable.gameId, this.gameId))
      .orderBy(movesTable.ply)
      .all();
    for (const m of storedMoves) {
      const local = this.movesList[m.ply - 1];
      if (!local) continue;
      local.evalCp = m.evalCp;
      local.evalMate = m.evalMate;
      local.winPct = m.winPct;
      local.cpLoss = m.cpLoss;
      local.judgment = m.judgment;
      local.bestMoveUci = m.bestMoveUci;
    }
    this.comments = db
      .select()
      .from(coachComments)
      .where(eq(coachComments.gameId, this.gameId))
      .orderBy(coachComments.createdAt)
      .all()
      .map((c) => ({
        ply: c.ply,
        trigger: c.trigger,
        content: c.content,
        createdAt: c.createdAt.getTime(),
      }));
    // Rehydrate opening annotations (OS-D8). Nothing hits the network here —
    // same rule as evals; gaps are backfilled from cache at gameFull.
    const openingRows = db
      .select()
      .from(openingPlies)
      .where(eq(openingPlies.gameId, this.gameId))
      .orderBy(openingPlies.ply)
      .all();
    for (const r of openingRows) {
      if (r.ply > this.movesList.length) continue; // dangling after a reset
      if (r.ply > 0 && r.inBook === false) this.leftBookPly ??= r.ply;
      const bookMoves = parseBookMoves(r.bookMoves);
      this.openingByPly.set(r.ply, {
        ply: r.ply,
        eco: r.eco,
        name: r.name,
        source: r.source,
        bookMoves,
        suggestedUci: r.suggestedUci,
        suggestedSan: bookMoves[0]?.san ?? null,
        inBookNow: bookMoves.length > 0,
        lastMoveInBook: r.inBook,
        leftBookPly: this.leftBookPly,
        fen:
          r.ply === 0
            ? newGameFromFen(this.initialFen).fen()
            : this.movesList[r.ply - 1].fenAfter,
      });
    }
  }

  get terminal(): boolean {
    return isTerminalStatus(this.status);
  }

  get coachMode(): CoachMode {
    return this.row.coachMode;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.terminal) void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abortStream?.();
    this.coachAbort?.abort();
  }

  setCoachMode(mode: CoachMode): void {
    if (mode === this.row.coachMode) return;
    db.update(games).set({ coachMode: mode }).where(eq(games.id, this.gameId)).run();
    this.row = { ...this.row, coachMode: mode };
    if (mode === "off") this.coachAbort?.abort();
    // §5.5 step 7: switching to opening mid-game backfills missing plies —
    // cache makes this cheap.
    if (mode === "opening" && !this.terminal) this.backfillOpeningPlies();
    this.emitEvent({ type: "state", snapshot: this.getSnapshot() });
  }

  getSnapshot(): GameSnapshot {
    return {
      game: {
        id: this.gameId,
        userColor: this.userColor,
        aiLevel: this.row.aiLevel,
        status: this.status,
        winner: this.winner ?? this.row.winner,
        result: deriveResult(this.status, this.winner ?? this.row.winner),
        coachMode: this.row.coachMode,
        clockInitial: this.row.clockInitial,
        clockIncrement: this.row.clockIncrement,
        speed: this.row.speed,
      },
      moves: [...this.movesList],
      comments: [...this.comments],
      opening: this.latestOpening(),
      fen: this.chess.fen(),
      turn: this.chess.turn() === "w" ? "white" : "black",
      wtime: this.wtime,
      btime: this.btime,
      clockAt: this.clockAt,
      finished: this.terminal,
    };
  }

  // ------------------------------------------------------------- stream loop

  private async runLoop(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped && !this.terminal) {
      const creds = getStoredCredentials();
      if (!creds) {
        await sleep(5_000);
        continue;
      }
      const connectedAt = Date.now();
      const stream = streamNdjson<BoardLine>({
        url: `https://lichess.org/api/board/game/stream/${this.gameId}`,
        token: creds.token,
        onJson: (line) => this.handleLine(line),
      });
      this.abortStream = stream.abort;
      // Board-stream keepalive blanks observed ~7s apart (spike-verified).
      const watchdog = setInterval(() => {
        if (Date.now() - stream.lastByteAt() > 20_000) {
          console.warn(`[game ${this.gameId}] watchdog: silent >20s, reconnecting`);
          stream.abort();
        }
      }, 5_000);
      const close = await stream.done;
      clearInterval(watchdog);
      if (this.stopped || this.terminal) break; // A2: normal end
      if (Date.now() - connectedAt > 60_000) backoff = 1_000;
      console.warn(
        `[game ${this.gameId}] stream closed pre-terminal (${close.type}) — reconnect in ${backoff}ms`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private handleLine(line: BoardLine): void {
    try {
      if (line.type === "gameFull") {
        this.handleGameFull(line as BoardGameFull);
      } else if (line.type === "gameState") {
        this.handleGameState(line as BoardGameState);
      }
      // chatLine / opponentGone tolerated and ignored (spec lists them).
    } catch (error) {
      console.error(`[game ${this.gameId}] error handling stream line:`, error);
    }
  }

  private handleGameFull(full: BoardGameFull): void {
    const initialFen =
      full.initialFen && full.initialFen !== "startpos" ? full.initialFen : null;
    if (initialFen !== this.initialFen) {
      this.initialFen = initialFen;
      this.resetReplayState();
    }
    const aiLevel = full.white?.aiLevel ?? full.black?.aiLevel ?? this.row.aiLevel;
    db.update(games)
      .set({
        speed: full.speed ?? this.row.speed,
        clockInitial:
          full.clock?.initial != null
            ? Math.round(full.clock.initial / 1000)
            : this.row.clockInitial,
        clockIncrement:
          full.clock?.increment != null
            ? Math.round(full.clock.increment / 1000)
            : this.row.clockIncrement,
        initialFen: this.initialFen,
        aiLevel,
      })
      .where(eq(games.id, this.gameId))
      .run();
    this.row = { ...this.row, aiLevel, speed: full.speed ?? this.row.speed };
    this.handleGameState(full.state);
    // PLAN OS §5.5 step 2: in opening mode make sure every ply up to the
    // current position has a lookup queued (normally just ply 0 — anything
    // more only after a restart with unpersisted plies; cache-cheap).
    if (this.row.coachMode === "opening" && !this.terminal) {
      this.backfillOpeningPlies();
      // D6 row 3: student White at the initial position → coach the start book.
      if (this.userColor === "white" && this.movesList.length === 0) {
        void this.triggerOpeningCoachAtStart();
      }
    }
  }

  private handleGameState(state: BoardGameState): void {
    this.wtime = state.wtime ?? this.wtime;
    this.btime = state.btime ?? this.btime;
    this.clockAt = Date.now();

    this.applyMovesString(state.moves, state);

    const wasTerminal = this.terminal;
    this.status = state.status;
    if (state.winner) this.winner = state.winner;

    if (!this.startedAtSet && this.status === "started") {
      this.startedAtSet = true;
      db.update(games)
        .set({ status: this.status, startedAt: new Date() })
        .where(eq(games.id, this.gameId))
        .run();
    }

    if (this.terminal && !wasTerminal) {
      this.finish();
    } else {
      db.update(games)
        .set({ status: this.status, movesUci: state.moves })
        .where(eq(games.id, this.gameId))
        .run();
      this.emitEvent({ type: "state", snapshot: this.getSnapshot() });
    }
  }

  // Applies the full-move-string delta. state === null during rehydrate.
  private applyMovesString(movesStr: string, state: BoardGameState | null): void {
    const tokens = movesStr.trim() ? movesStr.trim().split(/\s+/) : [];
    if (tokens.length < this.movesList.length) {
      console.warn(`[game ${this.gameId}] server moves < local — full resync`);
      this.resetReplayState();
      db.delete(movesTable).where(eq(movesTable.gameId, this.gameId)).run();
      // OS-A4: stale book verdicts must not survive keyed to dead plies.
      db.delete(openingPlies).where(eq(openingPlies.gameId, this.gameId)).run();
      this.openingByPly.clear();
      this.leftBookPly = null;
      this.leftBookAnnounced = false;
    }
    const newTokens = tokens.slice(this.movesList.length);
    const singleNewPly = newTokens.length === 1;
    for (const uci of newTokens) {
      const color: "white" | "black" = this.chess.turn() === "w" ? "white" : "black";
      const move = applyUci(this.chess, uci);
      const ply = this.movesList.length + 1;
      // Clocks in gameState are post-move totals: only attributable when
      // exactly one new ply arrived; backfilled plies get null. Unlimited
      // games (no clock) store null rather than lichess's sentinel values.
      const clockMs =
        state && singleNewPly && this.row.clockInitial != null
          ? ((color === "white" ? state.wtime : state.btime) ?? null)
          : null;
      const snapshotMove: SnapshotMove = {
        ply,
        color,
        san: move.san,
        uci,
        fenAfter: this.chess.fen(),
        clockMs,
        isUserMove: color === this.userColor,
      };
      this.movesList.push(snapshotMove);
      db.insert(movesTable)
        .values({
          gameId: this.gameId,
          ply,
          san: move.san,
          uci,
          fenAfter: snapshotMove.fenAfter,
          clockMs,
          isUserMove: snapshotMove.isUserMove,
          phase: phaseOfFen(snapshotMove.fenAfter, ply),
        })
        .onConflictDoNothing()
        .run();
      // Live evals only while the game is being streamed (not rehydration —
      // boot re-attach gets fresh state via gameFull anyway, and stored evals
      // were rehydrated in the constructor).
      if (state) this.queueEval(snapshotMove);
      // PLAN OS §5.5 step 3: one opening lookup per new ply, on the D3 chain.
      if (state && this.row.coachMode === "opening") {
        this.enqueueOpeningLookup(ply);
      }
    }
  }

  private resetReplayState(): void {
    this.chess = newGameFromFen(this.initialFen);
    this.movesList = [];
  }

  // ------------------------------------------------------------ eval pipeline

  private queueEval(move: SnapshotMove): void {
    if (move.winPct != null) return; // already annotated (resync dedupe)
    void evalLive(move.fenAfter)
      .then((result) => this.onEvalResult(move.ply, result))
      .catch((error) =>
        console.error(`[game ${this.gameId}] eval failed ply ${move.ply}:`, error),
      );
  }

  private onEvalResult(ply: number, result: EngineEval): void {
    const move = this.movesList[ply - 1];
    if (!move) return; // full resync dropped it
    const top = result.lines[0];

    let evalCp: number | null = null;
    let evalMate: number | null = null;
    let winPct: number | null = null;
    if (top) {
      const white = toWhitePov(move.fenAfter, { cp: top.cp, mate: top.mate });
      evalCp = white.cp;
      evalMate = white.mate;
      winPct = winPctFromEval(evalCp, evalMate);
    } else if (result.bestMoveUci == null) {
      // Terminal position: mate/stalemate delivered by this move.
      const pos = new Chess(move.fenAfter);
      if (pos.isCheckmate()) winPct = move.color === "white" ? 100 : 0;
      else winPct = 50;
    }

    const prev = this.movesList[ply - 2];
    const prevWinPct = prev?.winPct ?? 50; // game start ≈ balanced
    let drop: number | null = null;
    let judgment: SnapshotMove["judgment"] = null;
    let cpLoss: number | null = null;
    if (winPct != null) {
      drop = winPctDrop(prevWinPct, winPct, move.color);
      judgment = judgmentFromDrop(drop);
    }
    const prevCp = prev ? prev.evalCp : 20; // startpos ≈ +0.2 for White
    if (prevCp != null && evalCp != null) {
      cpLoss = Math.max(
        0,
        Math.round(move.color === "white" ? prevCp - evalCp : evalCp - prevCp),
      );
    }

    move.evalCp = evalCp;
    move.evalMate = evalMate;
    move.winPct = winPct;
    move.cpLoss = cpLoss;
    move.judgment = judgment;
    move.bestMoveUci = result.bestMoveUci;

    db.update(movesTable)
      .set({
        evalCp,
        evalMate,
        evalDepth: top?.depth ?? null,
        winPct,
        cpLoss,
        judgment,
        bestMoveUci: result.bestMoveUci,
        bestLineUci: top ? top.pvUci.join(" ") : null,
      })
      .where(and(eq(movesTable.gameId, this.gameId), eq(movesTable.ply, ply)))
      .run();

    this.emitEvent({
      type: "eval",
      eval: {
        ply,
        evalCp,
        evalMate,
        winPct,
        cpLoss,
        judgment: judgment ?? null,
        bestMoveUci: result.bestMoveUci,
      },
    });

    // Coach trigger: exactly one call per full move cycle — fires when the
    // eval of the LATEST ply lands and that ply is the AI's reply. Effective
    // behaviour switches on the selected mode (OS-D6/D7).
    const isLatestAiReply =
      !this.terminal && ply === this.movesList.length && !move.isUserMove;
    switch (this.row.coachMode) {
      case "auto":
        if (isLatestAiReply && ply >= 2 && this.movesList[ply - 2]?.isUserMove) {
          void this.triggerAutoCoach(ply, result);
        }
        break;
      case "opening":
        // No ply >= 2 requirement: student-Black gets a comment on
        // Stockfish's very first move (D6 row 4).
        if (isLatestAiReply) void this.triggerOpeningCoach(ply, result);
        break;
      case "off":
        break;
    }
  }

  // --------------------------------------------------------- opening lookups

  // D3: per-manager promise chain so ply p-1 always resolves before p, even
  // when a reconnect backfills several plies at once. lookupPly never throws,
  // but keep the chain unconditionally alive anyway.
  private enqueueOpeningLookup(ply: number): void {
    this.openingChain = this.openingChain
      .then(() => this.lookupPly(ply))
      .catch((error) =>
        console.error(`[game ${this.gameId}] opening chain error:`, error),
      );
  }

  // §5.5 steps 2/7: queue lookups for every ply not yet annotated (in order —
  // the chain preserves D3). The cache makes replays of known lines free.
  private backfillOpeningPlies(): void {
    for (let ply = 0; ply <= this.movesList.length; ply++) {
      if (!this.openingByPly.has(ply)) this.enqueueOpeningLookup(ply);
    }
  }

  // §5.5 step 4: look up the position AFTER `ply`, mark whether the move at
  // `ply` was in the previous position's book, persist, emit.
  private async lookupPly(ply: number): Promise<void> {
    if (this.stopped || this.openingByPly.has(ply)) return;
    if (ply > this.movesList.length) return; // resync shrank the game
    const move = ply > 0 ? this.movesList[ply - 1] : null;
    const fen = move ? move.fenAfter : newGameFromFen(this.initialFen).fen();
    const inBook = move ? isBookMove(this.openingByPly.get(ply - 1), move.uci) : null;
    if (inBook === false) this.leftBookPly ??= ply; // sticky (D6)

    let looked: Awaited<ReturnType<typeof lookupOpening>> | null = null;
    try {
      const rootFen = this.initialFen ?? STARTPOS;
      const play = this.movesList.slice(0, ply).map((m) => m.uci);
      looked = await lookupOpening(rootFen, play);
    } catch (error) {
      // Explorer down/unauthed must never block coaching: fall through to an
      // empty state so the move cycle degrades to Auto (D6).
      console.error(`[game ${this.gameId}] opening lookup failed ply ${ply}:`, error);
    }
    // A resync may have replaced this ply while the lookup was in flight.
    if (move && this.movesList[ply - 1]?.uci !== move.uci) return;

    const opening: OpeningState = {
      ply,
      eco: looked?.eco ?? null,
      name: looked?.name ?? null,
      source: looked?.source ?? null,
      bookMoves: looked?.bookMoves ?? [],
      suggestedUci: looked?.bookMoves[0]?.uci ?? null,
      suggestedSan: looked?.bookMoves[0]?.san ?? null,
      inBookNow: (looked?.bookMoves.length ?? 0) > 0,
      lastMoveInBook: inBook,
      leftBookPly: this.leftBookPly,
      fen,
    };
    this.openingByPly.set(ply, opening);

    const persisted = {
      eco: opening.eco,
      name: opening.name,
      source: opening.source,
      inBook: opening.lastMoveInBook,
      bookMoves: JSON.stringify(opening.bookMoves),
      suggestedUci: opening.suggestedUci,
    };
    db.insert(openingPlies)
      .values({ gameId: this.gameId, ply, ...persisted })
      .onConflictDoUpdate({
        target: [openingPlies.gameId, openingPlies.ply],
        set: persisted,
      })
      .run();
    // D8: keep the games row's opening columns live with the latest NAMED
    // lookup (the post-game export still overwrites them — unchanged).
    if (opening.name) {
      db.update(games)
        .set({ openingEco: opening.eco, openingName: opening.name })
        .where(eq(games.id, this.gameId))
        .run();
    }
    this.emitEvent({ type: "opening", opening });
  }

  private latestOpening(): OpeningState | null {
    let latest: OpeningState | null = null;
    for (const s of this.openingByPly.values()) {
      if (!latest || s.ply > latest.ply) latest = s;
    }
    return latest;
  }

  // ------------------------------------------------------------ coach wiring

  // §5.5 step 6: opening-mode move cycle. Position in book → opening prompt
  // (replaces auto this cycle, D7); out of book → the existing auto path with
  // a one-time "just left theory" note (D6).
  private async triggerOpeningCoach(aiPly: number, currentEval: EngineEval): Promise<void> {
    await this.openingChain; // D3: aiPly's lookup resolved (or failed → empty state)
    if (this.terminal || aiPly !== this.movesList.length) return; // superseded
    const state = this.openingByPly.get(aiPly);

    if (state?.inBookNow) {
      if (this.comments.some((c) => c.ply === aiPly && c.trigger === "opening")) return; // dedupe
      this.coachAbort?.abort(); // supersede any in-flight comment
      const abortController = new AbortController();
      this.coachAbort = abortController;

      const aiMove = this.movesList[aiPly - 1];
      const userMove = aiPly >= 2 ? this.movesList[aiPly - 2] : undefined; // none at ply 1
      const userState = userMove ? this.openingByPly.get(aiPly - 1) : undefined;
      const beforeUserState = userMove ? this.openingByPly.get(aiPly - 2) : undefined;
      // OS-A7: engine lines normalize to White POV exactly like the auto path.
      const engineLines = currentEval.lines.map((line) => {
        const white = toWhitePov(aiMove.fenAfter, { cp: line.cp, mate: line.mate });
        return {
          san: uciLineToSan(aiMove.fenAfter, line.pvUci, 6),
          eval: formatEval(white.cp, white.mate),
        };
      });
      const bookMoves = this.promptBookMoves(state);
      const prompt = buildOpeningPrompt({
        userColor: this.userColor,
        aiLevel: this.row.aiLevel,
        phase: phaseOfFen(aiMove.fenAfter, aiPly),
        movetextSan: this.movetext(),
        fen: aiMove.fenAfter,
        eco: state.eco,
        name: state.name,
        source: state.source ?? "masters",
        studentLastMove: userMove
          ? {
              label: plyLabel(userMove),
              inBook: userState?.lastMoveInBook ?? false,
              bookAlternatives: (beforeUserState?.bookMoves ?? []).map((m) => m.san),
            }
          : null,
        aiLastMove: { label: plyLabel(aiMove), inBook: state.lastMoveInBook ?? false },
        leftBookNow:
          userState?.lastMoveInBook === false && this.leftBookPly === aiPly - 1,
        bookMoves,
        engineLines,
        lastComments: this.comments.slice(-2).map((c) => c.content),
      });
      await this.runCoach({
        ply: aiPly,
        trigger: "opening",
        prompt,
        systemPrompt: OPENING_SYSTEM_PROMPT,
        abortController,
        evalSnapshot: {
          opening: [state.eco, state.name].filter(Boolean).join(" ") || null,
          source: state.source,
          bookMoves: bookMoves.map((m) => m.san),
          engineLines,
        },
      });
      return;
    }

    // Out of book — degrade to Auto, but only where the auto path is valid
    // (triggerAutoCoach derefs movesList[aiPly-2] unguarded — §12 confirmed).
    if (aiPly >= 2 && this.movesList[aiPly - 2]?.isUserMove) {
      let leftBookNote: string | undefined;
      if (!this.leftBookAnnounced && this.leftBookPly != null) {
        this.leftBookAnnounced = true; // one-time (D6)
        const departure = this.movesList[this.leftBookPly - 1];
        const lastBook = this.openingByPly.get(this.leftBookPly - 1);
        const lastBookName = lastBook?.name
          ? `${lastBook.eco ? `${lastBook.eco} ` : ""}${lastBook.name}`
          : null;
        leftBookNote = `The game has just left opening theory after ${plyLabel(departure)}${
          lastBookName ? `; the last book position was ${lastBookName}` : ""
        }. Mention this in one clause.`;
      }
      void this.triggerAutoCoach(aiPly, currentEval, leftBookNote);
    }
  }

  // D6 row 3: student is White at ply 0 — coach the start-position book
  // before any move exists. No engine context yet.
  private async triggerOpeningCoachAtStart(): Promise<void> {
    await this.openingChain;
    if (this.terminal || this.movesList.length !== 0) return;
    const state = this.openingByPly.get(0);
    if (!state?.inBookNow) return;
    if (this.comments.some((c) => c.ply === 0 && c.trigger === "opening")) return; // dedupe
    this.coachAbort?.abort();
    const abortController = new AbortController();
    this.coachAbort = abortController;
    const bookMoves = this.promptBookMoves(state);
    const prompt = buildOpeningPrompt({
      userColor: this.userColor,
      aiLevel: this.row.aiLevel,
      phase: "opening",
      movetextSan: "",
      fen: state.fen,
      eco: state.eco,
      name: state.name,
      source: state.source ?? "masters",
      studentLastMove: null,
      aiLastMove: null,
      leftBookNow: false,
      bookMoves,
      engineLines: [],
      lastComments: [],
    });
    await this.runCoach({
      ply: 0,
      trigger: "opening",
      prompt,
      systemPrompt: OPENING_SYSTEM_PROMPT,
      abortController,
      evalSnapshot: {
        opening: [state.eco, state.name].filter(Boolean).join(" ") || null,
        source: state.source,
        bookMoves: bookMoves.map((m) => m.san),
        engineLines: [],
      },
    });
  }

  // Book list shaped for the opening prompt (D5: student-POV W/D/L; name the
  // line a move leads to only when it differs from the current one).
  private promptBookMoves(state: OpeningState) {
    return state.bookMoves.map((m) => ({
      san: m.san,
      games: m.games,
      wdl: studentWdl(m, this.userColor),
      leadsTo:
        m.leadsTo && m.leadsTo.name !== state.name
          ? `${m.leadsTo.eco} ${m.leadsTo.name}`
          : null,
    }));
  }

  private async triggerAutoCoach(
    aiPly: number,
    currentEval: EngineEval,
    leftBookNote?: string,
  ): Promise<void> {
    if (this.comments.some((c) => c.ply === aiPly && c.trigger === "auto")) return; // dedupe
    this.coachAbort?.abort(); // supersede any in-flight comment
    const abortController = new AbortController();
    this.coachAbort = abortController;

    const aiMove = this.movesList[aiPly - 1];
    const userMove = this.movesList[aiPly - 2];
    const beforeUser = this.movesList[aiPly - 3];

    const topLines = currentEval.lines.map((line) => {
      const white = toWhitePov(aiMove.fenAfter, { cp: line.cp, mate: line.mate });
      return {
        san: uciLineToSan(aiMove.fenAfter, line.pvUci, 6),
        eval: formatEval(white.cp, white.mate),
      };
    });
    const missedBestSan =
      userMove.judgment && userMove.judgment !== "good" && beforeUser?.bestMoveUci
        ? uciLineToSan(beforeUser.fenAfter, [beforeUser.bestMoveUci], 1)
        : null;

    const prompt = buildAutoPrompt({
      userColor: this.userColor,
      aiLevel: this.row.aiLevel,
      phase: phaseOfFen(aiMove.fenAfter, aiPly),
      movetextSan: this.movetext(),
      fen: aiMove.fenAfter,
      userMoveLabel: plyLabel(userMove),
      aiMoveLabel: plyLabel(aiMove),
      evalBeforeUser: beforeUser
        ? formatEval(beforeUser.evalCp ?? null, beforeUser.evalMate ?? null)
        : null,
      evalAfterUser: formatEval(userMove.evalCp ?? null, userMove.evalMate ?? null),
      evalCurrent: formatEval(aiMove.evalCp ?? null, aiMove.evalMate ?? null),
      cpLoss: userMove.cpLoss ?? null,
      judgment: userMove.judgment ?? null,
      missedBestSan,
      topLines,
      lastComments: this.comments.slice(-2).map((c) => c.content),
      leftBookNote,
    });

    await this.runCoach({
      ply: aiPly,
      trigger: "auto",
      prompt,
      abortController,
      evalSnapshot: {
        evalAfterUser: userMove.evalCp ?? userMove.evalMate,
        evalCurrent: aiMove.evalCp ?? aiMove.evalMate,
        cpLoss: userMove.cpLoss,
        judgment: userMove.judgment,
        topLines,
        missedBestSan,
      },
    });
  }

  // On-demand "Ask coach" — works in auto AND off modes (PLAN.md).
  async requestHint(): Promise<CoachEvent> {
    if (this.hintPending) throw new Error("hint already in progress");
    if (this.terminal) throw new Error("game is finished");
    this.hintPending = true;
    try {
      const fen = this.chess.fen();
      const ply = this.movesList.length;
      const currentEval = await evalLive(fen);
      const topLines = currentEval.lines.map((line) => {
        const white = toWhitePov(fen, { cp: line.cp, mate: line.mate });
        return {
          san: uciLineToSan(fen, line.pvUci, 6),
          eval: formatEval(white.cp, white.mate),
        };
      });
      const topWhite = currentEval.lines[0]
        ? toWhitePov(fen, {
            cp: currentEval.lines[0].cp,
            mate: currentEval.lines[0].mate,
          })
        : { cp: null, mate: null };
      const abortController = new AbortController();
      this.coachAbort = abortController;
      const prompt = buildHintPrompt({
        userColor: this.userColor,
        aiLevel: this.row.aiLevel,
        phase: phaseOfFen(fen, ply),
        movetextSan: this.movetext(),
        fen,
        evalCurrent: formatEval(topWhite.cp, topWhite.mate),
        topLines,
        lastComments: this.comments.slice(-2).map((c) => c.content),
      });
      const event = await this.runCoach({
        ply,
        trigger: "user_request",
        prompt,
        abortController,
        evalSnapshot: { evalCurrent: topWhite.cp ?? topWhite.mate, topLines },
      });
      return event;
    } finally {
      this.hintPending = false;
    }
  }

  private async runCoach(args: {
    ply: number;
    trigger: "auto" | "user_request" | "opening";
    prompt: string;
    systemPrompt?: string; // OS-A3: opening cycles pass OPENING_SYSTEM_PROMPT
    abortController: AbortController;
    evalSnapshot: unknown;
  }): Promise<CoachEvent> {
    try {
      const reply = await requestCoachText(args.prompt, {
        abortController: args.abortController,
        systemPrompt: args.systemPrompt,
      });
      if (args.abortController.signal.aborted) {
        return { ply: args.ply, trigger: args.trigger, content: null, error: "superseded", createdAt: Date.now() };
      }
      const createdAt = Date.now();
      db.insert(coachComments)
        .values({
          gameId: this.gameId,
          ply: args.ply,
          trigger: args.trigger,
          content: reply.content,
          evalSnapshot: JSON.stringify(args.evalSnapshot),
          model: reply.model,
          latencyMs: reply.latencyMs,
        })
        .run();
      const view: CoachCommentView = {
        ply: args.ply,
        trigger: args.trigger,
        content: reply.content,
        createdAt,
      };
      this.comments.push(view);
      const event: CoachEvent = { ...view };
      this.emitEvent({ type: "coach", coach: event });
      return event;
    } catch (error) {
      if (args.abortController.signal.aborted) {
        return { ply: args.ply, trigger: args.trigger, content: null, error: "superseded", createdAt: Date.now() };
      }
      const message =
        error instanceof CoachUnavailableError
          ? `coach unavailable: ${error.message}`
          : `coach error: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[game ${this.gameId}] ${message}`);
      const event: CoachEvent = {
        ply: args.ply,
        trigger: args.trigger,
        content: null,
        error: message,
        createdAt: Date.now(),
      };
      this.emitEvent({ type: "coach", coach: event });
      if (args.trigger === "user_request") throw error;
      return event;
    }
  }

  private movetext(): string {
    const parts: string[] = [];
    for (const m of this.movesList) {
      if (m.color === "white") parts.push(`${Math.ceil(m.ply / 2)}. ${m.san}`);
      else parts.push(m.san);
    }
    return parts.join(" ");
  }

  // ------------------------------------------------------------------ finish

  private finish(): void {
    const result = deriveResult(this.status, this.winner);
    this.coachAbort?.abort(); // cancel in-flight coach; evals may still store
    db.update(games)
      .set({
        status: this.status,
        winner: this.winner,
        result,
        movesUci: this.movesList.map((m) => m.uci).join(" "),
        pgn: this.movesList.length > 0 ? this.chess.pgn() : null, // provisional; M4 export replaces
        finishedAt: new Date(),
      })
      .where(eq(games.id, this.gameId))
      .run();
    console.log(
      `[game ${this.gameId}] finished: status=${this.status} winner=${this.winner ?? "-"} result=${result ?? "-"}`,
    );
    this.emitEvent({ type: "finish", snapshot: this.getSnapshot() });
    this.abortStream?.();
    // M4: kick the review (idempotent — the gameFinish event also triggers it).
    void import("@/lib/review/pipeline").then(({ triggerReview }) =>
      triggerReview(this.gameId),
    );
  }

  private emitEvent(payload: GameEventPayload): void {
    this.emit("event", payload);
  }
}

// ------------------------------------------------------------------ registry

const g = globalThis as unknown as {
  __gameManagers?: Map<string, GameManager>;
  __gameManagersSigterm?: boolean;
};
const registry = (g.__gameManagers ??= new Map<string, GameManager>());

if (!g.__gameManagersSigterm) {
  g.__gameManagersSigterm = true;
  process.once("SIGTERM", () => {
    for (const manager of registry.values()) manager.stop();
  });
}

// Returns a live manager for an ACTIVE app-created game, or null when the game
// is unknown (A4: never manage games we didn't create) or already terminal
// (serve those from the DB via buildDbSnapshot).
export function ensureGameManager(gameId: string): GameManager | null {
  const existing = registry.get(gameId);
  if (existing) return existing;
  const row = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!row) return null;
  if (isTerminalStatus(row.status)) return null;
  const manager = new GameManager(row);
  registry.set(gameId, manager);
  manager.start();
  return manager;
}

export function getGameManager(gameId: string): GameManager | undefined {
  return registry.get(gameId);
}

export function hasGameRow(gameId: string): boolean {
  return (
    db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get() != null
  );
}

// Snapshot straight from the DB — used for finished games (no live manager).
export function buildDbSnapshot(gameId: string): GameSnapshot | null {
  const row = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!row) return null;
  const moveRows = db
    .select()
    .from(movesTable)
    .where(eq(movesTable.gameId, gameId))
    .orderBy(movesTable.ply)
    .all();
  const startTurn: "white" | "black" =
    row.initialFen && row.initialFen.split(" ")[1] === "b" ? "black" : "white";
  const movesList: SnapshotMove[] = moveRows.map((m) => ({
    ply: m.ply,
    color:
      (m.ply % 2 === 1) === (startTurn === "white") ? "white" : "black",
    san: m.san,
    uci: m.uci,
    fenAfter: m.fenAfter,
    clockMs: m.clockMs,
    isUserMove: m.isUserMove,
    evalCp: m.evalCp,
    evalMate: m.evalMate,
    winPct: m.winPct,
    cpLoss: m.cpLoss,
    judgment: m.judgment,
    bestMoveUci: m.bestMoveUci,
  }));
  const commentRows = db
    .select()
    .from(coachComments)
    .where(eq(coachComments.gameId, gameId))
    .orderBy(coachComments.createdAt)
    .all();
  const lastFen =
    movesList[movesList.length - 1]?.fenAfter ?? newGameFromFen(row.initialFen).fen();
  // OS-A6: every state frame wholesale-replaces the client snapshot, so this
  // hand-maintained builder must carry `opening` too (highest annotated ply).
  const openingRows = db
    .select()
    .from(openingPlies)
    .where(eq(openingPlies.gameId, gameId))
    .orderBy(openingPlies.ply)
    .all();
  let opening: OpeningState | null = null;
  const last = openingRows[openingRows.length - 1];
  if (last) {
    const bookMoves = parseBookMoves(last.bookMoves);
    opening = {
      ply: last.ply,
      eco: last.eco,
      name: last.name,
      source: last.source,
      bookMoves,
      suggestedUci: last.suggestedUci,
      suggestedSan: bookMoves[0]?.san ?? null,
      inBookNow: bookMoves.length > 0,
      lastMoveInBook: last.inBook,
      leftBookPly:
        openingRows.find((r) => r.ply > 0 && r.inBook === false)?.ply ?? null,
      fen:
        last.ply === 0
          ? newGameFromFen(row.initialFen).fen()
          : (movesList[last.ply - 1]?.fenAfter ?? lastFen),
    };
  }
  return {
    game: {
      id: row.id,
      userColor: row.userColor,
      aiLevel: row.aiLevel,
      status: row.status,
      winner: row.winner,
      result: row.result ?? deriveResult(row.status, row.winner),
      coachMode: row.coachMode,
      clockInitial: row.clockInitial,
      clockIncrement: row.clockIncrement,
      speed: row.speed,
    },
    moves: movesList,
    comments: commentRows.map((c) => ({
      ply: c.ply,
      trigger: c.trigger,
      content: c.content,
      createdAt: c.createdAt.getTime(),
    })),
    opening,
    fen: lastFen,
    turn:
      (movesList.length % 2 === 0) === (startTurn === "white") ? "white" : "black",
    wtime: null,
    btime: null,
    clockAt: Date.now(),
    finished: isTerminalStatus(row.status),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBookMoves(json: string): BookMove[] {
  try {
    return JSON.parse(json) as BookMove[];
  } catch {
    return [];
  }
}
