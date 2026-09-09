import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { CoachUnavailableError } from "@/lib/coach/service";
import { ensureGameManager, getGameManager, hasGameRow } from "@/lib/games/manager";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST — on-demand "Ask coach" hint (works in auto and off modes).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId } = await params;
  const manager = getGameManager(gameId) ?? ensureGameManager(gameId);
  if (!manager) {
    return NextResponse.json(
      { error: hasGameRow(gameId) ? "game is finished" : "not found" },
      { status: hasGameRow(gameId) ? 409 : 404 },
    );
  }
  try {
    const event = await manager.requestHint();
    return NextResponse.json(event);
  } catch (error) {
    if (error instanceof CoachUnavailableError) {
      return NextResponse.json(
        { error: `coach unavailable: ${error.message}` },
        { status: 503 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("in progress") ? 429 : 400 },
    );
  }
}

const modeSchema = z.object({ mode: z.enum(["auto", "off"]) });

// PUT — toggle coach mode; persisted and enforced server-side.
export async function PUT(
  request: Request,
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
  const parsed = modeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "mode must be auto|off" }, { status: 400 });
  }
  const manager = getGameManager(gameId);
  if (manager) {
    manager.setCoachMode(parsed.data.mode);
  } else {
    db.update(games)
      .set({ coachMode: parsed.data.mode })
      .where(eq(games.id, gameId))
      .run();
  }
  return NextResponse.json({ ok: true, mode: parsed.data.mode });
}
