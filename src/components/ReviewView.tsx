"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatEval } from "@/lib/chess";
import type { GameSnapshot, SnapshotMove } from "@/lib/games/types";

interface KeyMoment {
  ply: number;
  title: string;
  motifs: string[];
}

interface ReviewData {
  status: "none" | "pending" | "analyzing" | "generating" | "complete" | "failed";
  contentMd?: string | null;
  keyMoments?: KeyMoment[] | null;
  accuracy?: number | null;
  error?: string | null;
  model?: string | null;
}

const RUNNING = new Set(["pending", "analyzing", "generating"]);

export default function ReviewView({
  gameId,
  initialSnapshot,
}: {
  gameId: string;
  initialSnapshot: GameSnapshot;
}) {
  const queryClient = useQueryClient();
  const [retryError, setRetryError] = useState<string | null>(null);

  const review = useQuery({
    queryKey: ["review", gameId],
    queryFn: async (): Promise<ReviewData> => {
      const res = await fetch(`/api/games/${gameId}/review`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: (query) =>
      query.state.data && RUNNING.has(query.state.data.status) ? 2_500 : false,
  });

  // Refresh annotations once the deep analysis finishes.
  const detail = useQuery({
    queryKey: ["game", gameId, review.data?.status === "complete"],
    queryFn: async (): Promise<GameSnapshot> => {
      const res = await fetch(`/api/games/${gameId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    initialData: initialSnapshot,
  });
  const snapshot = detail.data;

  const generate = async () => {
    setRetryError(null);
    const res = await fetch(`/api/games/${gameId}/review`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setRetryError(body.error ?? "failed to start review");
    }
    void queryClient.invalidateQueries({ queryKey: ["review", gameId] });
  };

  const status = review.data?.status ?? "loading";
  const { game } = snapshot;
  const outcome =
    game.winner == null
      ? (game.result ?? game.status)
      : game.winner === game.userColor
        ? `You won ${game.result}`
        : `You lost ${game.result}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded-full border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          {outcome} ({game.status})
        </span>
        <span className="rounded-full border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          vs Stockfish level {game.aiLevel ?? "?"} · you played {game.userColor}
        </span>
        {review.data?.accuracy != null && (
          <span className="rounded-full border border-emerald-400 bg-emerald-50 px-3 py-1 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            Accuracy {review.data.accuracy.toFixed(1)}
          </span>
        )}
      </div>

      {RUNNING.has(status) && (
        <div className="rounded-xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
          <p className="font-medium">
            {status === "generating"
              ? "Claude is writing your review…"
              : "Stockfish is analyzing every move (depth 18)…"}
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            This usually takes a minute or two. The page updates by itself.
          </p>
        </div>
      )}

      {status === "failed" && (
        <div className="rounded-xl border border-red-300 p-6 text-center dark:border-red-900">
          <p className="font-medium text-red-600">Review failed</p>
          <p className="mt-1 text-sm text-neutral-500">{review.data?.error}</p>
          <button
            onClick={generate}
            className="mt-3 rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Retry review
          </button>
        </div>
      )}

      {status === "none" && (
        <div className="rounded-xl border border-neutral-200 p-6 text-center dark:border-neutral-800">
          <p className="text-sm text-neutral-500">No review yet for this game.</p>
          <button
            onClick={generate}
            className="mt-3 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Generate review
          </button>
        </div>
      )}
      {retryError && <p className="text-sm text-red-600">{retryError}</p>}

      {status === "complete" && review.data?.contentMd && (
        <article className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
          <MiniMarkdown text={review.data.contentMd} />
        </article>
      )}

      {status === "complete" &&
        review.data?.keyMoments &&
        review.data.keyMoments.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold">Key moments</h2>
            <ul className="space-y-2">
              {review.data.keyMoments.map((k) => {
                const move = snapshot.moves[k.ply - 1];
                return (
                  <li
                    key={k.ply}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800"
                  >
                    <a
                      className="font-mono underline-offset-4 hover:underline"
                      href={`https://lichess.org/${gameId}#${k.ply}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {move ? moveRef(move) : `ply ${k.ply}`}
                    </a>
                    <span>{k.title}</span>
                    {k.motifs.map((m) => (
                      <span
                        key={m}
                        className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
                      >
                        {m}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

      <section>
        <h2 className="mb-2 font-semibold">Moves</h2>
        <AnnotatedMoves moves={snapshot.moves} />
      </section>
    </div>
  );
}

function moveRef(move: SnapshotMove): string {
  return `${Math.ceil(move.ply / 2)}${move.color === "white" ? "." : "…"}${move.san}`;
}

const GLYPHS: Record<string, { text: string; className: string }> = {
  blunder: { text: "??", className: "text-red-600" },
  mistake: { text: "?", className: "text-orange-500" },
  inaccuracy: { text: "?!", className: "text-yellow-600" },
};

function AnnotatedMoves({ moves }: { moves: SnapshotMove[] }) {
  const rows: { num: number; white?: SnapshotMove; black?: SnapshotMove }[] = [];
  for (const move of moves) {
    const num = Math.ceil(move.ply / 2);
    if (move.color === "white") rows.push({ num, white: move });
    else {
      const row = rows[rows.length - 1];
      if (row && row.num === num && !row.black) row.black = move;
      else rows.push({ num, black: move });
    }
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.num}
              className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
            >
              <td className="w-10 py-1 pr-2 text-right text-neutral-400">
                {row.num}.
              </td>
              <AnnotatedCell move={row.white} />
              <AnnotatedCell move={row.black} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnnotatedCell({ move }: { move?: SnapshotMove }) {
  if (!move) return <td colSpan={2} />;
  const glyph = move.judgment ? GLYPHS[move.judgment] : undefined;
  return (
    <>
      <td className="w-24 py-1 font-medium">
        {move.san}
        {glyph && <span className={glyph.className}>{glyph.text}</span>}
      </td>
      <td className="w-20 py-1 font-mono text-xs text-neutral-500">
        {move.winPct != null
          ? formatEval(move.evalCp ?? null, move.evalMate ?? null)
          : ""}
      </td>
    </>
  );
}

// Renders the constrained markdown the review prompt allows: ## headers,
// "- " bullets, plain paragraphs, and _italic-only_ lines.
function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bullets.length > 0) {
      out.push(
        <ul key={key++} className="mb-3 list-disc space-y-1 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const joined = paragraph.join(" ");
      const italic = /^_.*_$/.test(joined.trim());
      out.push(
        <p key={key++} className={`mb-3 leading-relaxed ${italic ? "italic text-neutral-500" : ""}`}>
          {italic ? joined.trim().slice(1, -1) : joined}
        </p>,
      );
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flushBullets();
      flushParagraph();
      out.push(
        <h2 key={key++} className="mb-2 mt-5 text-lg font-semibold first:mt-0">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.trimStart().startsWith("- ")) {
      flushParagraph();
      bullets.push(line.trimStart().slice(2));
    } else if (line.trim() === "") {
      flushBullets();
      flushParagraph();
    } else {
      flushBullets();
      paragraph.push(line.trim());
    }
  }
  flushBullets();
  flushParagraph();
  return <>{out}</>;
}
