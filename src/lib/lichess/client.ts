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
      throw new Error(
        `Lichess ${response.status} ${response.url}: ${JSON.stringify(error ?? "empty body")}`,
      );
    }
    return data;
  });
}

export async function getAccount(tokenOverride?: string) {
  return restCall(() =>
    lichess.GET("/api/account", { headers: authHeaders(tokenOverride) }),
  );
}
