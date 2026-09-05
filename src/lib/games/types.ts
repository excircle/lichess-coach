// Client-safe types shared between the GameManager (server), SSE route, and
// React hooks. No server imports allowed here.

export interface SnapshotMove {
  ply: number; // 1-based
  san: string;
  uci: string;
  fenAfter: string;
  clockMs: number | null;
  isUserMove: boolean;
}

export interface GameSnapshot {
  game: {
    id: string;
    userColor: "white" | "black";
    aiLevel: number | null;
    status: string;
    winner: string | null;
    result: string | null;
    coachMode: "auto" | "off";
    clockInitial: number | null; // seconds
    clockIncrement: number | null; // seconds
    speed: string | null;
  };
  moves: SnapshotMove[];
  fen: string;
  turn: "white" | "black";
  wtime: number | null; // ms, as of clockAt
  btime: number | null;
  clockAt: number; // epoch ms when wtime/btime were received
  finished: boolean;
}

export type GameEventPayload =
  | { type: "state"; snapshot: GameSnapshot }
  | { type: "finish"; snapshot: GameSnapshot };

// Lichess board-stream line shapes (subset we consume).
export interface BoardGameState {
  type?: "gameState";
  moves: string;
  status: string;
  winner?: "white" | "black";
  wtime?: number;
  btime?: number;
  winc?: number;
  binc?: number;
}

export interface BoardGameFull {
  type: "gameFull";
  id: string;
  initialFen?: string;
  speed?: string;
  clock?: { initial?: number; increment?: number } | null;
  white?: { id?: string; aiLevel?: number };
  black?: { id?: string; aiLevel?: number };
  state: BoardGameState;
}

export type BoardLine =
  | BoardGameFull
  | (BoardGameState & { type: "gameState" })
  | { type: string; [key: string]: unknown };

export const TERMINAL_STATUSES = new Set([
  "aborted",
  "mate",
  "resign",
  "stalemate",
  "timeout",
  "draw",
  "outoftime",
  "cheat",
  "noStart",
  "unknownFinish",
  "insufficientMaterialClaim",
  "variantEnd",
]);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

export function deriveResult(
  status: string,
  winner: string | null | undefined,
): string | null {
  if (winner === "white") return "1-0";
  if (winner === "black") return "0-1";
  if (["stalemate", "draw", "insufficientMaterialClaim"].includes(status)) {
    return "1/2-1/2";
  }
  if (["aborted", "noStart"].includes(status)) return "aborted";
  if (isTerminalStatus(status)) return "1/2-1/2"; // terminal, no winner (e.g. timeout w/ insufficient material)
  return null;
}
