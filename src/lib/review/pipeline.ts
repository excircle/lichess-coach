import { and, eq } from "drizzle-orm";
import { Chess } from "chess.js";
import { z } from "zod";
import {
  accuracyFromDrop,
  formatEval,
  judgmentFromDrop,
  newGameFromFen,
  toWhitePov,
  uciLineToSan,
  winPctDrop,
  winPctFromEval,
} from "@/lib/chess";
import { CoachUnavailableError, requestCoachText } from "@/lib/coach/service";
import { db } from "@/lib/db";
import { games, moves as movesTable, reviews } from "@/lib/db/schema";
import { isTerminalStatus, type Judgment } from "@/lib/games/types";
import { exportGame } from "@/lib/lichess/client";
import { evalBatch } from "@/lib/stockfish/service";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./prompts";

// ---------------------------------------------------------------------------
// Post-game review pipeline (PLAN.md M4). In-process async job guarded by the
// reviews.status machine: pending → analyzing → generating → complete|failed.
// Idempotent: triggered from GameManager.finish() AND the gameFinish event
// (amendment A2); an in-process set prevents double-runs, boot recovery resets
// stale analyzing/generating rows from a dead process back to pending.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __reviewJobs?: Set<string> };
const jobs = (g.__reviewJobs ??= new Set<string>());

export function isReviewRunning(gameId: string): boolean {
  return jobs.has(gameId);
}

