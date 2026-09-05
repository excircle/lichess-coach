import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { ensureGameManager, hasGameRow } from "@/lib/games/manager";
import { deriveResult, isTerminalStatus } from "@/lib/games/types";
import { getStoredCredentials } from "./client";
import { streamNdjson } from "./ndjson";

// The ONE global event stream per token (Lichess closes any previous one).

interface EventStreamState {
  running: boolean;
  abort?: () => void;
}

const g = globalThis as unknown as { __lichessEventStream?: EventStreamState };

export type EnsureResult = "started" | "already-running" | "no-credentials";

// Idempotent (amendment A3): called from instrumentation.ts at boot AND from
// the OAuth callback (fresh installs have no credentials at boot).
export function ensureEventStream(): EnsureResult {
  if (g.__lichessEventStream?.running) return "already-running";
  if (!getStoredCredentials()) return "no-credentials";
  const state: EventStreamState = { running: true };
  g.__lichessEventStream = state;
  void runLoop(state);
  return "started";
}

async function runLoop(state: EventStreamState): Promise<void> {
  let backoff = 1_000;
  while (state.running) {
    const creds = getStoredCredentials();
    if (!creds) {
      await sleep(5_000);
      continue;
    }
    const startedAt = Date.now();
    const stream = streamNdjson({
      url: "https://lichess.org/api/stream/event",
      token: creds.token,
      onJson: handleEvent,
    });
    state.abort = stream.abort;
    // Keepalive blanks are documented at 7s for this stream; >20s = stale.
    const watchdog = setInterval(() => {
      if (Date.now() - stream.lastByteAt() > 20_000) {
        console.warn("[lichess events] watchdog: 20s of silence, reconnecting");
        stream.abort();
      }
    }, 5_000);
    const close = await stream.done;
    clearInterval(watchdog);
    if (!state.running) break;
    if (Date.now() - startedAt > 60_000) backoff = 1_000; // healthy run: reset backoff
    console.warn(
      `[lichess events] stream closed (${close.type}) — reconnecting in ${backoff}ms`,
    );
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

interface StreamEvent {
  type?: string;
  game?: {
    gameId?: string;
    id?: string;
    source?: string;
    winner?: string;
    status?: { id?: number; name?: string };
  };
}

function handleEvent(value: unknown): void {
  const event = value as StreamEvent;
  const gameId = event.game?.gameId ?? event.game?.id;

  switch (event.type) {
    case "gameStart": {
      if (!gameId) return;
      // Amendment A4 (fair play, non-negotiable): manage ONLY games this app
      // created (present in our games table) — the event stream also delivers
      // games started elsewhere on the account, including vs humans.
      if (!hasGameRow(gameId)) {
        console.log(`[lichess events] ignoring gameStart ${gameId} (not app-created)`);
        return;
      }
      if (event.game?.source && event.game.source !== "ai") {
        console.warn(
          `[lichess events] ignoring gameStart ${gameId} (source=${event.game.source})`,
        );
        return;
      }
      ensureGameManager(gameId);
      break;
    }
    case "gameFinish": {
      if (!gameId || !hasGameRow(gameId)) return;
      // The manager normally saw the terminal gameState already; this is the
      // belt-and-braces path for events during downtime (amendment A2).
      const status = event.game?.status?.name;
      if (status) {
        markFinishedIfNeeded(gameId, status, event.game?.winner ?? null);
      }
      // M4 hook: trigger the review pipeline here as well (idempotent).
      break;
    }
    default:
      // challenge / challengeCanceled / challengeDeclined — nothing to do.
      break;
  }
}

function markFinishedIfNeeded(
  gameId: string,
  status: string,
  winner: string | null,
): void {
  const row = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!row || isTerminalStatus(row.status)) return;
  db.update(games)
    .set({
      status,
      winner,
      result: deriveResult(status, winner),
      finishedAt: new Date(),
    })
    .where(eq(games.id, gameId))
    .run();
  console.log(`[lichess events] gameFinish fallback persisted ${gameId} (${status})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
