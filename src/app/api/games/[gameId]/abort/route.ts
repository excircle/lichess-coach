import { NextResponse } from "next/server";
import { hasGameRow } from "@/lib/games/manager";
import { boardAbort } from "@/lib/lichess/client";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId } = await params;
  if (!hasGameRow(gameId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await boardAbort(gameId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
