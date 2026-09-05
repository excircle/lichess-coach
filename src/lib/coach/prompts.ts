import { formatEval } from "@/lib/chess";
import type { Judgment } from "@/lib/games/types";

// All evals in prompts are WHITE POV strings ("+1.20" favors White) — the
// system prompt tells Claude to interpret them for the student's color.

export const COACH_SYSTEM_PROMPT = `You are a sharp, encouraging chess coach. Your student plays casual games against Stockfish AI on Lichess and you comment live between moves.

GROUNDING RULE (non-negotiable): every tactical or evaluative claim must be consistent with the Stockfish evaluations and lines provided in the message. Do not invent variations beyond the given engine lines; if the engine data doesn't support a claim, don't make it. When unsure, defer to the engine. All evals are from White's point of view ("+" favors White) — translate to the student's perspective when you speak.

Style: plain text only (no markdown, no tools). Talk to the student directly ("you"). Be concrete: name squares, pieces, and the engine's moves in SAN. One or two ideas max — never a lecture.`;

export interface EvalView {
  text: string; // formatted White-POV eval, e.g. "+0.34" or "#-2"
}

export interface AutoPromptContext {
  userColor: "white" | "black";
  aiLevel: number | null;
  phase: string;
  movetextSan: string; // "1. e4 e5 2. Nf3 …"
  fen: string; // current position (after AI reply), student to move
  userMoveLabel: string; // e.g. "12.Qxb7" / "12…Nf6"
  aiMoveLabel: string;
  evalBeforeUser: string | null; // null = game start
  evalAfterUser: string;
  evalCurrent: string;
  cpLoss: number | null;
  judgment: Judgment | null;
  missedBestSan: string | null; // best move the student had instead, SAN
  topLines: { san: string; eval: string }[]; // current position, student to move
  lastComments: string[];
}

export function buildAutoPrompt(ctx: AutoPromptContext): string {
  const judgmentLine =
    ctx.judgment && ctx.judgment !== "good"
      ? `${ctx.judgment.toUpperCase()}${ctx.cpLoss != null ? ` (lost ~${(ctx.cpLoss / 100).toFixed(1)} pawns)` : ""}`
      : "reasonable";
  const missed =
    ctx.missedBestSan && ctx.judgment && ctx.judgment !== "good"
      ? `Engine preferred instead of the student's move: ${ctx.missedBestSan}\n`
      : "";
  const lines = ctx.topLines
    .map((l, i) => `  ${i + 1}. (${l.eval}) ${l.san}`)
    .join("\n");
  const prior =
    ctx.lastComments.length > 0
      ? `Your previous comments (don't repeat yourself):\n${ctx.lastComments.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `Student plays ${ctx.userColor} vs Stockfish level ${ctx.aiLevel ?? "?"}. Phase: ${ctx.phase}.
Game so far: ${ctx.movetextSan || "(game start)"}

Student's last move: ${ctx.userMoveLabel} — ${judgmentLine}
Eval ${ctx.evalBeforeUser ? `before it: ${ctx.evalBeforeUser}, ` : ""}after it: ${ctx.evalAfterUser}
${missed}Stockfish replied ${ctx.aiMoveLabel}. Current eval: ${ctx.evalCurrent}
Current position (student to move), FEN: ${ctx.fen}
Engine's top lines from here:
${lines || "  (terminal position)"}

${prior}Coach this move cycle in AT MOST 60 words: react to the student's move (if it was a mistake, say what the engine shows was wrong and name the better move), then one forward-looking pointer for the current position — hint at the idea, don't dictate the exact move unless a tactic forces it.`;
}

export interface HintPromptContext {
  userColor: "white" | "black";
  aiLevel: number | null;
  phase: string;
  movetextSan: string;
  fen: string;
  evalCurrent: string;
  topLines: { san: string; eval: string }[];
  lastComments: string[];
}

export function buildHintPrompt(ctx: HintPromptContext): string {
  const lines = ctx.topLines
    .map((l, i) => `  ${i + 1}. (${l.eval}) ${l.san}`)
    .join("\n");
  const prior =
    ctx.lastComments.length > 0
      ? `Your previous comments:\n${ctx.lastComments.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";
  return `Student plays ${ctx.userColor} vs Stockfish level ${ctx.aiLevel ?? "?"} and pressed "Ask coach". Phase: ${ctx.phase}.
Game so far: ${ctx.movetextSan || "(game start)"}
Current position (student to move), FEN: ${ctx.fen}
Current eval: ${ctx.evalCurrent}
Engine's top lines:
${lines || "  (no lines — terminal position)"}

${prior}Give a hint in AT MOST 100 words: guide their thinking (threats, weak squares, piece activity, candidate ideas) grounded in the engine lines above. Reveal the concrete best move ONLY if the position is tactically forced (a piece hangs, mate threat, forced sequence) — otherwise nudge, don't spoil.`;
}

export function evalText(cp: number | null, mate: number | null): string {
  return formatEval(cp, mate);
}
