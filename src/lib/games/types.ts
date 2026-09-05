// Client-safe types shared between the GameManager (server), SSE route, and
// React hooks. No server imports allowed here.

export type Judgment = "blunder" | "mistake" | "inaccuracy" | "good";

export interface SnapshotMove {
  ply: number; // 1-based
  color: "white" | "black";
  san: string;
  uci: string;
  fenAfter: string;
  clockMs: number | null;
  isUserMove: boolean;
  // Engine annotation (arrives ~1s after the move via the `eval` event)
  evalCp?: number | null; // White POV, after this move
  evalMate?: number | null; // White POV
  winPct?: number | null; // White POV
  cpLoss?: number | null; // mover POV
  judgment?: Judgment | null;
  bestMoveUci?: string | null; // best move in the position AFTER this ply
}

export interface CoachCommentView {
  ply: number;
  trigger: "auto" | "user_request";
  content: string;
  createdAt: number; // epoch ms
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
  comments: CoachCommentView[];
  fen: string;
  turn: "white" | "black";
  wtime: number | null; // ms, as of clockAt
  btime: number | null;
  clockAt: number; // epoch ms when wtime/btime were received
  finished: boolean;
}

export interface EvalEvent {
  ply: number;
  evalCp: number | null;
  evalMate: number | null;
  winPct: number | null;
  cpLoss: number | null;
  judgment: Judgment | null;
  bestMoveUci: string | null;
}

export interface CoachEvent {
  ply: number;
  trigger: "auto" | "user_request";
  content: string | null; // null = coach unavailable (see error)
  error?: string;
  createdAt: number;
}

export type GameEventPayload =
  | { type: "state"; snapshot: GameSnapshot }
  | { type: "finish"; snapshot: GameSnapshot }
  | { type: "eval"; eval: EvalEvent }
  | { type: "coach"; coach: CoachEvent };

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

// "after 3...Nf6" style label for a ply.
export function plyLabel(move: SnapshotMove | undefined): string {
  if (!move) return "";
  const num = Math.ceil(move.ply / 2);
  return `${num}${move.color === "white" ? "." : "…"}${move.san}`;
}
