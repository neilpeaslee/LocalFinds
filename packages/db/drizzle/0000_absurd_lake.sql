CREATE TABLE `businesses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osm_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`address` text,
	`town` text,
	`lat` real,
	`lng` real,
	`website` text,
	`phone` text,
	`brand` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes_path` text,
	`added_by` text NOT NULL,
	`discovered_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`duplicate_of` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_osm_id_unique` ON `businesses` (`osm_id`);--> statement-breakpoint
CREATE INDEX `businesses_town_name_idx` ON `businesses` (`town`,`name`);--> statement-breakpoint
CREATE INDEX `businesses_status_idx` ON `businesses` (`status`);--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`find_id` integer NOT NULL,
	`action` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`find_id`) REFERENCES `finds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fetches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer,
	`agent` text NOT NULL,
	`host` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`status` integer,
	`klass` text NOT NULL,
	`via` text DEFAULT 'webfetch' NOT NULL,
	`ts` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fetches_host_idx` ON `fetches` (`host`);--> statement-breakpoint
CREATE INDEX `fetches_run_idx` ON `fetches` (`run_id`);--> statement-breakpoint
CREATE TABLE `finds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`url_hash` text NOT NULL,
	`summary` text,
	`event_start` text,
	`event_end` text,
	`expires_at` text,
	`published_at` text,
	`discovered_at` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`agent` text NOT NULL,
	`source_id` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`score` real,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finds_url_hash_unique` ON `finds` (`url_hash`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`items_added` integer DEFAULT 0 NOT NULL,
	`items_updated` integer DEFAULT 0 NOT NULL,
	`warnings` integer DEFAULT 0 NOT NULL,
	`num_turns` integer,
	`cost_usd` real,
	`usage_json` text,
	`session_id` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`name` text,
	`notes_path` text,
	`ical_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`quality_score` real,
	`finds_count` integer DEFAULT 0 NOT NULL,
	`last_find_at` text,
	`last_checked_at` text,
	`added_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`);