import crypto from "node:crypto";
import { getEnv } from "@/lib/env";

// Lichess OAuth2 PKCE (S256). No app registration: any unique client_id.
// Tokens last ~1 year; no refresh tokens (re-login when it expires).

export const LICHESS_SCOPES = "challenge:write board:play";

export function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, state, challenge };
}

export function redirectUri(): string {
  return `${getEnv().APP_URL}/api/auth/callback`;
}

export function authorizeUrl(challenge: string, state: string): string {
  const url = new URL("https://lichess.org/oauth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", getEnv().LICHESS_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", LICHESS_SCOPES);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
  const res = await fetch("https://lichess.org/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
      client_id: getEnv().LICHESS_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`Lichess token exchange failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}
