import createClient from "openapi-fetch";
import type { paths } from "@lichess-org/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { credentials } from "@/lib/db/schema";
import { enqueueRest, noteRateLimited } from "./queue";

// Typed Lichess client. All REST calls go through restCall() (serialized, 429
// aware). Streams use lib/lichess/ndjson.ts directly — never this queue.
export const lichess = createClient<paths>({ baseUrl: "https://lichess.org" });

export function getStoredCredentials(): { token: string; userId: string } | null {
  const row = db.select().from(credentials).where(eq(credentials.id, 1)).get();
  return row ? { token: row.lichessToken, userId: row.lichessUserId } : null;
}

export function authHeaders(tokenOverride?: string): { Authorization: string } {
  const token = tokenOverride ?? getStoredCredentials()?.token;
  if (!token) throw new Error("No Lichess token stored — log in first");
  return { Authorization: `Bearer ${token}` };
}

export async function restCall<T>(
  fn: () => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  return enqueueRest(async () => {
    const { data, error, response } = await fn();
    if (response.status === 429) {
      noteRateLimited();
      throw new Error("Lichess rate limit (429) — queue paused 65s");
    }
    if (error !== undefined || data === undefined) {
      const detail = JSON.stringify(error ?? "empty body");
      throw new Error(
        `Lichess ${response.status} ${response.url}: ${detail.length > 300 ? detail.slice(0, 300) + "…" : detail}`,
      );
    }
    return data;
  });
}

const formSerializer = (body: unknown) =>
  new URLSearchParams(
    Object.fromEntries(
      Object.entries(body as Record<string, unknown>)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]),
    ),
  );

export async function getAccount(tokenOverride?: string) {
  return restCall(() =>
    lichess.GET("/api/account", { headers: authHeaders(tokenOverride) }),
  );
}

// Omit both clock params for an unlimited (correspondence) game — allowed vs AI.
export async function challengeAi(params: {
  level: number;
  clockLimit?: number; // seconds
  clockIncrement?: number; // seconds
  color: "white" | "black" | "random";
  fen?: string;
}) {
  return restCall(() =>
    lichess.POST("/api/challenge/ai", {
      // openapi-fetch defaults to application/json — this endpoint is form-encoded.
      headers: {
        ...authHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: {
        level: params.level,
        "clock.limit": params.clockLimit,
        "clock.increment": params.clockIncrement,
        color: params.color,
        ...(params.fen ? { fen: params.fen } : {}),
      },
      bodySerializer: formSerializer,
    }),
  );
}

// Post-game export. JSON needs an explicit Accept header (default is PGN) and
// pgn only arrives with pgnInJson=true (PLAN.md amendments). No auth required
// by the spec, but we send it anyway for the authed rate-limit bucket.
export async function exportGame(gameId: string) {
  return restCall(() =>
    lichess.GET("/game/export/{gameId}", {
      params: { path: { gameId }, query: { pgnInJson: true } },
      headers: { ...authHeaders(), Accept: "application/json" },
    }),
  );
}

export async function boardMove(gameId: string, uci: string) {
  return restCall(() =>
    lichess.POST("/api/board/game/{gameId}/move/{move}", {
      params: { path: { gameId, move: uci } },
      headers: authHeaders(),
    }),
  );
}

export async function boardResign(gameId: string) {
  return restCall(() =>
    lichess.POST("/api/board/game/{gameId}/resign", {
      params: { path: { gameId } },
      headers: authHeaders(),
    }),
  );
}

export async function boardAbort(gameId: string) {
  return restCall(() =>
    lichess.POST("/api/board/game/{gameId}/abort", {
      params: { path: { gameId } },
      headers: authHeaders(),
    }),
  );
}
