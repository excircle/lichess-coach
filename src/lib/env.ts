import { z } from "zod";

const envSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  LICHESS_CLIENT_ID: z.string().default("lichess-coach.local"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)"),
  APP_URL: z.string().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("/data/coach.db"),
  STOCKFISH_PATH: z.string().default("/usr/games/stockfish"),
  EXPLORER_URL: z.string().default("https://explorer.lichess.org"),
  COACH_MODEL: z.string().default("sonnet"),
  REVIEW_MODEL: z.string().default("sonnet"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

// Lazy so scripts that don't need the full app env (e.g. spikes) can import
// sibling modules without a complete .env.
export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
