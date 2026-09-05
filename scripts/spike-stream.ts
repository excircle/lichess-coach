/* spike-stream.ts — M1 de-risking spike (PLAN.md risk #2 + amendments A1/A2).
   Proves, against the real Lichess API:
     1. POST /api/challenge/ai creates a casual game vs Stockfish level 1
        (scopes challenge:write board:play — "unverifiable locally" item #4)
     2. the board stream is zero-delay ndjson: gameFull first, then gameState
     3. BOARD-stream keepalive cadence (undocumented in the spec — raw lines
        are logged with timestamps, blanks included; A1)
     4. castling wire notation: e1g1 vs king-to-rook e1h1 (we castle early)
     5. the server closing the stream at game end is the normal finish signal (A2)
     6. what a reconnect to an already-finished game delivers (boot re-attach)
   Token: uses the app DB credentials (log in via the app first), or LICHESS_PAT.
   Run in-container: npx tsx scripts/spike-stream.ts */
import { streamNdjson } from "../src/lib/lichess/ndjson";

async function resolveToken(): Promise<string> {
  if (process.env.LICHESS_PAT) {
    console.log("using LICHESS_PAT from env");
    return process.env.LICHESS_PAT;
  }
  try {
    const { getStoredCredentials } = await import("../src/lib/lichess/client");
    const creds = getStoredCredentials();
    if (creds) {
      console.log(`using DB token for lichess user ${creds.userId}`);
      return creds.token;
    }
  } catch (error) {
    console.warn(`could not read DB credentials: ${(error as Error).message}`);
  }
  console.error(
    "No Lichess token. Either log in via the app (docker compose up → http://localhost:3000)\n" +
      "or set LICHESS_PAT (create at https://lichess.org/account/oauth/token with scopes challenge:write board:play).",
  );
  process.exit(2);
}

interface GameStateLine {
  type: "gameState";
  moves: string;
  status: string;
  wtime?: number;
  btime?: number;
  winner?: string;
}
interface GameFullLine {
  type: "gameFull";
  id: string;
  state: GameStateLine;
  white?: Record<string, unknown>;
  black?: Record<string, unknown>;
  clock?: { initial?: number; increment?: number };
}
type BoardLine =
  | GameFullLine
  | GameStateLine
  | { type: string; [k: string]: unknown };

async function main() {
  const safetyTimer = setTimeout(() => {
    console.error("SPIKE TIMEOUT after 4 minutes");
    process.exit(1);
  }, 240_000);

  const token = await resolveToken();
  const auth = { Authorization: `Bearer ${token}` };
  const post = (path: string) =>
    fetch(`https://lichess.org/api/${path}`, { method: "POST", headers: auth });

  // 1. create the AI game (form-encoded per spec)
  const createRes = await fetch("https://lichess.org/api/challenge/ai", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      level: "1",
      "clock.limit": "300",
      "clock.increment": "0",
      color: "white",
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `challenge/ai failed: HTTP ${createRes.status} ${await createRes.text()}`,
    );
  }
  const game = (await createRes.json()) as {
    id: string;
    fullId?: string;
    speed?: string;
  };
  console.log(
    `created game ${game.id} (https://lichess.org/${game.id}) fullId=${game.fullId} speed=${game.speed}\n`,
  );

  // 2. stream it with scripted play: develop, castle on our 4th move, resign.
  const streamUrl = `https://lichess.org/api/board/game/stream/${game.id}`;
  const t0 = Date.now();
  const stamp = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
  const scripted = ["e2e4", "g1f3", "f1c4", "e1g1"];
  let scriptIdx = 0;
  let moveFailures = 0;
  let resigned = false;
  let finalStatus = "created";
  let lastMoves = "";
  let pending: Promise<void> = Promise.resolve();

  async function act(movesStr: string, status: string): Promise<void> {
    lastMoves = movesStr;
    finalStatus = status;
    if (status !== "created" && status !== "started") return;
    const played = movesStr.trim() ? movesStr.trim().split(" ") : [];
    if (played.length % 2 !== 0) return; // not White's turn

    if (scriptIdx < scripted.length && moveFailures < 2) {
      let mv = scripted[scriptIdx];
      let res = await post(`board/game/${game.id}/move/${mv}`);
      if (!res.ok && mv === "e1g1") {
        console.log(
          `${stamp()} castle e1g1 rejected (HTTP ${res.status}) — trying king-to-rook e1h1`,
        );
        mv = "e1h1";
        res = await post(`board/game/${game.id}/move/${mv}`);
      }
      if (res.ok) {
        console.log(`${stamp()} played ${mv}`);
        scriptIdx++;
      } else {
        moveFailures++;
        console.log(
          `${stamp()} move ${mv} rejected: HTTP ${res.status} ${await res.text()}`,
        );
      }
      return;
    }

    if (!resigned) {
      resigned = true;
      const res = await post(`board/game/${game.id}/resign`);
      console.log(`${stamp()} resign → HTTP ${res.status}`);
    }
  }

  const stream = streamNdjson<BoardLine>({
    url: streamUrl,
    token,
    onRawLine: (raw) => {
      if (raw.trim() === "") console.log(`${stamp()} <keepalive blank line>`);
    },
    onJson: (line) => {
      if (line.type === "gameFull") {
        const full = line as GameFullLine;
        console.log(
          `${stamp()} gameFull clock.initial=${full.clock?.initial}ms state.status=${full.state.status}`,
        );
        pending = pending.then(() => act(full.state.moves, full.state.status));
      } else if (line.type === "gameState") {
        const st = line as GameStateLine;
        console.log(
          `${stamp()} gameState status=${st.status} wtime=${st.wtime} moves="${st.moves}"`,
        );
        pending = pending.then(() => act(st.moves, st.status));
      } else {
        console.log(`${stamp()} line type=${line.type}`);
      }
    },
  });

  const close = await stream.done;
  await pending;
  console.log(`\nlive stream closed: cause=${close.type} finalStatus=${finalStatus}`);
  console.log(`final moves string: "${lastMoves}"`);
  console.log(
    lastMoves.includes("e1h1")
      ? ">> castling echoed as KING-TO-ROOK (e1h1) — GameManager needs the translation fallback"
      : lastMoves.includes("e1g1")
        ? ">> castling echoed as standard e1g1"
        : ">> castle was not played (check move rejections above)",
  );

  // 3. reconnect to the finished game: what does boot re-attach see?
  console.log("\n--- reconnecting to the finished game ---");
  const t1 = Date.now();
  const stamp2 = () => `[re +${((Date.now() - t1) / 1000).toFixed(1)}s]`;
  const again = streamNdjson<BoardLine>({
    url: streamUrl,
    token,
    onRawLine: (raw) => {
      if (raw.trim() === "") console.log(`${stamp2()} <keepalive blank line>`);
    },
    onJson: (line) =>
      console.log(`${stamp2()} ${JSON.stringify(line).slice(0, 200)}`),
  });
  const reTimeout = setTimeout(() => {
    console.log(`${stamp2()} finished-game stream still open after 30s — aborting`);
    again.abort();
  }, 30_000);
  const close2 = await again.done;
  clearTimeout(reTimeout);
  console.log(`finished-game stream closed: cause=${close2.type}`);

  clearTimeout(safetyTimer);
  console.log("\nSPIKE STREAM: OK");
  process.exit(0);
}

main().catch((error) => {
  console.error("SPIKE FAILED:", error);
  process.exit(1);
});
