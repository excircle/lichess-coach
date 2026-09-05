CREATE TABLE `coach_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`ply` integer NOT NULL,
	`trigger` text NOT NULL,
	`content` text NOT NULL,
	`eval_snapshot` text,
	`model` text,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`lichess_token` text NOT NULL,
	`lichess_user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`full_id` text,
	`user_color` text NOT NULL,
	`ai_level` integer NOT NULL,
	`speed` text,
	`clock_initial` integer,
	`clock_increment` integer,
	`initial_fen` text,
	`status` text DEFAULT 'created' NOT NULL,
	`winner` text,
	`result` text,
	`opening_eco` text,
	`opening_name` text,
	`moves_uci` text DEFAULT '' NOT NULL,
	`pgn` text,
	`coach_mode` text DEFAULT 'auto' NOT NULL,
	`claude_session_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`ply` integer NOT NULL,
	`san` text NOT NULL,
	`uci` text NOT NULL,
	`fen_after` text NOT NULL,
	`clock_ms` integer,
	`is_user_move` integer NOT NULL,
	`eval_cp` integer,
	`eval_mate` integer,
	`eval_depth` integer,
	`best_move_uci` text,
	`best_line_uci` text,
	`win_pct` real,
	`cp_loss` integer,
	`judgment` text,
	`phase` text,
	`motif_tags` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moves_game_ply_unique` ON `moves` (`game_id`,`ply`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`content_md` text,
	`key_moments` text,
	`accuracy` real,
	`error` text,
	`model` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_game_id_unique` ON `reviews` (`game_id`);