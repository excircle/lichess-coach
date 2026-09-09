CREATE TABLE `opening_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`json` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `opening_plies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`ply` integer NOT NULL,
	`eco` text,
	`name` text,
	`source` text,
	`in_book` integer,
	`book_moves` text NOT NULL,
	`suggested_uci` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opening_plies_game_ply_unique` ON `opening_plies` (`game_id`,`ply`);