// Fire-and-forget, safe to call repeatedly.
export function triggerReview(gameId: string): void {
  if (jobs.has(gameId)) return;
  const game = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!game || !isTerminalStatus(game.status)) return;

  db.insert(reviews).values({ gameId, status: "pending" }).onConflictDoNothing().run();
  const row = db.select().from(reviews).where(eq(reviews.gameId, gameId)).get();
  if (!row || (row.status !== "pending" && row.status !== "failed")) return;

  jobs.add(gameId);
  void runReviewJob(gameId)
    .catch((error) => {
      console.error(`[review ${gameId}] job crashed:`, error);
      setStatus(gameId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => jobs.delete(gameId));
}

// Boot recovery (amendment A2): rows stuck mid-flight from a dead process.
export function recoverStaleReviews(): number {
  const stale = db
    .select({ gameId: reviews.gameId, status: reviews.status })
    .from(reviews)
    .all()
    .filter((r) => r.status === "analyzing" || r.status === "generating");
  for (const r of stale) {
    db.update(reviews)
      .set({ status: "pending", error: null })
      .where(eq(reviews.gameId, r.gameId))
      .run();
    triggerReview(r.gameId);
  }
  return stale.length;
}

function setStatus(
  gameId: string,
  status: "pending" | "analyzing" | "generating" | "complete" | "failed",
  extra: Partial<{
    contentMd: string | null;
    keyMoments: string | null;
    accuracy: number | null;
    error: string | null;
    model: string | null;
    completedAt: Date | null;
  }> = {},
): void {
  db.update(reviews).set({ status, ...extra }).where(eq(reviews.gameId, gameId)).run();
}

const keyMomentsSchema = z.object({
  key_moments: z
    .array(
      z.object({
        ply: z.number().int().min(1),
        title: z.string().min(1),
        motifs: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

async function runReviewJob(gameId: string): Promise<void> {
  const game = db.select().from(games).where(eq(games.id, gameId)).get();
  if (!game) throw new Error("game row disappeared");

  setStatus(gameId, "analyzing", { error: null });
  console.log(`[review ${gameId}] analyzing`);

  // 1. Post-game export: authoritative PGN + opening (tolerate failure).
  try {
    const exported = await exportGame(gameId);
    const opening = (exported as { opening?: { eco?: string; name?: string } }).opening;
    const pgn = (exported as { pgn?: string }).pgn;
    db.update(games)
      .set({
        pgn: pgn ?? game.pgn,
        openingEco: opening?.eco ?? game.openingEco,
        openingName: opening?.name ?? game.openingName,
      })
      .where(eq(games.id, gameId))
      .run();
  } catch (error) {
    console.warn(`[review ${gameId}] export fetch failed (continuing):`, error);
  }

  const moveRows = db
    .select()
    .from(movesTable)
    .where(eq(movesTable.gameId, gameId))
    .orderBy(movesTable.ply)
    .all();

  // Aborted / near-empty games: stub review, no engine or Claude spend.
  if (game.result === "aborted" || moveRows.length < 4) {
    setStatus(gameId, "complete", {
      contentMd:
        "_Game too short for a review (aborted or under two full moves)._",
      keyMoments: JSON.stringify([]),
      accuracy: null,
      completedAt: new Date(),
    });
    console.log(`[review ${gameId}] complete (stub — too short)`);
    return;
  }

  // 2. Deep batch evals, sequential so each move's drop uses its predecessor.
  const startTurn: "white" | "black" =
    game.initialFen && game.initialFen.split(" ")[1] === "b" ? "black" : "white";
  const startFen = newGameFromFen(game.initialFen).fen();

  const startEval = await evalBatch(startFen);
  let prev = whitePovOf(startFen, startEval, startTurn === "white" ? "black" : "white");

  const annotated: string[] = [];
  const judgmentCounts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  const userAccuracies: number[] = [];
  let prevFen = startFen;
  let prevBestUci = startEval.bestMoveUci;

  for (const row of moveRows) {
    const color: "white" | "black" =
      (row.ply % 2 === 1) === (startTurn === "white") ? "white" : "black";
    const result = await evalBatch(row.fenAfter);
    const current = whitePovOf(row.fenAfter, result, color);

    let drop: number | null = null;
    let judgment: Judgment | null = null;
    let cpLoss: number | null = null;
    if (current.winPct != null && prev.winPct != null) {
      drop = winPctDrop(prev.winPct, current.winPct, color);
      judgment = judgmentFromDrop(drop);
    }
    if (prev.cp != null && current.cp != null) {
      cpLoss = Math.max(
        0,
        Math.round(color === "white" ? prev.cp - current.cp : current.cp - prev.cp),
      );
    }

    db.update(movesTable)
      .set({
        evalCp: current.cp,
        evalMate: current.mate,
        evalDepth: result.lines[0]?.depth ?? null,
        winPct: current.winPct,
        cpLoss,
        judgment,
        bestMoveUci: result.bestMoveUci,
        bestLineUci: result.lines[0] ? result.lines[0].pvUci.join(" ") : null,
      })
      .where(and(eq(movesTable.gameId, gameId), eq(movesTable.ply, row.ply)))
      .run();

    if (row.isUserMove) {
      if (judgment && judgment !== "good") judgmentCounts[judgment] += 1;
      if (drop != null) userAccuracies.push(accuracyFromDrop(drop));
    }

    // Annotated movetext line for Claude.
    const num = Math.ceil(row.ply / 2);
    const prefix = color === "white" ? `${num}. ` : row.ply === moveRows[0].ply ? `${num}... ` : "";
    let note = ` (${formatEval(current.cp, current.mate)}`;
    if (row.isUserMove && judgment && judgment !== "good") {
      note += `, ${judgment}`;
      if (prevBestUci) {
        const bestSan = uciLineToSan(prevFen, [prevBestUci], 1);
        if (bestSan && bestSan !== row.san) note += `, best: ${bestSan}`;
      }
    }
    note += ")";
    annotated.push(`${prefix}${row.san}${note}`);

    prev = current;
    prevFen = row.fenAfter;
    prevBestUci = result.bestMoveUci;
  }

  const accuracy =
    userAccuracies.length > 0
      ? userAccuracies.reduce((a, b) => a + b, 0) / userAccuracies.length
      : null;

  // 3. Claude writes the review.
  setStatus(gameId, "generating", { accuracy });
  console.log(`[review ${gameId}] generating (accuracy=${accuracy?.toFixed(1)})`);

  const model = process.env.REVIEW_MODEL ?? "sonnet";
  const opening =
    [game.openingEco, game.openingName].filter(Boolean).join(" ") || null;
  const prompt = buildReviewPrompt({
    userColor: game.userColor,
    aiLevel: game.aiLevel,
    result: game.result,
    status: game.status,
    speed: game.speed,
    opening,
    accuracy,
    judgmentCounts,
    annotatedMovetext: annotated.join(" "),
    plyCount: moveRows.length,
  });

  let reply;
  try {
    reply = await requestCoachText(prompt, {
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      model,
    });
  } catch (error) {
    const message =
      error instanceof CoachUnavailableError
        ? `Claude unavailable: ${error.message}`
        : `review generation failed: ${error instanceof Error ? error.message : String(error)}`;
    setStatus(gameId, "failed", { error: message, model });
    console.warn(`[review ${gameId}] ${message}`);
    return;
  }

  // 4. Parse: markdown body + trailing fenced JSON key moments.
  const { contentMd, keyMoments } = parseReview(reply.content, moveRows.length);
  if (keyMoments) {
    for (const moment of keyMoments) {
      if (moment.motifs.length > 0) {
        db.update(movesTable)
          .set({ motifTags: JSON.stringify(moment.motifs) })
          .where(and(eq(movesTable.gameId, gameId), eq(movesTable.ply, moment.ply)))
          .run();
      }
    }
  }

  setStatus(gameId, "complete", {
    contentMd,
    keyMoments: JSON.stringify(keyMoments ?? []),
    accuracy,
    model,
    error: null,
    completedAt: new Date(),
  });
  console.log(`[review ${gameId}] complete (${reply.latencyMs}ms claude)`);
}

function whitePovOf(
  fen: string,
  result: { bestMoveUci: string | null; lines: { cp: number | null; mate: number | null }[] },
  moverColor: "white" | "black",
): { cp: number | null; mate: number | null; winPct: number | null } {
  const top = result.lines[0];
  if (top) {
    const white = toWhitePov(fen, { cp: top.cp, mate: top.mate });
    return { ...white, winPct: winPctFromEval(white.cp, white.mate) };
  }
  if (result.bestMoveUci == null) {
    const pos = new Chess(fen);
    if (pos.isCheckmate()) {
      return { cp: null, mate: null, winPct: moverColor === "white" ? 100 : 0 };
    }
    return { cp: null, mate: null, winPct: 50 }; // stalemate/draw
  }
  return { cp: null, mate: null, winPct: null };
}

function parseReview(
  text: string,
  maxPly: number,
): {
  contentMd: string;
  keyMoments: { ply: number; title: string; motifs: string[] }[] | null;
} {
  const fenced = /```json\s*([\s\S]*?)```/g;
  let lastMatch: RegExpExecArray | null = null;
  for (let m = fenced.exec(text); m; m = fenced.exec(text)) lastMatch = m;
  if (!lastMatch) return { contentMd: text.trim(), keyMoments: null };

  const contentMd = (
    text.slice(0, lastMatch.index) + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();
  try {
    const parsed = keyMomentsSchema.parse(JSON.parse(lastMatch[1]));
    const keyMoments = parsed.key_moments.filter((k) => k.ply <= maxPly);
    return { contentMd, keyMoments };
  } catch (error) {
    console.warn("[review] key_moments JSON parse failed:", error);
    return { contentMd, keyMoments: null };
  }
}
