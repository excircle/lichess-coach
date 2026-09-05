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
} from "@/lib/coach/prompts";
import { CoachUnavailableError, requestCoachText } from "@/lib/coach/service";
import { db } from "@/lib/db";
import { coachComments, games, moves as movesTable } from "@/lib/db/schema";
import { getStoredCredentials } from "@/lib/lichess/client";
import { streamNdjson } from "@/lib/lichess/ndjson";
import { evalLive } from "@/lib/stockfish/service";
import type { EngineEval } from "@/lib/stockfish/engine";
import {
  type BoardGameFull,
  type BoardGameState,
  type BoardLine,
  type CoachCommentView,
  type CoachEvent,
  type GameEventPayload,
  type GameSnapshot,
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
  }

  get terminal(): boolean {
    return isTerminalStatus(this.status);
  }

  get coachMode(): "auto" | "off" {
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

  setCoachMode(mode: "auto" | "off"): void {
    if (mode === this.row.coachMode) return;
    db.update(games).set({ coachMode: mode }).where(eq(games.id, this.gameId)).run();
    this.row = { ...this.row, coachMode: mode };
    if (mode === "off") this.coachAbort?.abort();
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

    // Auto-coach: exactly one call per full move cycle — fires when the eval
    // of the LATEST ply lands, that ply is the AI's reply, and the ply before
    // it was the user's move.
    if (
      !this.terminal &&
      this.row.coachMode === "auto" &&
      ply === this.movesList.length &&
      !move.isUserMove &&
      ply >= 2 &&
      this.movesList[ply - 2]?.isUserMove
    ) {
      void this.triggerAutoCoach(ply, result);
    }
  }

  // ------------------------------------------------------------ coach wiring

  private async triggerAutoCoach(aiPly: number, currentEval: EngineEval): Promise<void> {
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
    trigger: "auto" | "user_request";
    prompt: string;
    abortController: AbortController;
    evalSnapshot: unknown;
  }): Promise<CoachEvent> {
    try {
      const reply = await requestCoachText(args.prompt, {
        abortController: args.abortController,
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
    // M4 hook: trigger review pipeline here (also from gameFinish event — idempotent).
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
