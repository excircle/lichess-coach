import { UciEngine, type EngineEval } from "./engine";

// Two engine instances (PLAN.md): `live` answers per-ply evals during play,
// `batch` does post-game analysis (M4) — so reviews never starve live evals.
// globalThis singletons survive dev HMR; SIGTERM disposes both.

const g = globalThis as unknown as {
  __stockfish?: { live: UciEngine; batch: UciEngine };
  __stockfishSigterm?: boolean;
};

function engines() {
  if (!g.__stockfish) {
    g.__stockfish = {
      live: new UciEngine("live", { MultiPV: 3, Threads: 1, Hash: 64 }),
      batch: new UciEngine("batch", { MultiPV: 2, Threads: 1, Hash: 128 }),
    };
  }
  if (!g.__stockfishSigterm) {
    g.__stockfishSigterm = true;
    process.once("SIGTERM", () => {
      g.__stockfish?.live.dispose();
      g.__stockfish?.batch.dispose();
    });
  }
  return g.__stockfish;
}

// Live: multipv 3, movetime 700ms — top lines feed the coach prompt.
export function evalLive(fen: string): Promise<EngineEval> {
  return engines().live.analyze({ fen, movetimeMs: 700 });
}

// Batch (M4): multipv 2, depth 18 capped at 1000ms per position.
export function evalBatch(fen: string): Promise<EngineEval> {
  return engines().batch.analyze({ fen, depth: 18, movetimeMs: 1_000 });
}
