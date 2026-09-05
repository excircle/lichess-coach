import { getSession } from "@/lib/session";

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
          <div className="space-y-6">
            <p>
              Logged in as{" "}
              <span className="font-semibold">{session.username}</span>
            </p>
            <p className="text-sm text-neutral-500">
              Game creation lands in M2 — for now this page only proves the
              Lichess login.
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
