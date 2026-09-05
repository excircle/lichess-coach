import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { getEnv } from "./env";

export interface SessionData {
  username?: string;
  lichessUserId?: string;
  // transient PKCE state during the OAuth round-trip
  oauth?: { verifier: string; state: string };
}

function sessionOptions(): SessionOptions {
  const env = getEnv();
  return {
    password: env.SESSION_SECRET,
    cookieName: "lichess_coach_session",
    cookieOptions: {
      secure: env.APP_URL.startsWith("https"),
      sameSite: "lax",
      httpOnly: true,
    },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

// Returns the session when logged in, else null. Route handlers must guard:
//   const session = await requireSession();
//   if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
export async function requireSession() {
  const session = await getSession();
  return session.lichessUserId ? session : null;
}
