import { Chess, type Square } from "chess.js";

export type Judgment = "blunder" | "mistake" | "inaccuracy" | "good";
export type Phase = "opening" | "middlegame" | "endgame";

// ---------------------------------------------------------------------------
// Lichess win%/accuracy model (https://lichess.org/page/accuracy).
// Conventions (PLAN.md amendments): engine cp is normalized to WHITE POV before
// storage; win% below is White POV; judgment/accuracy operate on the MOVER-POV
// win% drop.
// ---------------------------------------------------------------------------

export function winPctFromCp(cpWhitePov: number): number {
  const cp = Math.max(-1000, Math.min(1000, cpWhitePov));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

// mate: White POV — positive means White delivers mate.
export function winPctFromEval(
  cp: number | null | undefined,
  mate: number | null | undefined,
): number {
  if (mate != null) return mate > 0 ? 100 : 0;
  if (cp == null) return 50;
  return winPctFromCp(cp);
}

// Drop in the mover's win% caused by their move (>= 0; gains clamp to 0).
export function winPctDrop(
  whiteWinPctBefore: number,
  whiteWinPctAfter: number,
  moverColor: "white" | "black",
): number {
  const before = moverColor === "white" ? whiteWinPctBefore : 100 - whiteWinPctBefore;
  const after = moverColor === "white" ? whiteWinPctAfter : 100 - whiteWinPctAfter;
  return Math.max(0, before - after);
}

// Lichess thresholds: >=30 blunder, >=20 mistake, >=10 inaccuracy.
export function judgmentFromDrop(drop: number): Judgment {
  if (drop >= 30) return "blunder";
  if (drop >= 20) return "mistake";
  if (drop >= 10) return "inaccuracy";
  return "good";
}

// Lichess move accuracy: 103.1668·e^(−0.04354·Δ) − 3.1668, clamped to [0,100].
export function accuracyFromDrop(drop: number): number {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1668;
  return Math.max(0, Math.min(100, a));
}

// Simple phase heuristic: endgame once few non-pawn pieces remain, opening for
// the first moves, middlegame otherwise.
export function phaseOfFen(fen: string, ply: number): Phase {
  const board = fen.split(" ")[0];
  const majorsAndMinors = (board.match(/[nbrqNBRQ]/g) ?? []).length;
  if (majorsAndMinors <= 6) return "endgame";
  if (ply <= 16) return "opening";
  return "middlegame";
}

// ---------------------------------------------------------------------------
// UCI replay helpers for the Board API's `moves` string ("e2e4 e7e5 ...").
// ---------------------------------------------------------------------------

export interface ReplayedMove {
  ply: number; // 1-based
  uci: string;
  san: string;
  fenAfter: string;
  color: "white" | "black";
}

export function newGameFromFen(initialFen?: string | null): Chess {
  return initialFen && initialFen !== "startpos" ? new Chess(initialFen) : new Chess();
}

export function replayUci(movesUci: string, initialFen?: string | null): ReplayedMove[] {
  const chess = newGameFromFen(initialFen);
  const out: ReplayedMove[] = [];
  const tokens = movesUci.trim() ? movesUci.trim().split(/\s+/) : [];
  for (const [i, uci] of tokens.entries()) {
    const color = chess.turn() === "w" ? "white" : "black";
    const move = applyUci(chess, uci);
    out.push({ ply: i + 1, uci, san: move.san, fenAfter: chess.fen(), color });
  }
  return out;
}

// Applies one UCI move. Handles promotions and the Board API's potential
// king-to-rook castling notation ("Chess960-compatible", e.g. e1h1): if the
// plain from/to move is illegal but describes king-onto-own-rook, retry as a
// standard castle.
export function applyUci(chess: Chess, uci: string) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
  try {
    return chess.move({ from, to, promotion });
  } catch (error) {
    const castleSan = castleSanIfKingToRook(chess, from, to);
    if (castleSan) return chess.move(castleSan);
    throw error;
  }
}

// Converts a UCI pv into SAN from a starting FEN (for coach prompts).
// Stops silently at the first inapplicable move.
export function uciLineToSan(fen: string, uciMoves: string[], maxPlies = 6): string {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of uciMoves.slice(0, maxPlies)) {
    try {
      sans.push(applyUci(chess, uci).san);
    } catch {
      break;
    }
  }
  return sans.join(" ");
}

// Normalizes a UCI side-to-move score to White POV, given the analyzed FEN.
export function toWhitePov(
  fen: string,
  score: { cp: number | null; mate: number | null },
): { cp: number | null; mate: number | null } {
  const blackToMove = fen.split(" ")[1] === "b";
  if (!blackToMove) return score;
  return {
    cp: score.cp == null ? null : -score.cp,
    mate: score.mate == null ? null : -score.mate,
  };
}

// "+0.41", "-2.10", "#3", "#-2" — White POV display convention.
export function formatEval(cp: number | null, mate: number | null): string {
  if (mate != null) return mate > 0 ? `#${mate}` : `#-${Math.abs(mate)}`;
  if (cp == null) return "?";
  const pawns = cp / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

// Exported for the Board UI too: dragging/clicking the king onto its own rook
// is a castle gesture (lichess-style) in addition to the two-square king move.
export function castleSanIfKingToRook(chess: Chess, from: string, to: string): string | null {
  const piece = chess.get(from as Square);
  const target = chess.get(to as Square);
  if (
    piece &&
    target &&
    piece.type === "k" &&
    target.type === "r" &&
    piece.color === target.color
  ) {
    return to.charCodeAt(0) > from.charCodeAt(0) ? "O-O" : "O-O-O";
  }
  return null;
}
