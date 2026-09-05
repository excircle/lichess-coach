"use client";

import { useState } from "react";

interface CoachToggleProps {
  gameId: string;
  mode: "auto" | "off";
  disabled?: boolean;
}

export default function CoachToggle({ gameId, mode, disabled }: CoachToggleProps) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    await fetch(`/api/games/${gameId}/coach`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: mode === "auto" ? "off" : "auto" }),
    }).catch(() => {});
    // The SSE `state` event carries the new mode back into the snapshot.
    setBusy(false);
  };

  return (
    <button
      onClick={toggle}
      disabled={busy || disabled}
      className={`rounded-full border px-3 py-1 text-xs font-medium disabled:opacity-50 ${
        mode === "auto"
          ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "border-neutral-300 text-neutral-500 dark:border-neutral-700"
      }`}
      title="Toggle automatic coaching"
    >
      Coaching: {mode === "auto" ? "Auto" : "Off"}
    </button>
  );
}
