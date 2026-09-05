import { NextResponse } from "next/server";
import { authorizeUrl, generatePkce } from "@/lib/lichess/oauth";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  const { verifier, state, challenge } = generatePkce();
  session.oauth = { verifier, state };
  await session.save();
  return NextResponse.redirect(authorizeUrl(challenge, state));
}
