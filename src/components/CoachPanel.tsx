"use client";

import { useEffect, useRef, useState } from "react";
import { plyLabel, type GameSnapshot } from "@/lib/games/types";
import CoachToggle from "./CoachToggle";

interface CoachPanelProps {
  gameId: string;
  snapshot: GameSnapshot;
  coachError: string | null;
}

export default function CoachPanel({ gameId, snapshot, coachError }: CoachPanelProps) {
  const { comments, moves, finished, game } = snapshot;
  const [hintPending, setHintPending] = useState(false);
  const [hintError, setHintError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments.length]);

  const askCoach = async () => {
    setHintPending(true);
    setHintError(null);
    const res = await fetch(`/api/games/${gameId}/coach`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setHintError(body.error ?? "hint failed");
    }
    // Success arrives via the SSE `coach` event.
    setHintPending(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Coach</h3>
        <CoachToggle gameId={gameId} mode={game.coachMode} disabled={finished} />
      </div>

      <div
        ref={scroller}
        className="max-h-64 min-h-24 space-y-3 overflow-y-auto pr-1 text-sm"
      >
        {comments.length === 0 ? (
          <p className="text-neutral-400">
            {game.coachMode === "auto"
              ? "The coach will comment after each of your move cycles."
              : "Coaching is off — use “Ask coach” for a hint."}
          </p>
        ) : (
          comments.map((c) => (
            <div key={`${c.ply}-${c.createdAt}`}>
              <p className="text-xs text-neutral-400">
                {c.trigger === "user_request" ? "hint" : "after"}{" "}
                {c.ply > 0 ? plyLabel(moves[c.ply - 1]) : "game start"}
              </p>
              <p className="leading-snug">{c.content}</p>
            </div>
          ))
        )}
      </div>

      {!finished && (
        <button
          onClick={askCoach}
          disabled={hintPending}
          className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {hintPending ? "Coach is thinking…" : "Ask coach"}
        </button>
      )}
      {(hintError ?? coachError) && (
        <p className="text-xs text-amber-600">{hintError ?? coachError}</p>
      )}
    </div>
  );
}
