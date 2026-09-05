/* dev-session-cookie.ts — prints a sealed iron-session cookie for the
   logged-in Lichess user, so API routes can be exercised with curl during
   development (the session route guards otherwise require the browser).
   Run in-container: npx tsx scripts/dev-session-cookie.ts */
import { sealData } from "iron-session";

async function main() {
  const password = process.env.SESSION_SECRET;
  if (!password) {
    console.error("SESSION_SECRET missing from env");
    process.exit(2);
  }
  const { getStoredCredentials } = await import("../src/lib/lichess/client");
  const creds = getStoredCredentials();
  if (!creds) {
    console.error("No credentials in DB — log in via the app first");
    process.exit(2);
  }
  const sealed = await sealData(
    { username: creds.userId, lichessUserId: creds.userId },
    { password, ttl: 60 * 60 * 24 },
  );
  console.log(`lichess_coach_session=${sealed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
