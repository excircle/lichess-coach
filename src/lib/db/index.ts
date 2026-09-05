import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

function createDb() {
  const file = process.env.DATABASE_PATH ?? "/data/coach.db";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

// globalThis singleton: dev HMR re-evaluates modules but must not reopen the db.
const g = globalThis as unknown as { __db?: ReturnType<typeof createDb> };

export const db = (g.__db ??= createDb());
