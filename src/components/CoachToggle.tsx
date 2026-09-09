"use client";

import { useState } from "react";
import type { CoachMode } from "@/lib/games/types";

interface CoachToggleProps {
  gameId: string;
  mode: CoachMode;
  disabled?: boolean;
}

const MODES: { value: CoachMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "opening", label: "Opening" },
  { value: "off", label: "Off" },
];

// Three-way segmented control (PLAN OS §6.2 / OS-A6). No optimistic state:
// the SSE `state` event carries the new mode back into the snapshot.
export default function CoachToggle({ gameId, mode, disabled }: CoachToggleProps) {
  const [busy, setBusy] = useState(false);

  const select = async (next: CoachMode) => {
    if (next === mode) return;
    setBusy(true);
    await fetch(`/api/games/${gameId}/coach`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    }).catch(() => {});
    setBusy(false);
  };

  return (
    <div
      role="group"
      aria-label="Coaching mode"
      className="inline-flex self-start overflow-hidden rounded-full border border-neutral-300 text-xs font-medium dark:border-neutral-700"
    >
      {MODES.map((m) => (
        <button
          key={m.value}
          onClick={() => select(m.value)}
          disabled={busy || disabled}
          className={`px-3 py-1 disabled:opacity-50 ${
            mode === m.value
              ? "bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          }`}
          title={`Coaching: ${m.label}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
