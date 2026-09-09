import { NextResponse } from "next/server";
import { buildDbSnapshot } from "@/lib/games/manager";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId } = await params;
  const snapshot = buildDbSnapshot(gameId);
  if (!snapshot) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
