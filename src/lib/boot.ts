import { inArray } from "drizzle-orm";
import { db } from "./db";
import { games } from "./db/schema";
import { ensureGameManager } from "./games/manager";
import { ensureEventStream } from "./lichess/events";

// Runs once per server start (instrumentation.ts). Migrations are NOT run here
// — the container entrypoint runs `npm run db:migrate` before `next dev`.
export async function boot(): Promise<void> {
  const result = ensureEventStream();
  console.log(`[boot] lichess event stream: ${result}`);

  // Amendment A2: re-attach managers for games that were live when the server
  // last stopped. A finished game's stream replays terminal state then closes.
  const active = db
    .select({ id: games.id })
    .from(games)
    .where(inArray(games.status, ["created", "started"]))
    .all();
  for (const row of active) ensureGameManager(row.id);
  if (active.length > 0) {
    console.log(`[boot] re-attached ${active.length} active game manager(s)`);
  }
}
