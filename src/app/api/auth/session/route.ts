import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    username: session.username ?? null,
    lichessUserId: session.lichessUserId ?? null,
  });
}
