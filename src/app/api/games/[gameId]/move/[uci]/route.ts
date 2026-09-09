import { NextResponse } from "next/server";
import { hasGameRow } from "@/lib/games/manager";
import { boardMove } from "@/lib/lichess/client";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ gameId: string; uci: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId, uci } = await params;
  if (!UCI_RE.test(uci)) {
    return NextResponse.json({ error: `invalid uci: ${uci}` }, { status: 400 });
  }
  if (!hasGameRow(gameId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await boardMove(gameId, uci);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
