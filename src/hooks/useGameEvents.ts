"use client";

import { useEffect, useState } from "react";
import type {
  CoachEvent,
  EvalEvent,
  GameSnapshot,
  OpeningState,
} from "@/lib/games/types";

// SSE consumer: snapshot on connect, then state/finish (full snapshots) plus
// eval/coach deltas merged in. EventSource auto-reconnects on drops and the
// server resends a fresh snapshot (which carries all evals + comments), so no
// resume bookkeeping is needed. Closes for good once the game is finished.
export function useGameEvents(gameId: string) {
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`/api/games/${gameId}/events`);

    const onSnapshot = (event: MessageEvent) => {
      const next = JSON.parse(event.data) as GameSnapshot;
      setSnapshot(next);
      if (next.finished) {
        setConnected(false);
        source.close();
      }
    };

    const onEval = (event: MessageEvent) => {
      const ev = JSON.parse(event.data) as EvalEvent;
      setSnapshot((s) =>
        s
          ? {
              ...s,
              moves: s.moves.map((m) =>
                m.ply === ev.ply
                  ? {
                      ...m,
                      evalCp: ev.evalCp,
                      evalMate: ev.evalMate,
                      winPct: ev.winPct,
                      cpLoss: ev.cpLoss,
                      judgment: ev.judgment,
                      bestMoveUci: ev.bestMoveUci,
                    }
                  : m,
              ),
            }
          : s,
      );
    };

    const onCoach = (event: MessageEvent) => {
      const ce = JSON.parse(event.data) as CoachEvent;
      if (ce.content == null) {
        if (ce.error && ce.error !== "superseded") setCoachError(ce.error);
        return;
      }
      setCoachError(null);
      setSnapshot((s) => {
        if (!s) return s;
        if (s.comments.some((c) => c.ply === ce.ply && c.createdAt === ce.createdAt)) {
          return s; // already merged (e.g. hint response + SSE both delivered)
        }
        return {
          ...s,
          comments: [
            ...s.comments,
            {
              ply: ce.ply,
              trigger: ce.trigger,
              content: ce.content as string,
              createdAt: ce.createdAt,
            },
          ],
        };
      });
    };

    // Merge by value (PLAN OS risk 7): each opening event wholesale-replaces
    // the snapshot's opening — state/finish frames already carry it.
    const onOpening = (event: MessageEvent) => {
      const op = JSON.parse(event.data) as OpeningState;
      setSnapshot((s) => (s ? { ...s, opening: op } : s));
    };

    source.addEventListener("snapshot", onSnapshot);
    source.addEventListener("state", onSnapshot);
    source.addEventListener("finish", onSnapshot);
    source.addEventListener("eval", onEval);
    source.addEventListener("coach", onCoach);
    source.addEventListener("opening", onOpening);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [gameId]);

  return { snapshot, connected, coachError };
}
