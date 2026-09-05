"use client";

import { useEffect, useState } from "react";
import type { GameSnapshot } from "@/lib/games/types";

// SSE consumer: snapshot on connect, state/finish deltas after. EventSource
// auto-reconnects on drops and the server resends a fresh snapshot, so no
// resume bookkeeping is needed. Closes for good once the game is finished.
export function useGameEvents(gameId: string) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/games/${gameId}/events`);
    const onData = (event: MessageEvent) => {
      const next = JSON.parse(event.data) as GameSnapshot;
      setSnapshot(next);
      if (next.finished) {
        setConnected(false);
        source.close();
      }
    };
    source.addEventListener("snapshot", onData);
    source.addEventListener("state", onData);
    source.addEventListener("finish", onData);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [gameId]);

  return { snapshot, connected };
}
