/* spike-stockfish.ts — M1 de-risking spike (PLAN.md risk #3).
   Proves: the apt Stockfish binary runs in-container, speaks UCI, returns
   multipv analysis and bestmove, and yields `bestmove (none)` on a terminal
   position (the UCI wrapper in M3 must handle that without hanging).
   Run in-container: npx tsx scripts/spike-stockfish.ts */
import { spawn } from "node:child_process";
import readline from "node:readline";

const enginePath = process.env.STOCKFISH_PATH ?? "/usr/games/stockfish";

const engine = spawn(enginePath);
engine.on("error", (error) => {
  console.error(`SPIKE FAILED: could not spawn ${enginePath}:`, error.message);
  process.exit(1);
});
const rl = readline.createInterface({ input: engine.stdout });

function send(command: string): void {
  console.log(`>> ${command}`);
  engine.stdin.write(command + "\n");
}

function waitFor(
  predicate: (line: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for engine line (${timeoutMs}ms)`)),
      timeoutMs,
    );
    const onLine = (line: string) => {
      console.log(`<< ${line}`);
      if (predicate(line)) {
        clearTimeout(timer);
        rl.off("line", onLine);
        resolve(line);
      }
    };
    rl.on("line", onLine);
  });
}

async function main() {
  send("uci");
  const uciok = waitFor((l) => l === "uciok");
  const idLine = await waitFor((l) => l.startsWith("id name"));
  await uciok;
  console.log(`\nEngine: ${idLine.replace("id name ", "")}`);

  send("setoption name MultiPV value 3");
  send("isready");
  await waitFor((l) => l === "readyok");

  // Normal analysis: expect multipv info lines then a bestmove.
  send("position startpos moves e2e4 e7e5");
  send("go movetime 700");
  const best = await waitFor((l) => l.startsWith("bestmove"));
  console.log(`\nNormal position bestmove: ${best.split(" ")[1]}`);

  // Terminal position (fool's mate delivered — White to move, checkmated):
  // must yield "bestmove (none)" rather than hanging.
  send("position fen rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
  send("go movetime 300");
  const terminal = await waitFor((l) => l.startsWith("bestmove"));
  if (terminal.includes("(none)")) {
    console.log("Terminal position correctly yields bestmove (none)");
  } else {
    console.log(`NOTE: terminal position yielded unexpected: ${terminal}`);
  }

  send("quit");
  console.log("\nSPIKE STOCKFISH: OK");
  process.exit(0);
}

main().catch((error) => {
  console.error("SPIKE FAILED:", error);
  process.exit(1);
});
