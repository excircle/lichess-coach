"use client";

import { useEffect, useState } from "react";

interface ClockProps {
  label: string;
  ms: number | null; // remaining ms as of `asOf`
  asOf: number; // epoch ms when `ms` was true
  running: boolean;
}

export default function Clock({ label, ms, asOf, running }: ClockProps) {
  const [now, setNow] = useState(asOf);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = running ? Math.max(0, now - asOf) : 0;
  const remaining = ms == null ? null : Math.max(0, ms - elapsed);

  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-4 py-2 ${
        running
          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <span className="text-sm text-neutral-500">{label}</span>
      <span className="font-mono text-xl tabular-nums">
        {remaining == null ? "--:--" : formatMs(remaining)}
      </span>
    </div>
  );
}

function formatMs(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
