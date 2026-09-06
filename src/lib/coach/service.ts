import fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { COACH_SYSTEM_PROMPT } from "./prompts";

// Stateless per-request query() — no session resume in V1 (PLAN.md): each call
// carries its own bounded ~1.2K-token context, so it's cheap and retryable.

export class CoachUnavailableError extends Error {}

const AGENT_CWD = "/data/agent";

export interface CoachReply {
  content: string;
  model: string;
  latencyMs: number;
}

export async function requestCoachText(
  prompt: string,
  opts: {
    abortController?: AbortController;
    systemPrompt?: string; // defaults to the live-coach persona
    model?: string; // defaults to COACH_MODEL
  } = {},
): Promise<CoachReply> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new CoachUnavailableError("CLAUDE_CODE_OAUTH_TOKEN not set");
  }
  if (process.env.ANTHROPIC_API_KEY) {
    // Never let a stray API key hijack auth and bill per-token.
    throw new CoachUnavailableError("ANTHROPIC_API_KEY is set — refusing (would bypass Max subscription)");
  }
  fs.mkdirSync(AGENT_CWD, { recursive: true });
  const model = opts.model ?? process.env.COACH_MODEL ?? "sonnet";
  const started = Date.now();

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: opts.systemPrompt ?? COACH_SYSTEM_PROMPT,
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      model,
      cwd: AGENT_CWD,
      abortController: opts.abortController,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        return {
          content: message.result.trim(),
          model,
          latencyMs: Date.now() - started,
        };
      }
      throw new CoachUnavailableError(`coach query failed: ${message.subtype}`);
    }
  }
  throw new CoachUnavailableError("coach query ended without a result");
}
