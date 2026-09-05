"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCreateGame } from "@/hooks/useCreateGame";

const TIME_CONTROLS: {
  label: string;
  limit: number | null;
  increment: number | null;
}[] = [
  { label: "Unlimited (no clock)", limit: null, increment: null },
  { label: "15+10 Rapid — 15 min + 10s per move", limit: 900, increment: 10 },
  { label: "10+0 Rapid — 10 min total", limit: 600, increment: 0 },
  { label: "5+3 Blitz — 5 min + 3s per move", limit: 300, increment: 3 },
  { label: "5+0 Blitz — 5 min total", limit: 300, increment: 0 },
  { label: "3+0 Blitz — 3 min total", limit: 180, increment: 0 },
];

export default function NewGameForm() {
  const router = useRouter();
  const createGame = useCreateGame();
  const [level, setLevel] = useState(3);
  const [timeIdx, setTimeIdx] = useState(0); // unlimited
  const [color, setColor] = useState<"white" | "black" | "random">("white");
  const [coachMode, setCoachMode] = useState<"auto" | "off">("auto");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const tc = TIME_CONTROLS[timeIdx];
    createGame.mutate(
      {
        level,
        clockLimit: tc.limit,
        clockIncrement: tc.increment,
        color,
        coachMode,
      },
      { onSuccess: ({ gameId }) => router.push(`/play/${gameId}`) },
    );
  };

  const selectClass =
    "w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <h2 className="font-semibold">New game vs Stockfish</h2>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-neutral-500">Strength</span>
          <select
            className={selectClass}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => (
              <option key={l} value={l}>
                Level {l}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-500">Time control</span>
          <select
            className={selectClass}
            value={timeIdx}
            onChange={(e) => setTimeIdx(Number(e.target.value))}
          >
            {TIME_CONTROLS.map((tc, i) => (
              <option key={tc.label} value={i}>
                {tc.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-500">Your color</span>
          <select
            className={selectClass}
            value={color}
            onChange={(e) => setColor(e.target.value as typeof color)}
          >
            <option value="white">White</option>
            <option value="black">Black</option>
            <option value="random">Random</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block text-neutral-500">Live coaching</span>
          <select
            className={selectClass}
            value={coachMode}
            onChange={(e) => setCoachMode(e.target.value as typeof coachMode)}
          >
            <option value="auto">Auto (from M3)</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>

      <button
        type="submit"
        disabled={createGame.isPending}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        {createGame.isPending ? "Creating game…" : "Play"}
      </button>

      {createGame.isError && (
        <p className="text-sm text-red-600">{createGame.error.message}</p>
      )}
    </form>
  );
}
