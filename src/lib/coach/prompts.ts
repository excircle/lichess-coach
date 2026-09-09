import { formatEval } from "@/lib/chess";
import type { BookSource, Judgment } from "@/lib/games/types";

// All evals in prompts are WHITE POV strings ("+1.20" favors White) — the
// system prompt tells Claude to interpret them for the student's color.

export const COACH_SYSTEM_PROMPT = `You are a sharp, encouraging chess coach. Your student plays casual games against Stockfish AI on Lichess and you comment live between moves.

GROUNDING RULE (non-negotiable): every tactical or evaluative claim must be consistent with the Stockfish evaluations and lines provided in the message. Do not invent variations beyond the given engine lines; if the engine data doesn't support a claim, don't make it. When unsure, defer to the engine. All evals are from White's point of view ("+" favors White) — translate to the student's perspective when you speak.

Style: plain text only (no markdown, no tools). Talk to the student directly ("you"). Be concrete: name squares, pieces, and the engine's moves in SAN. One or two ideas max — never a lecture.`;

// Opening study persona (PLAN OS §5.4): same coach, but grounded in the book
// list instead of engine preference — theory is the point of this mode (D5).
export const OPENING_SYSTEM_PROMPT = `You are a sharp, encouraging chess coach teaching opening theory. Your student plays casual games against Stockfish AI on Lichess in "Opening study" mode, and you explain the book as the opening unfolds.

BOOK RULE (non-negotiable): the message lists the book moves for the current position from a master/Lichess database. You may recommend ONLY a move from that list, and you must name the list's top move as the main recommendation unless the engine data shows it loses material. You may describe the strategic idea of the opening in general terms (piece placement, pawn breaks, typical plans), but every concrete move you mention must come from either the book list or the engine lines provided.

All evals are from White's point of view ("+" favors White) — translate to the student's perspective when you speak.

Style: plain text only (no markdown, no tools). Talk to the student directly ("you"). Name moves in SAN. One or two ideas max — never a lecture.`;

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
  // OS-D6: set only on the FIRST out-of-book cycle in opening mode, e.g.
  // "The game has just left opening theory after 9…Nh5; the last book
  // position was C50 Italian Game. Mention this in one clause."
  leftBookNote?: string;
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
${missed}${ctx.leftBookNote ? `${ctx.leftBookNote}\n` : ""}Stockfish replied ${ctx.aiMoveLabel}. Current eval: ${ctx.evalCurrent}
Current position (student to move), FEN: ${ctx.fen}
Engine's top lines from here:
${lines || "  (terminal position)"}

${prior}Coach this move cycle in AT MOST 60 words: react to the student's move (if it was a mistake, say what the engine shows was wrong and name the better move), then one forward-looking pointer for the current position — hint at the idea, don't dictate the exact move unless a tactic forces it.`;
}

// PLAN OS §5.4 — one prompt per move cycle while the position has book moves
// (replaces the auto prompt in that cycle, never runs in addition — D7).
export interface OpeningPromptContext {
  userColor: "white" | "black";
  aiLevel: number | null;
  phase: string;
  movetextSan: string;
  fen: string; // current position, student to move
  eco: string | null;
  name: string | null;
  source: BookSource;
  // null at ply 0/1 (no student move yet this game)
  studentLastMove: { label: string; inBook: boolean; bookAlternatives: string[] } | null;
  aiLastMove: { label: string; inBook: boolean } | null;
  leftBookNow: boolean; // student's last move was the first out-of-book move
  bookMoves: {
    san: string;
    games: number;
    wdl: { win: number; draw: number; loss: number }; // student POV, percentages
    leadsTo: string | null;
  }[];
  engineLines: { san: string; eval: string }[]; // may be [] at ply 0
  lastComments: string[];
}

export function buildOpeningPrompt(ctx: OpeningPromptContext): string {
  const openingLabel =
    ctx.name != null ? `${ctx.eco ? `${ctx.eco} ` : ""}${ctx.name}` : "(not yet named)";
  const bookLines = ctx.bookMoves
    .map(
      (m, i) =>
        `  ${i + 1}. ${m.san} — ${m.games} games, your W/D/L ${m.wdl.win}/${m.wdl.draw}/${m.wdl.loss}%${m.leadsTo ? `, leads to ${m.leadsTo}` : ""}`,
    )
    .join("\n");
  const student = ctx.studentLastMove
    ? `Student's last move: ${ctx.studentLastMove.label} — ${
        ctx.studentLastMove.inBook
          ? "in book"
          : `NOT in book (book was: ${ctx.studentLastMove.bookAlternatives.join(", ") || "—"})`
      }\n`
    : "";
  const ai = ctx.aiLastMove
    ? `Stockfish's last move: ${ctx.aiLastMove.label} — ${ctx.aiLastMove.inBook ? "in book" : "not in book"}\n`
    : "";
  const left = ctx.leftBookNow
    ? "The student's move just left opening theory, but the current position still has book moves.\n"
    : "";
  const engine = ctx.engineLines.length
    ? `Engine's top lines from here:\n${ctx.engineLines
        .map((l, i) => `  ${i + 1}. (${l.eval}) ${l.san}`)
        .join("\n")}\n`
    : "";
  const prior =
    ctx.lastComments.length > 0
      ? `Your previous comments (don't repeat yourself):\n${ctx.lastComments.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `Student plays ${ctx.userColor} vs Stockfish level ${ctx.aiLevel ?? "?"} in Opening study mode. Phase: ${ctx.phase}.
Game so far: ${ctx.movetextSan || "(game start)"}
Current opening: ${openingLabel} (book source: ${ctx.source} database)
Current position (student to move), FEN: ${ctx.fen}
${student}${ai}${left}Book moves in the current position, ranked by games played:
${bookLines}
${engine}
${prior}Coach this move cycle in AT MOST 70 words: (1) name the opening/variation and its one-sentence idea; (2) if the student's last move left book, say which book move was expected and why it matters; (3) recommend the top book move${ctx.bookMoves[0] ? ` (${ctx.bookMoves[0].san})` : ""} and the plan behind it. This is study, not a hint — naming the recommended move explicitly is wanted.`;
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
