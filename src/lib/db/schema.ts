import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Single-user app: exactly one row, id = 1.
export const credentials = sqliteTable("credentials", {
  id: integer("id").primaryKey(),
  lichessToken: text("lichess_token").notNull(),
  lichessUserId: text("lichess_user_id").notNull(),
  scopes: text("scopes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const games = sqliteTable("games", {
  id: text("id").primaryKey(), // lichess game id (8 chars)
  fullId: text("full_id"),
  userColor: text("user_color", { enum: ["white", "black"] }).notNull(),
  aiLevel: integer("ai_level").notNull(),
  speed: text("speed"),
  clockInitial: integer("clock_initial"), // seconds (challenge/export unit; gameFull sends ms)
  clockIncrement: integer("clock_increment"), // seconds
  initialFen: text("initial_fen"),
  status: text("status").notNull().default("created"),
  winner: text("winner"),
  result: text("result"), // derived from winner+status ("1-0"|"0-1"|"1/2-1/2"|"aborted")
  openingEco: text("opening_eco"), // only available from post-game export
  openingName: text("opening_name"),
  movesUci: text("moves_uci").notNull().default(""),
  pgn: text("pgn"),
  coachMode: text("coach_mode", { enum: ["auto", "opening", "off"] })
    .notNull()
    .default("auto"),
  claudeSessionId: text("claude_session_id"), // future: in-app chat milestone
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const moves = sqliteTable(
  "moves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id),
    ply: integer("ply").notNull(), // 1-based
    san: text("san").notNull(),
    uci: text("uci").notNull(),
    fenAfter: text("fen_after").notNull(),
    clockMs: integer("clock_ms"),
    isUserMove: integer("is_user_move", { mode: "boolean" }).notNull(),
    // Engine data, White POV (side-to-move UCI scores are normalized before storing)
    evalCp: integer("eval_cp"),
    evalMate: integer("eval_mate"),
    evalDepth: integer("eval_depth"),
    bestMoveUci: text("best_move_uci"),
    bestLineUci: text("best_line_uci"),
    winPct: real("win_pct"), // White POV win% after this move
    cpLoss: integer("cp_loss"), // mover POV
    judgment: text("judgment", {
      enum: ["blunder", "mistake", "inaccuracy", "good"],
    }),
    phase: text("phase", { enum: ["opening", "middlegame", "endgame"] }),
    motifTags: text("motif_tags"), // JSON array; future: learning recommendations
  },
  (t) => [uniqueIndex("moves_game_ply_unique").on(t.gameId, t.ply)],
);

export const coachComments = sqliteTable("coach_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id),
  ply: integer("ply").notNull(),
  trigger: text("trigger", { enum: ["auto", "user_request", "opening"] }).notNull(),
  content: text("content").notNull(),
  evalSnapshot: text("eval_snapshot"), // JSON of the eval context given to Claude
  model: text("model"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// PLAN OS-D4: explorer responses are static — cache them 30 days, keyed by
// source + root position + play sequence.
export const openingCache = sqliteTable("opening_cache", {
  key: text("key").primaryKey(), // `${source}|${rootFen}|${play}`
  json: text("json").notNull(), // raw explorer response, topGames stripped
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

// PLAN OS-D8: per-ply opening annotations — snapshot rehydration + review.
export const openingPlies = sqliteTable(
  "opening_plies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id),
    ply: integer("ply").notNull(), // 0 = start position
    eco: text("eco"),
    name: text("name"),
    source: text("source", { enum: ["masters", "lichess"] }),
    inBook: integer("in_book", { mode: "boolean" }), // null at ply 0
    bookMoves: text("book_moves").notNull(), // JSON BookMove[] for the position AFTER this ply
    suggestedUci: text("suggested_uci"), // top book move, null when out of book
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("opening_plies_game_ply_unique").on(t.gameId, t.ply)],
);

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gameId: text("game_id")
    .notNull()
    .references(() => games.id)
    .unique(),
  status: text("status", {
    enum: ["pending", "analyzing", "generating", "complete", "failed"],
  })
    .notNull()
    .default("pending"),
  contentMd: text("content_md"),
  keyMoments: text("key_moments"), // JSON
  accuracy: real("accuracy"),
  error: text("error"),
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});
