import { desc } from "drizzle-orm";
import Link from "next/link";
import NewGameForm from "@/components/NewGameForm";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { isTerminalStatus } from "@/lib/games/types";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const session = await getSession();

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Lichess Coach</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Casual games vs Stockfish with live Claude coaching.
      </p>

      <div className="mt-10">
        {session.username ? (
          <LoggedIn username={session.username} />
        ) : (
          <a
            href="/api/auth/login"
            className="inline-block rounded-lg bg-neutral-900 px-5 py-2.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Log in with Lichess
          </a>
        )}
      </div>
    </main>
  );
}

function LoggedIn({ username }: { username: string }) {
  const recent = db.select().from(games).orderBy(desc(games.createdAt)).limit(15).all();

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <p>
          Logged in as <span className="font-semibold">{username}</span>
        </p>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="text-sm underline underline-offset-4 hover:text-neutral-500"
          >
            Log out
          </button>
        </form>
      </div>

      <NewGameForm />

      <section>
        <h2 className="mb-3 font-semibold">Recent games</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No games yet — start one above.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {recent.map((g) => {
              const finished = isTerminalStatus(g.status);
              return (
                <li key={g.id}>
                  <Link
                    href={finished ? `/games/${g.id}` : `/play/${g.id}`}
                    className="flex items-center justify-between px-4 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    <span>
                      {finished ? "" : "● "}
                      vs Stockfish {g.aiLevel} · {g.userColor} ·{" "}
                      {g.clockInitial != null
                        ? `${Math.round(g.clockInitial / 60)}+${g.clockIncrement ?? 0}`
                        : "unlimited"}
                    </span>
                    <span className="text-neutral-500">
                      {finished ? (g.result ?? g.status) : "live"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
