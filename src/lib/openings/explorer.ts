import createClient from "openapi-fetch";
import type { components, paths } from "@lichess-org/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { openingCache } from "@/lib/db/schema";
import { getStoredCredentials } from "@/lib/lichess/client";
import { createSerialQueue } from "@/lib/lichess/queue";
import type { BookSource } from "@/lib/games/types";

// ---------------------------------------------------------------------------
// Opening Explorer client (PLAN OS §5.2). Two-layer cache: in-process Map →
// opening_cache table (30-day TTL) → network, through its own serial queue —
// never lichess/client.ts's (a 429 on one host must not pause the other, D4).
// Requests authenticate with the stored user OAuth token (OS-A1: anonymous
// calls 401 by policy), so the queue + cache are etiquette, not just speed.
// ---------------------------------------------------------------------------

export const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// OS-A7 precedent: lib modules read env directly so spikes can run standalone.
const EXPLORER_URL = process.env.EXPLORER_URL ?? "https://explorer.lichess.org";
const USER_AGENT = "lichess-coach personal study app";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (D4)

// D2 filters for the /lichess fallback database.
const LICHESS_SPEEDS: components["schemas"]["Speed"][] = ["blitz", "rapid", "classical"];
const LICHESS_RATINGS: (1800 | 2000 | 2200 | 2500)[] = [1800, 2000, 2200, 2500];

// Explorer response with the game-list payloads stripped (what we cache).
export type ExplorerResult =
  | Omit<components["schemas"]["OpeningExplorerMasters"], "topGames">
  | Omit<components["schemas"]["OpeningExplorerLichess"], "topGames" | "recentGames" | "history">;

const g = globalThis as unknown as { __explorerMemCache?: Map<string, ExplorerResult> };
const memCache = (g.__explorerMemCache ??= new Map<string, ExplorerResult>());

const explorerQueue = createSerialQueue("explorer");

// OS-A5: the explorer wants comma-joined arrays; openapi-fetch explodes by default.
const explorer = createClient<paths>({
  baseUrl: EXPLORER_URL,
  querySerializer: { array: { style: "form", explode: false } },
});

export async function fetchExplorer(
  source: BookSource,
  rootFen: string,
  playUci: string[],
): Promise<ExplorerResult> {
  const key = `${source}|${rootFen}|${playUci.join(",")}`;
  const mem = memCache.get(key);
  if (mem) return mem;

  const row = db.select().from(openingCache).where(eq(openingCache.key, key)).get();
  if (row && Date.now() - row.fetchedAt.getTime() < CACHE_TTL_MS) {
    const cached = JSON.parse(row.json) as ExplorerResult;
    memCache.set(key, cached);
    console.log(`[explorer] ${source} play=${playUci.join(",") || "(start)"} ← sqlite cache`);
    return cached;
  }

  const result = await explorerQueue.enqueue(() =>
    fetchFromNetwork(source, rootFen, playUci),
  );
  memCache.set(key, result);
  const json = JSON.stringify(result);
  db.insert(openingCache)
    .values({ key, json, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: openingCache.key,
      set: { json, fetchedAt: new Date() },
    })
    .run();
  return result;
}

async function fetchFromNetwork(
  source: BookSource,
  rootFen: string,
  playUci: string[],
): Promise<ExplorerResult> {
  const creds = getStoredCredentials();
  if (!creds) {
    // Same failure class as a 401: no auth, no lookups (OS-A1) — do NOT pause
    // the queue; the caller degrades to Auto coaching.
    console.warn("[explorer] no Lichess token stored — opening lookups disabled");
    throw new Error("explorer auth unavailable: no Lichess token stored");
  }
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    "User-Agent": USER_AGENT,
  };
  const play = playUci.join(",");
  console.log(`[explorer] GET /${source} play=${play || "(start)"} (network)`);

  // Per-source branches so TS keeps the two response shapes narrowed.
  if (source === "masters") {
    const { data, response } = await explorer.GET("/masters", {
      headers,
      params: { query: { fen: rootFen, play, moves: 8, topGames: 0 } },
    });
    ensureOk(response, data !== undefined);
    return strip(data!);
  }
  const { data, response } = await explorer.GET("/lichess", {
    headers,
    params: {
      query: {
        fen: rootFen,
        play,
        moves: 8,
        topGames: 0,
        speeds: LICHESS_SPEEDS,
        ratings: LICHESS_RATINGS,
      },
    },
  });
  ensureOk(response, data !== undefined);
  return strip(data!);
}

function ensureOk(response: Response, hasData: boolean): void {
  if (response.status === 401) {
    // OS-A1: 401 ≠ 429 — token missing/expired is not a rate limit.
    console.warn("[explorer] Lichess token missing/expired — opening lookups disabled");
    throw new Error("explorer 401: Lichess token missing/expired");
  }
  if (response.status === 429) {
    explorerQueue.noteRateLimited(60_000);
    throw new Error("explorer 429: rate limited — queue paused 60s");
  }
  if (!response.ok || !hasData) {
    throw new Error(`explorer ${response.status} ${response.url}`);
  }
}

// Strip the game-list payloads before caching (D4).
function strip<
  T extends { white: number; draws: number; black: number } & Record<
    "opening" | "moves",
    unknown
  >,
>(d: T): Pick<T, "opening" | "white" | "draws" | "black" | "moves"> {
  return {
    opening: d.opening,
    white: d.white,
    draws: d.draws,
    black: d.black,
    moves: d.moves,
  };
}
