import { ensureEventStream } from "./lichess/events";

// Runs once per server start (instrumentation.ts). Migrations are NOT run here
// — the container entrypoint runs `npm run db:migrate` before `next dev`.
export async function boot(): Promise<void> {
  const result = ensureEventStream();
  console.log(`[boot] lichess event stream: ${result}`);
  // M2: re-attach GameManagers for DB games still marked created/started.
}
