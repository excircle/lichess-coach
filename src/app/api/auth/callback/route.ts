import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { db } from "@/lib/db";
import { credentials } from "@/lib/db/schema";
import { getAccount } from "@/lib/lichess/client";
import { ensureEventStream } from "@/lib/lichess/events";
import { exchangeCode, LICHESS_SCOPES } from "@/lib/lichess/oauth";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const env = getEnv();
  const session = await getSession();
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const saved = session.oauth;
  session.oauth = undefined;

  if (!code || !state || !saved || saved.state !== state) {
    await session.save();
    return NextResponse.redirect(new URL("/?error=oauth_state", env.APP_URL));
  }

  const token = await exchangeCode(code, saved.verifier);
  const account = await getAccount(token.access_token);

  db.insert(credentials)
    .values({
      id: 1,
      lichessToken: token.access_token,
      lichessUserId: account.id,
      scopes: LICHESS_SCOPES,
    })
    .onConflictDoUpdate({
      target: credentials.id,
      set: {
        lichessToken: token.access_token,
        lichessUserId: account.id,
        scopes: LICHESS_SCOPES,
      },
    })
    .run();

  session.username = account.username;
  session.lichessUserId = account.id;
  await session.save();

  // Amendment A3: on a fresh install nothing else starts the event stream —
  // credentials only exist from this point on.
  ensureEventStream();

  return NextResponse.redirect(new URL("/", env.APP_URL));
}
