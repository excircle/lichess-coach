"use client";

import { useEffect, useRef } from "react";
import type { SnapshotMove } from "@/lib/games/types";

const GLYPHS: Record<string, { text: string; className: string }> = {
  blunder: { text: "??", className: "text-red-600" },
  mistake: { text: "?", className: "text-orange-500" },
  inaccuracy: { text: "?!", className: "text-yellow-600" },
};

function MoveCell({ move }: { move?: SnapshotMove }) {
  if (!move) return null;
  const glyph = move.judgment ? GLYPHS[move.judgment] : undefined;
  return (
    <>
      {move.san}
      {glyph && <span className={glyph.className}>{glyph.text}</span>}
    </>
  );
}

export default function MoveList({ moves }: { moves: SnapshotMove[] }) {
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [moves.length]);

  const rows: { num: number; white?: SnapshotMove; black?: SnapshotMove }[] = [];
  for (const move of moves) {
    const num = Math.ceil(move.ply / 2);
    if (move.ply % 2 === 1) rows.push({ num, white: move });
    else {
      const row = rows[rows.length - 1];
      if (row && row.num === num) row.black = move;
      else rows.push({ num, black: move });
    }
  }

  return (
    <div
      ref={scroller}
      className="h-48 overflow-y-auto rounded-lg border border-neutral-200 p-2 text-sm dark:border-neutral-800"
    >
      {rows.length === 0 ? (
        <p className="p-2 text-neutral-400">No moves yet.</p>
      ) : (
        <table className="w-full">
          <tbody>
            {rows.map((row) => (
              <tr key={row.num} className="leading-6">
                <td className="w-8 pr-2 text-right text-neutral-400">{row.num}.</td>
                <td className="w-20 font-medium">
                  <MoveCell move={row.white} />
                </td>
                <td className="w-20 font-medium">
                  <MoveCell move={row.black} />
                </td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
