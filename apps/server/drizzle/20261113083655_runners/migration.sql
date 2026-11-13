CREATE TABLE `runners` (
	`id` text PRIMARY KEY,
	`backend` text NOT NULL,
	`is_home` integer DEFAULT false NOT NULL,
	`runner_id` text,
	`sandbox_ref` text,
	`project_id` text,
	`session_id` text,
	`state` text NOT NULL,
	`version` text,
	`image_version` text,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `runners_runner_id` ON `runners` (`runner_id`);