// Lichess API etiquette (lichess-api.yaml): one request at a time; on 429 back
// off for >= 60s. Serializes REST calls only — long-lived stream GETs must NOT
// go through a queue (they would park the chain forever).
//
// PLAN OS-D4: factory — one independent chain per named host, because a 429 on
// lichess.org must not pause explorer.lichess.org (and vice versa). State lives
// under globalThis so HMR keeps one chain per name.

interface QueueState {
  chain: Promise<unknown>;
  pausedUntil: number;
}

export interface SerialQueue {
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  noteRateLimited(pauseMs?: number): void;
}

const g = globalThis as unknown as { __serialQueues?: Map<string, QueueState> };
const queues = (g.__serialQueues ??= new Map<string, QueueState>());

export function createSerialQueue(name: string): SerialQueue {
  let state = queues.get(name);
  if (!state) {
    state = { chain: Promise.resolve(), pausedUntil: 0 };
    queues.set(name, state);
  }
  const s = state;
  return {
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const wait = s.pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        return job();
      };
      const p = s.chain.then(run, run);
      s.chain = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    noteRateLimited(pauseMs = 65_000): void {
      s.pausedUntil = Date.now() + pauseMs;
    },
  };
}

// The original exports — now the "lichess" instance (lichess.org REST calls).
const lichessQueue = createSerialQueue("lichess");

export function enqueueRest<T>(job: () => Promise<T>): Promise<T> {
  return lichessQueue.enqueue(job);
}

export function noteRateLimited(pauseMs?: number): void {
  lichessQueue.noteRateLimited(pauseMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
