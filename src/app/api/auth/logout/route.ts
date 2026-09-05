import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Clears the browser session only. The stored Lichess token stays in the DB so
// server-side streams keep working (single-user app).
export async function POST() {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/", getEnv().APP_URL), 303);
}
