"use client";

import { useState } from "react";
import type { GameSnapshot } from "@/lib/games/types";

interface GameControlsProps {
  gameId: string;
  snapshot: GameSnapshot;
}

export default function GameControls({ gameId, snapshot }: GameControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { game, moves, finished } = snapshot;

  const post = async (action: "resign" | "abort") => {
    if (action === "resign" && !window.confirm("Resign this game?")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/games/${gameId}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `${action} failed`);
    }
    setBusy(false);
  };

  if (finished) {
    const outcome =
      game.winner == null
        ? game.result === "aborted"
          ? "Game aborted"
          : `Draw (${game.status})`
        : game.winner === game.userColor
          ? `You won — ${game.result} (${game.status})`
          : `You lost — ${game.result} (${game.status})`;
    return (
      <div className="rounded-lg border border-neutral-200 p-4 text-center dark:border-neutral-800">
        <p className="font-semibold">{outcome}</p>
        <p className="mt-1 text-sm text-neutral-500">
          Post-game review arrives in M4.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {moves.length < 2 && (
          <button
            onClick={() => post("abort")}
            disabled={busy}
            className="flex-1 rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Abort
          </button>
        )}
        <button
          onClick={() => post("resign")}
          disabled={busy}
          className="flex-1 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950"
        >
          Resign
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
