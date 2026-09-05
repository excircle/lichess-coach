"use client";

import { formatEval } from "@/lib/chess";
import type { GameSnapshot } from "@/lib/games/types";

// Vertical eval bar (lichess-style): the user's color grows from the bottom.
export default function EvalBar({ snapshot }: { snapshot: GameSnapshot }) {
  const lastEval = [...snapshot.moves].reverse().find((m) => m.winPct != null);
  const whiteWinPct = lastEval?.winPct ?? 50;
  const text = lastEval
    ? formatEval(lastEval.evalCp ?? null, lastEval.evalMate ?? null)
    : "—";
  const whiteAtBottom = snapshot.game.userColor === "white";
  const topPct = whiteAtBottom ? 100 - whiteWinPct : whiteWinPct;

  return (
    <div className="flex flex-col items-center gap-1 self-stretch">
      <span className="font-mono text-xs text-neutral-500">{text}</span>
      <div className="flex w-3 flex-1 flex-col overflow-hidden rounded border border-neutral-300 dark:border-neutral-600">
        <div
          className={`w-full transition-[height] duration-500 ${whiteAtBottom ? "bg-neutral-800" : "bg-white"}`}
          style={{ height: `${topPct}%` }}
        />
        <div
          className={`w-full flex-1 transition-[height] duration-500 ${whiteAtBottom ? "bg-white" : "bg-neutral-800"}`}
        />
      </div>
    </div>
  );
}
