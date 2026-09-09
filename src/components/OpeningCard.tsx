"use client";

import { useState } from "react";
import {
  plyLabel,
  studentWdl,
  type GameSnapshot,
  type OpeningState,
} from "@/lib/games/types";
import MiniBoard from "./MiniBoard";

// Opening study card (PLAN OS §6.5): current book position, thumbnail with
// the suggestion arrow, ranked book moves with student-POV W/D/L bars.
// Stacks the thumbnail over the list below sm: (OS-A6 — 280px column).
export default function OpeningCard({ snapshot }: { snapshot: GameSnapshot }) {
  const [highlightedUci, setHighlightedUci] = useState<string | null>(null);
  const { moves, game } = snapshot;
  const opening = snapshot.opening;

  if (!opening) {
    return (
      <div className="rounded-xl border border-neutral-200 p-4 text-sm text-neutral-400 dark:border-neutral-800">
        Opening study: looking up the book…
      </div>
    );
  }

  const openingLabel =
    [opening.eco, opening.name].filter(Boolean).join(" · ") || "Opening";

  // Out of book → collapsed one-liner; a transposition back re-expands it.
  if (!opening.inBookNow) {
    const departure =
      opening.leftBookPly != null ? moves[opening.leftBookPly - 1] : undefined;
    return (
      <div className="rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-500 dark:border-neutral-800">
        {departure ? `Out of book since ${plyLabel(departure)}` : "Out of book"}
        {opening.name ? ` · last known: ${openingLabel}` : ""}
      </div>
    );
  }

  // The latest ply is still being looked up → previous card, dimmed (§6.5).
  const pending = opening.ply < moves.length;
  const arrow = highlightedUci ?? opening.suggestedUci;
  const myTurn = snapshot.turn === game.userColor && !snapshot.finished;

  // ✓/✕ for a recent ply, only where it is certain (see plyBookStatus).
  const lastEntries = [opening.ply - 1, opening.ply]
    .filter((q) => q >= 1)
    .map((q) => ({ move: moves[q - 1], inBook: plyBookStatus(q, opening) }))
    .filter((e) => e.move && e.inBook != null);

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 ${
        pending ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{openingLabel}</h3>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          {pending ? "looking up…" : opening.source}
        </span>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <MiniBoard fen={opening.fen} orientation={game.userColor} arrow={arrow} />

        <div className="min-w-0 flex-1 text-sm">
          <p className="mb-1 text-neutral-500">
            {myTurn ? "Your move — book suggests " : "Book suggests "}
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">
              {opening.suggestedSan ?? "—"}
            </span>
          </p>
          <ul>
            {opening.bookMoves.map((m) => {
              const wdl = studentWdl(m, game.userColor);
              const active = (highlightedUci ?? opening.suggestedUci) === m.uci;
              const leads =
                m.leadsTo && m.leadsTo.name !== opening.name ? m.leadsTo.name : null;
              return (
                <li key={m.uci}>
                  <button
                    className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${
                      active ? "bg-neutral-100 dark:bg-neutral-900" : ""
                    }`}
                    onMouseEnter={() => setHighlightedUci(m.uci)}
                    onMouseLeave={() => setHighlightedUci(null)}
                    onClick={() => setHighlightedUci(m.uci)}
                    title={leads ? `Leads to ${leads}` : undefined}
                  >
                    <span className="w-10 shrink-0 font-medium">{m.san}</span>
                    <span className="w-20 shrink-0 text-right text-xs text-neutral-500">
                      {m.games.toLocaleString()} games
                    </span>
                    <span
                      className="flex h-2 flex-1 overflow-hidden rounded-sm"
                      aria-label={`win ${wdl.win}%, draw ${wdl.draw}%, loss ${wdl.loss}%`}
                    >
                      <span className="bg-emerald-500" style={{ width: `${wdl.win}%` }} />
                      <span className="bg-neutral-300 dark:bg-neutral-600" style={{ width: `${wdl.draw}%` }} />
                      <span className="bg-red-400" style={{ width: `${wdl.loss}%` }} />
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
                      {wdl.win}·{wdl.draw}·{wdl.loss}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {lastEntries.length > 0 && (
            <p className="mt-2 text-xs text-neutral-400">
              Last:{" "}
              {lastEntries
                .map(
                  (e) =>
                    `${plyLabel(e.move)} ${e.inBook ? "✓ in book" : "✕ not in book"}`,
                )
                .join(" · ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// Whether the move at ply q was in book, from the data the snapshot carries:
// the latest state knows its own ply; every ply before the sticky departure
// was in book by definition; the departure ply was not. Later plies (possible
// transpositions) are unknown → null, and the caller omits them.
function plyBookStatus(q: number, opening: OpeningState): boolean | null {
  if (q === opening.ply) return opening.lastMoveInBook;
  if (opening.leftBookPly == null || q < opening.leftBookPly) return true;
  if (q === opening.leftBookPly) return false;
  return null;
}
