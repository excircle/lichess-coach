"use client";

import { useEffect, useRef } from "react";
import type { SnapshotMove } from "@/lib/games/types";

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
                <td className="w-16 font-medium">{row.white?.san ?? "…"}</td>
                <td className="w-16 font-medium">{row.black?.san ?? ""}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
