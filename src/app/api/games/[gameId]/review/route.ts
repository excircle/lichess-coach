import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { games, reviews } from "@/lib/db/schema";
import { isTerminalStatus } from "@/lib/games/types";
import { isReviewRunning, triggerReview } from "@/lib/review/pipeline";
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
  const game = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!game) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const row = db.select().from(reviews).where(eq(reviews.gameId, gameId)).get();
  if (!row) {
    return NextResponse.json({
      status: "none",
      finished: isTerminalStatus(game.status),
    });
  }
  return NextResponse.json({
    status: row.status,
    contentMd: row.contentMd,
    keyMoments: row.keyMoments ? JSON.parse(row.keyMoments) : null,
    accuracy: row.accuracy,
    error: row.error,
    model: row.model,
    completedAt: row.completedAt,
    finished: true,
  });
}

// POST — (re)generate: allowed for finished games when no job is running and
// the review isn't already complete (covers "none", "failed", and stale rows).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { gameId } = await params;
  const game = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!game) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!isTerminalStatus(game.status)) {
    return NextResponse.json({ error: "game not finished" }, { status: 409 });
  }
  if (isReviewRunning(gameId)) {
    return NextResponse.json({ error: "review already running" }, { status: 409 });
  }
  const row = db.select().from(reviews).where(eq(reviews.gameId, gameId)).get();
  if (row?.status === "complete") {
    return NextResponse.json({ error: "review already complete" }, { status: 409 });
  }
  db.insert(reviews)
    .values({ gameId, status: "pending" })
    .onConflictDoUpdate({
      target: reviews.gameId,
      set: { status: "pending", error: null },
    })
    .run();
  triggerReview(gameId);
  return NextResponse.json({ ok: true, status: "pending" });
}
