import type { BookMove, BookSource } from "@/lib/games/types";
import { fetchExplorer, type ExplorerResult } from "./explorer";

// ---------------------------------------------------------------------------
// Book logic (PLAN OS §5.3, decisions D2/D3/D5). Pure — no DB or manager
// imports; the network/cache lives behind fetchExplorer. All thresholds are
// tuning constants, expected to move after the first few games (D2).
// ---------------------------------------------------------------------------

// D2: below this many total master games, fall back to the Lichess DB.
export const MASTERS_MIN_GAMES = 20;
// D2: a move is "book" when its game count reaches the source's threshold.
export const BOOK_MIN_GAMES: Record<BookSource, number> = { masters: 3, lichess: 50 };
// D5: how many suggestions the card and prompt carry.
export const BOOK_TOP_N = 5;

export interface OpeningLookup {
  source: BookSource;
  eco: string | null;
  name: string | null;
  bookMoves: BookMove[];
}

// masters → (thin? → lichess) → filter by BOOK_MIN_GAMES → sort → top 5.
export async function lookupOpening(
  rootFen: string,
  playUci: string[],
): Promise<OpeningLookup> {
  let source: BookSource = "masters";
  let result = await fetchExplorer("masters", rootFen, playUci);
  if (totalGames(result) < MASTERS_MIN_GAMES) {
    source = "lichess";
    result = await fetchExplorer("lichess", rootFen, playUci);
  }
  const bookMoves = result.moves
    .map(toBookMove)
    .filter((m) => m.games >= BOOK_MIN_GAMES[source])
    .sort((a, b) => b.games - a.games)
    .slice(0, BOOK_TOP_N);
  return {
    source,
    eco: result.opening?.eco ?? null,
    name: result.opening?.name ?? null,
    bookMoves,
  };
}

// D3: a move is inBook iff its UCI appears in the PREVIOUS position's book
// list. undefined prev (lookup missing/failed) counts as out of book.
export function isBookMove(
  prev: { bookMoves: BookMove[] } | undefined,
  uci: string,
): boolean {
  return prev?.bookMoves.some((m) => m.uci === uci) ?? false;
}

// D5: student-POV W/D/L — implementation lives in the client-safe types
// module (OpeningCard draws the bars); re-exported here per PLAN §5.3.
export { studentWdl } from "@/lib/games/types";

function totalGames(r: ExplorerResult): number {
  return r.white + r.draws + r.black;
}

function toBookMove(m: ExplorerResult["moves"][number]): BookMove {
  return {
    uci: m.uci,
    san: m.san,
    games: m.white + m.draws + m.black,
    white: m.white,
    draws: m.draws,
    black: m.black,
    avgRating: m.averageRating,
    leadsTo: m.opening ?? null,
  };
}
