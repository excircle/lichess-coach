import { getStoredCredentials } from "./client";
import { streamNdjson } from "./ndjson";

// The ONE global event stream per token (Lichess closes any previous one).
// M1: consume + log. M2 wires gameStart/gameFinish into GameManagers —
// amendment A4: only game ids present in our `games` table (app-created vs AI)
// may spawn a manager; everything else (e.g. human games played on
// lichess.org) is ignored.

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
  game?: { gameId?: string; id?: string; source?: string };
}

function handleEvent(value: unknown): void {
  const event = value as StreamEvent;
  const gameId = event.game?.gameId ?? event.game?.id ?? "";
  console.log(`[lichess events] ${event.type ?? "unknown"} ${gameId}`.trim());
  // M2: gameStart → spawn GameManager (A4-filtered), gameFinish → review kick.
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
