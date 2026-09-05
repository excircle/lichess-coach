import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

// Hand-rolled UCI wrapper (PLAN.md: no maintained npm wrapper exists).
// One engine = one serialized job queue; respawns on crash; must survive
// terminal positions (`bestmove (none)` with no pv — amendment list).

export interface EngineLine {
  multipv: number;
  depth: number;
  cp: number | null; // side-to-move POV (UCI convention)
  mate: number | null; // side-to-move POV
  pvUci: string[];
}

export interface EngineEval {
  bestMoveUci: string | null; // null on terminal positions
  lines: EngineLine[]; // sorted by multipv; [] on terminal positions
}

export interface AnalyzeRequest {
  fen: string;
  movetimeMs?: number;
  depth?: number;
}

export class UciEngine {
  private readonly name: string;
  private readonly options: Record<string, string | number>;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private readyPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(name: string, options: Record<string, string | number>) {
    this.name = name;
    this.options = options;
  }

  analyze(request: AnalyzeRequest): Promise<EngineEval> {
    if (this.disposed) return Promise.reject(new Error(`engine ${this.name} disposed`));
    const run = () => this.runJob(request);
    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  dispose(): void {
    this.disposed = true;
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  // ------------------------------------------------------------------ intern

  private async ensureRunning(): Promise<void> {
    if (this.proc && this.readyPromise) return this.readyPromise;
    const path = process.env.STOCKFISH_PATH ?? "/usr/games/stockfish";
    const proc = spawn(path);
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout });
    proc.on("exit", (code) => {
      if (this.disposed) return;
      console.warn(`[stockfish ${this.name}] exited (code=${code}) — will respawn on next job`);
      if (this.proc === proc) {
        this.proc = null;
        this.rl = null;
        this.readyPromise = null;
      }
    });
    proc.on("error", (error) => {
      console.error(`[stockfish ${this.name}] spawn error:`, error.message);
      if (this.proc === proc) {
        this.proc = null;
        this.rl = null;
        this.readyPromise = null;
      }
    });

    this.readyPromise = (async () => {
      this.send("uci");
      await this.waitFor((l) => l === "uciok", 10_000);
      for (const [key, value] of Object.entries(this.options)) {
        this.send(`setoption name ${key} value ${value}`);
      }
      this.send("isready");
      await this.waitFor((l) => l === "readyok", 10_000);
      console.log(`[stockfish ${this.name}] ready`);
    })();
    return this.readyPromise;
  }

  private async runJob(request: AnalyzeRequest): Promise<EngineEval> {
    await this.ensureRunning();
    if (!this.proc) throw new Error(`engine ${this.name} not running`);

    // isready between jobs keeps the line protocol in lockstep (PLAN risk #3).
    this.send("isready");
    await this.waitFor((l) => l === "readyok", 5_000);

    const go =
      request.depth != null && request.movetimeMs != null
        ? `go depth ${request.depth} movetime ${request.movetimeMs}`
        : request.depth != null
          ? `go depth ${request.depth}`
          : `go movetime ${request.movetimeMs ?? 700}`;
    const timeoutMs = (request.movetimeMs ?? 5_000) + 5_000;

    const linesByMultipv = new Map<number, EngineLine>();
    this.send(`position fen ${request.fen}`);
    this.send(go);

    const bestmoveLine = await this.waitFor(
      (line) => {
        if (line.startsWith("info ")) {
          const parsed = parseInfoLine(line);
          if (parsed) linesByMultipv.set(parsed.multipv, parsed);
        }
        return line.startsWith("bestmove");
      },
      timeoutMs,
      () => {
        // Job hung — kill so the next job respawns a fresh engine.
        console.error(`[stockfish ${this.name}] job timeout — killing engine`);
        this.proc?.kill("SIGKILL");
      },
    );

    const bestMove = bestmoveLine.split(/\s+/)[1];
    return {
      bestMoveUci: !bestMove || bestMove === "(none)" ? null : bestMove,
      lines: [...linesByMultipv.values()].sort((a, b) => a.multipv - b.multipv),
    };
  }

  private send(command: string): void {
    this.proc?.stdin.write(command + "\n");
  }

  private waitFor(
    predicate: (line: string) => boolean,
    timeoutMs: number,
    onTimeout?: () => void,
  ): Promise<string> {
    const rl = this.rl;
    const proc = this.proc;
    if (!rl || !proc) return Promise.reject(new Error(`engine ${this.name} not running`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        onTimeout?.();
        reject(new Error(`engine ${this.name}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const onLine = (line: string) => {
        let done = false;
        try {
          done = predicate(line);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (done) {
          cleanup();
          resolve(line);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error(`engine ${this.name}: process exited mid-job`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        rl.off("line", onLine);
        proc.off("exit", onExit);
      };
      rl.on("line", onLine);
      proc.on("exit", onExit);
    });
  }
}

// info depth 14 seldepth 20 multipv 1 score cp 41 ... pv g1f3 b8c6 ...
export function parseInfoLine(line: string): EngineLine | null {
  const tokens = line.split(/\s+/);
  const get = (key: string): string | undefined => {
    const i = tokens.indexOf(key);
    return i >= 0 ? tokens[i + 1] : undefined;
  };
  const pvIndex = tokens.indexOf("pv");
  if (pvIndex < 0) return null;
  const depth = Number(get("depth"));
  if (!Number.isFinite(depth)) return null;
  const scoreIndex = tokens.indexOf("score");
  let cp: number | null = null;
  let mate: number | null = null;
  if (scoreIndex >= 0) {
    const kind = tokens[scoreIndex + 1];
    const value = Number(tokens[scoreIndex + 2]);
    if (kind === "cp") cp = value;
    else if (kind === "mate") mate = value;
  }
  return {
    multipv: Number(get("multipv") ?? 1),
    depth,
    cp,
    mate,
    pvUci: tokens.slice(pvIndex + 1),
  };
}
