"use client";

import { Chess } from "chess.js";
import { useState } from "react";
import { applyUci } from "@/lib/chess";
import { useGameEvents } from "@/hooks/useGameEvents";
import Board from "./Board";
import Clock from "./Clock";
import GameControls from "./GameControls";
import MoveList from "./MoveList";

export default function PlayClient({ gameId }: { gameId: string }) {
  const { snapshot, connected } = useGameEvents(gameId);
  const [optimisticFen, setOptimisticFen] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const serverFen = snapshot?.fen;

  // Authoritative state always comes from the stream: any server update
  // clears the optimistic overlay (state-adjust-during-render pattern).
  const [lastServerFen, setLastServerFen] = useState(serverFen);
  if (lastServerFen !== serverFen) {
    setLastServerFen(serverFen);
    setOptimisticFen(null);
  }

  if (!snapshot) {
    return (
      <p className="py-16 text-center text-neutral-500">Connecting to game…</p>
    );
  }

  const { game, moves, turn, wtime, btime, clockAt, finished } = snapshot;
  const userColor = game.userColor;
  const myTurn =
    !finished && turn === userColor && ["created", "started"].includes(game.status);
  const clocksRunning = !finished && game.status === "started" && moves.length >= 2;

  const onMove = async (uci: string) => {
    setMoveError(null);
    try {
      const scratch = new Chess(snapshot.fen);
      applyUci(scratch, uci);
      setOptimisticFen(scratch.fen());
    } catch {
      /* board already validated; ignore */
    }
    const res = await fetch(`/api/games/${gameId}/move/${uci}`, { method: "POST" });
    if (!res.ok) {
      setOptimisticFen(null);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMoveError(body.error ?? "Move rejected");
    }
  };

  const unlimited = game.clockInitial == null;
  const userMs = userColor === "white" ? wtime : btime;
  const oppMs = userColor === "white" ? btime : wtime;
  const oppColor = userColor === "white" ? "black" : "white";

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="w-full max-w-[560px] shrink-0">
        <Board
          fen={optimisticFen ?? snapshot.fen}
          orientation={userColor}
          canMove={myTurn}
          onMove={onMove}
        />
      </div>

      <div className="flex min-w-[280px] flex-1 flex-col gap-3">
        {unlimited ? (
          <div className="rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-500 dark:border-neutral-800">
            Stockfish level {game.aiLevel ?? "?"} · unlimited time
          </div>
        ) : (
          <Clock
            label={`Stockfish level ${game.aiLevel ?? "?"}`}
            ms={oppMs}
            asOf={clockAt}
            running={clocksRunning && turn === oppColor}
          />
        )}
        <MoveList moves={moves} />
        {!unlimited && (
          <Clock
            label={`You (${userColor})`}
            ms={userMs}
            asOf={clockAt}
            running={clocksRunning && turn === userColor}
          />
        )}
        <GameControls gameId={gameId} snapshot={snapshot} />

        <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-400 dark:border-neutral-700">
          Coach panel arrives in M3 (mode: {game.coachMode}).
        </div>

        <p className="text-xs text-neutral-400">
          {finished
            ? "Game over."
            : connected
              ? myTurn
                ? "Your move."
                : "Waiting for Stockfish…"
              : "Reconnecting…"}
        </p>
        {moveError && <p className="text-sm text-red-600">{moveError}</p>}
      </div>
    </div>
  );
}
