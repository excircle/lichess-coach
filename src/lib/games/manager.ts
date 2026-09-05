import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import type { Chess } from "chess.js";
import { applyUci, newGameFromFen, phaseOfFen } from "@/lib/chess";
import { db } from "@/lib/db";
import { games, moves as movesTable } from "@/lib/db/schema";
import { getStoredCredentials } from "@/lib/lichess/client";
import { streamNdjson } from "@/lib/lichess/ndjson";
import {
  type BoardGameFull,
  type BoardGameState,
  type BoardLine,
  type GameEventPayload,
  type GameSnapshot,
  type SnapshotMove,
  deriveResult,
  isTerminalStatus,
} from "./types";

type GameRow = typeof games.$inferSelect;

// ---------------------------------------------------------------------------
// GameManager — the architectural heart (PLAN.md): consumes one board stream,
// holds canonical state, persists to SQLite, emits events for SSE.
// Lifecycle per amendment A2: a clean close is the NORMAL end-of-game signal
// once a terminal status was seen; reconnect only while status is
// created/started. M3 will hook evals + coach into onPlyApplied/onFinished.
// ---------------------------------------------------------------------------

export class GameManager extends EventEmitter {
  readonly gameId: string;
  readonly userColor: "white" | "black";
  private chess: Chess;
  private movesList: SnapshotMove[] = [];
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
  private row: GameRow;

  constructor(row: GameRow) {
    super();
    this.setMaxListeners(50);
    this.row = row;
    this.gameId = row.id;
    this.userColor = row.userColor;
    this.status = row.status;
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
  }

  get terminal(): boolean {
    return isTerminalStatus(this.status);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.terminal) void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abortStream?.();
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
        clockInitial: full.clock?.initial != null ? Math.round(full.clock.initial / 1000) : this.row.clockInitial,
        clockIncrement: full.clock?.increment != null ? Math.round(full.clock.increment / 1000) : this.row.clockIncrement,
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

  // Applies the full-move-string delta. state === null during rehydrate (no clocks).
  private applyMovesString(movesStr: string, state: BoardGameState | null): void {
    const tokens = movesStr.trim() ? movesStr.trim().split(/\s+/) : [];
    if (tokens.length < this.movesList.length) {
      // Server knows fewer moves than us — resync from scratch (shouldn't
      // happen vs AI, but gameFull replays after reconnect must win).
      console.warn(`[game ${this.gameId}] server moves < local — full resync`);
      this.resetReplayState();
      db.delete(movesTable).where(eq(movesTable.gameId, this.gameId)).run();
    }
    const newTokens = tokens.slice(this.movesList.length);
    const singleNewPly = newTokens.length === 1;
    for (const uci of newTokens) {
      const color = this.chess.turn() === "w" ? "white" : "black";
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
      // M3 hook: onPlyApplied(snapshotMove) → eval queue → coach trigger.
    }
  }

  private resetReplayState(): void {
    this.chess = newGameFromFen(this.initialFen);
    this.movesList = [];
  }

  private finish(): void {
    const result = deriveResult(this.status, this.winner);
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
  return db.select({ id: games.id }).from(games).where(eq(games.id, gameId)).get() != null;
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
  const movesList: SnapshotMove[] = moveRows.map((m) => ({
    ply: m.ply,
    san: m.san,
    uci: m.uci,
    fenAfter: m.fenAfter,
    clockMs: m.clockMs,
    isUserMove: m.isUserMove,
  }));
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
    fen: lastFen,
    turn: movesList.length % 2 === 0 ? "white" : "black",
    wtime: null,
    btime: null,
    clockAt: Date.now(),
    finished: isTerminalStatus(row.status),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
