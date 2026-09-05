// Lichess API etiquette (lichess-api.yaml): one request at a time; on 429 back
// off for >= 60s. This queue serializes REST calls only — long-lived stream
// GETs must NOT go through it (they would park the queue forever).

interface QueueState {
  chain: Promise<unknown>;
  pausedUntil: number;
}

const g = globalThis as unknown as { __lichessQueue?: QueueState };
const state = (g.__lichessQueue ??= { chain: Promise.resolve(), pausedUntil: 0 });

export function enqueueRest<T>(job: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = state.pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    return job();
  };
  const p = state.chain.then(run, run);
  state.chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

export function noteRateLimited(): void {
  state.pausedUntil = Date.now() + 65_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
