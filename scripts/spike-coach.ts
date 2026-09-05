/* spike-coach.ts — THE highest-risk M1 spike (PLAN.md risk #1).
   Proves: the Claude Agent SDK runs headless inside the linux/arm64 container,
   authenticated by the Max-subscription token (CLAUDE_CODE_OAUTH_TOKEN), with
   settingSources: [] and a writable $HOME — one prompt in, one text reply out.
   Fallback if this fails: install @anthropic-ai/claude-code globally in the
   image and point options.pathToClaudeCodeExecutable at it.
   Run in-container: npx tsx scripts/spike-coach.ts */
import fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

async function main() {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "SPIKE BLOCKED: CLAUDE_CODE_OAUTH_TOKEN is not set.\n" +
        "Run `claude setup-token` on the host and put the token in .env.",
    );
    process.exit(2);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.error(
      "SPIKE BLOCKED: ANTHROPIC_API_KEY is set — it takes precedence over the " +
        "Max token and would bill the pay-per-token API. Unset it.",
    );
    process.exit(2);
  }

  const cwd = process.env.AGENT_CWD ?? "/data/agent";
  fs.mkdirSync(cwd, { recursive: true });
  const model = process.env.COACH_MODEL ?? "sonnet";
  console.log(`querying model "${model}" headless (cwd=${cwd}, HOME=${process.env.HOME})...`);
  const started = Date.now();

  for await (const message of query({
    prompt:
      "In one sentence: what is the best opening square for White's king knight, and why?",
    options: {
      systemPrompt:
        "You are a concise chess coach. Reply with plain text only — one sentence, no tools.",
      maxTurns: 1,
      settingSources: [],
      allowedTools: [],
      model,
      cwd,
    },
  })) {
    console.log(`  [sdk message] type=${message.type}`);
    if (message.type === "result") {
      const elapsed = Date.now() - started;
      if (message.subtype === "success") {
        console.log(`\n=== CLAUDE REPLY (${elapsed}ms) ===\n${message.result}\n`);
        console.log(`usage: ${JSON.stringify(message.usage ?? {})}`);
        console.log("SPIKE COACH: OK");
        process.exit(0);
      }
      console.error(
        `SPIKE FAILED: result subtype=${message.subtype}\n` +
          JSON.stringify(message, null, 2),
      );
      process.exit(1);
    }
  }

  console.error("SPIKE FAILED: stream ended without a result message");
  process.exit(1);
}

main().catch((error) => {
  console.error("SPIKE FAILED:", error);
  process.exit(1);
});
