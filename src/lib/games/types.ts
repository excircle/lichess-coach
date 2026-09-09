// Client-safe types shared between the GameManager (server), SSE route, and
// React hooks. No server imports allowed here.

export type Judgment = "blunder" | "mistake" | "inaccuracy" | "good";

// PLAN OS-D1: the user's *selection*; the manager derives effective behaviour
// per ply (OS-D6).
export type CoachMode = "auto" | "opening" | "off";

// PLAN OS-D2: which explorer database produced a book-move list.
export type BookSource = "masters" | "lichess";

// One explorer book move (PLAN §4), ranked by game count.
export interface BookMove {
  uci: string;
  san: string;
  games: number;
  white: number;
  draws: number;
  black: number;
  avgRating: number;
  leadsTo: { eco: string; name: string } | null; // explorer moves[].opening
}

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

// D5: W/D/L percentages from the student's colour. Lives here (not
// openings/book.ts) because OpeningCard renders the bars client-side and this
// module is the client-safe one; book.ts re-exports it for the server path.
export function studentWdl(
  m: BookMove,
  color: "white" | "black",
): { win: number; draw: number; loss: number } {
  if (m.games === 0) return { win: 0, draw: 0, loss: 0 };
  const win = color === "white" ? m.white : m.black;
  const loss = color === "white" ? m.black : m.white;
  return {
    win: Math.round((win / m.games) * 100),
    draw: Math.round((m.draws / m.games) * 100),
    loss: Math.round((loss / m.games) * 100),
  };
}

// PLAN OS §4: opening annotation for the position AFTER `ply` (0 = start).
// Emitted per ply as an `opening` SSE event and carried on the snapshot.
export interface OpeningState {
  ply: number; // position after this ply (0 = start)
  eco: string | null;
  name: string | null;
  source: BookSource | null; // null when the lookup failed (D6 fallback)
  bookMoves: BookMove[]; // top 5, ranked by games desc
  suggestedUci: string | null; // bookMoves[0]?.uci
  suggestedSan: string | null;
  inBookNow: boolean; // bookMoves.length > 0
  lastMoveInBook: boolean | null; // was the move AT this ply in book (null at ply 0)
  leftBookPly: number | null; // sticky, first non-book ply in the game
  fen: string; // fenAfter of this ply (for the thumbnail)
}

export interface CoachCommentView {
  ply: number;
  trigger: "auto" | "user_request" | "opening";
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
    coachMode: CoachMode;
    clockInitial: number | null; // seconds
    clockIncrement: number | null; // seconds
    speed: string | null;
  };
  moves: SnapshotMove[];
  comments: CoachCommentView[];
  opening: OpeningState | null; // latest annotated ply (OS-D8)
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
  trigger: "auto" | "user_request" | "opening";
  content: string | null; // null = coach unavailable (see error)
  error?: string;
  createdAt: number;
}

export type GameEventPayload =
  | { type: "state"; snapshot: GameSnapshot }
  | { type: "finish"; snapshot: GameSnapshot }
  | { type: "eval"; eval: EvalEvent }
  | { type: "coach"; coach: CoachEvent }
  | { type: "opening"; opening: OpeningState };

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
