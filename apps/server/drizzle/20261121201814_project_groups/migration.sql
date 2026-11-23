CREATE TABLE `project_group_memory` (
	`group_id` text PRIMARY KEY,
	`content` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_groups` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`skills` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `group_id` text;--> statement-breakpoint
CREATE INDEX `projects_group` ON `projects` (`group_id`);