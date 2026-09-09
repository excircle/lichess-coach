/* spike-explorer.ts — OS0 hard gate (PLAN.md OS0.2 + OS-A1).
   Proves the Opening Explorer contract before OS1 is built:
   - anonymous GET → 401 (policy since the DDoS gating, NOT an outage — OS-A1)
   - token-authed GET → 200 with real ECO/opening data in the §2.1 shape
   - /lichess array params serialize comma-joined (OS-A5 querySerializer)
   Run in-container: docker compose exec app npx tsx scripts/spike-explorer.ts */
import createClient from "openapi-fetch";
import type { paths } from "@lichess-org/types";

const EXPLORER_URL = process.env.EXPLORER_URL ?? "https://explorer.lichess.org";
const USER_AGENT = "lichess-coach personal study app";
const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const BOOK_LINE = "e2e4,e7e5,g1f3";
const OFFBEAT_LINE = "e2e4,e7e5,g1f3,b8c6,f1c4,f8c5,h2h4";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

type ExplorerResponse = {
  opening: { eco: string; name: string } | null;
  white: number;
  draws: number;
  black: number;
  moves: {
    uci: string;
    san: string;
    white: number;
    draws: number;
    black: number;
    opening: { eco: string; name: string } | null;
  }[];
};

function printMoves(data: ExplorerResponse): void {
  const total = data.white + data.draws + data.black;
  console.log(
    `  opening: ${data.opening ? `${data.opening.eco} ${data.opening.name}` : "(null)"} · ${total} games`,
  );
  for (const m of data.moves.slice(0, 5)) {
    const games = m.white + m.draws + m.black;
    const leads = m.opening ? ` → ${m.opening.eco} ${m.opening.name}` : "";
    console.log(`    ${m.san.padEnd(6)} ${String(games).padStart(8)} games${leads}`);
  }
}

async function main() {
  console.log(`explorer host: ${EXPLORER_URL}`);

  // (e) DNS/reachability first — an unresolvable host must fail loudly with
  // the .ovh fallback suggestion, not masquerade as an API problem.
  try {
    await fetch(`${EXPLORER_URL}/masters?play=${BOOK_LINE}`, {
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (error) {
    console.error(`FAIL  host unreachable from this container: ${String(error)}`);
    console.error("      try EXPLORER_URL=https://explorer.lichess.ovh");
    process.exit(1);
  }

  // OS-A1: anonymous → 401 is the documented policy; assert it.
  const anonStart = Date.now();
  const anon = await fetch(`${EXPLORER_URL}/masters?play=${BOOK_LINE}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  check(
    `anonymous /masters → 401 (policy, OS-A1)`,
    anon.status === 401,
    `got ${anon.status} in ${Date.now() - anonStart}ms`,
  );

  // Authed client — stored user token, comma-joined arrays (OS-A5).
  const { getStoredCredentials } = await import("../src/lib/lichess/client");
  const creds = getStoredCredentials();
  if (!creds) {
    console.error("FAIL  no Lichess credentials in DB — log in via the app first");
    process.exit(1);
  }
  const explorer = createClient<paths>({
    baseUrl: EXPLORER_URL,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "User-Agent": USER_AGENT,
    },
    querySerializer: { array: { style: "form", explode: false } },
  });

  // (a) known book line — the hard gate. e4 e5 Nf3 is ECO C40-ish territory.
  {
    const started = Date.now();
    const { data, response } = await explorer.GET("/masters", {
      params: { query: { fen: STARTPOS, play: BOOK_LINE, moves: 8, topGames: 0 } },
    });
    const ms = Date.now() - started;
    check(`(a) authed /masters ${BOOK_LINE} → 200`, response.status === 200, `${ms}ms`);
    if (!data) {
      console.error("HARD GATE FAILED — no data from authed /masters. Stopping.");
      process.exit(1);
    }
    const d = data as ExplorerResponse;
    printMoves(d);
    check(
      "(a) opening has real ECO data",
      /^[A-E]\d\d$/.test(d.opening?.eco ?? ""),
      `eco=${d.opening?.eco ?? "null"} name=${d.opening?.name ?? "null"}`,
    );
    check("(a) has ranked moves with counts", d.moves.length >= 3);
    check(
      "(a) moves[].opening present on at least one move",
      d.moves.some((m) => m.opening != null),
    );
  }

  // (b) offbeat line on /masters — thin/empty moves, opening name survives.
  {
    const started = Date.now();
    const { data, response } = await explorer.GET("/masters", {
      params: { query: { fen: STARTPOS, play: OFFBEAT_LINE, moves: 8, topGames: 0 } },
    });
    const ms = Date.now() - started;
    check(`(b) authed /masters offbeat → 200`, response.status === 200, `${ms}ms`);
    const d = data as ExplorerResponse;
    printMoves(d);
    const total = d.white + d.draws + d.black;
    check("(b) offbeat line is thin in masters", total < 100, `${total} games`);
    check(
      "(b) opening still names the last book position",
      d.opening != null,
      `${d.opening?.eco ?? "?"} ${d.opening?.name ?? "?"}`,
    );
  }

  // (c) offbeat line on /lichess with the D2 filters — proves the OS-A5
  // comma-joined serializer live (an exploded form would change the result
  // or 400) and that the fallback DB keeps the mode useful.
  {
    const started = Date.now();
    const { data, response } = await explorer.GET("/lichess", {
      params: {
        query: {
          fen: STARTPOS,
          play: OFFBEAT_LINE,
          moves: 8,
          topGames: 0,
          speeds: ["blitz", "rapid", "classical"],
          ratings: [1800, 2000, 2200, 2500],
        },
      },
    });
    const ms = Date.now() - started;
    check(`(c) authed /lichess offbeat + D2 filters → 200`, response.status === 200, `${ms}ms`);
    const d = data as ExplorerResponse;
    printMoves(d);
    check("(c) lichess DB still has moves here", d.moves.length > 0, `${d.moves.length} moves`);
  }

  console.log(failures === 0 ? "\nSPIKE PASSED" : `\nSPIKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("spike crashed:", error);
  process.exit(1);
});
