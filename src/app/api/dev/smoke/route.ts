import fs from "node:fs";
import { NextResponse } from "next/server";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

// Amendment A5: throwaway M1 route proving better-sqlite3 AND the Agent SDK
// work inside the real Next.js runtime (serverExternalPackages), not only via
// tsx. Dev-only; delete once M3's coach service covers the same path.
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "dev only" }, { status: 404 });
  }

  const gamesInDb = db.select().from(games).all().length;

  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return NextResponse.json({
      db: { ok: true, games: gamesInDb },
      claude: "skipped: CLAUDE_CODE_OAUTH_TOKEN not set",
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        db: { ok: true, games: gamesInDb },
        claude:
          "blocked: ANTHROPIC_API_KEY is set — it outranks the Max token and would bill the API",
      },
      { status: 500 },
    );
  }

  const cwd = "/data/agent";
  fs.mkdirSync(cwd, { recursive: true });
  const started = Date.now();
  let claude = "no result message";
  try {
    for await (const message of query({
      prompt: "Reply with exactly one word: pong",
      options: {
        systemPrompt: "Reply with plain text only.",
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        model: getEnv().COACH_MODEL,
        cwd,
      },
    })) {
      if (message.type === "result") {
        claude =
          message.subtype === "success"
            ? message.result
            : `error: ${message.subtype}`;
      }
    }
  } catch (error) {
    claude = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }

  return NextResponse.json({
    db: { ok: true, games: gamesInDb },
    claude,
    latencyMs: Date.now() - started,
  });
}
