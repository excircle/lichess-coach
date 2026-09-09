import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { ensureGameManager } from "@/lib/games/manager";
import { challengeAi } from "@/lib/lichess/client";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  level: z.number().int().min(1).max(8),
  // Board API vs AI: blitz or slower — no bullet (PLAN.md locked decision).
  // null clock = unlimited (casual correspondence game, allowed vs AI).
  clockLimit: z.number().int().min(180).max(10800).nullable(),
  clockIncrement: z.number().int().min(0).max(60).nullable(),
  color: z.enum(["white", "black", "random"]).default("white"),
  coachMode: z.enum(["auto", "opening", "off"]).default("auto"),
});

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid game parameters", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const p = parsed.data;

  let created;
  try {
    created = await challengeAi({
      level: p.level,
      clockLimit: p.clockLimit ?? undefined,
      clockIncrement: p.clockLimit != null ? (p.clockIncrement ?? 0) : undefined,
      color: p.color,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Lichess challenge failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
  if (!created.id) {
    return NextResponse.json(
      { error: "Lichess did not return a game id" },
      { status: 502 },
    );
  }

  const userColor =
    created.player === "white" || created.player === "black"
      ? created.player
      : p.color === "black"
        ? "black"
        : "white";

  db.insert(games)
    .values({
      id: created.id,
      fullId: created.fullId ?? null,
      userColor,
      aiLevel: p.level,
      speed: created.speed ?? null,
      clockInitial: p.clockLimit,
      clockIncrement: p.clockIncrement,
      status: "created",
      coachMode: p.coachMode,
    })
    .onConflictDoNothing()
    .run();

  // Amendment A3: attach the manager directly — don't depend on the
  // gameStart event arriving.
  ensureGameManager(created.id);

  return NextResponse.json({ gameId: created.id }, { status: 201 });
}

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = db.select().from(games).orderBy(desc(games.createdAt)).limit(50).all();
  return NextResponse.json({ games: rows });
}
