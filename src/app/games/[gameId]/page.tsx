import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ReviewView from "@/components/ReviewView";
import { buildDbSnapshot } from "@/lib/games/manager";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function GameReviewPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const session = await getSession();
  if (!session.lichessUserId) redirect("/");

  const { gameId } = await params;
  const snapshot = buildDbSnapshot(gameId);
  if (!snapshot) notFound();

  if (!snapshot.finished) redirect(`/play/${gameId}`);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">
          Game review{" "}
          <a
            className="text-neutral-400 underline-offset-4 hover:underline"
            href={`https://lichess.org/${gameId}`}
            target="_blank"
            rel="noreferrer"
          >
            {gameId}
          </a>
        </h1>
        <Link href="/" className="text-sm underline underline-offset-4">
          ← Dashboard
        </Link>
      </div>
      <ReviewView gameId={gameId} initialSnapshot={snapshot} />
    </main>
  );
}
