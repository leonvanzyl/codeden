CREATE TABLE `item_search` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool_kind` text,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_search_item` ON `item_search` (`session_id`,`item_id`);
--> statement-breakpoint
-- The full-text index over `item_search.text` (external content: the text is stored once, in `item_search`). Trigram tokens match substrings inside identifiers and paths, case- and accent-insensitively.
CREATE VIRTUAL TABLE `item_search_fts` USING fts5(`text`, content='item_search', content_rowid='id', tokenize='trigram remove_diacritics 1');
--> statement-breakpoint
-- Triggers keep the index in step with every write to `item_search`, in the same transaction.
CREATE TRIGGER `item_search_ai` AFTER INSERT ON `item_search` BEGIN
	INSERT INTO `item_search_fts` (rowid, `text`) VALUES (new.`id`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `item_search_ad` AFTER DELETE ON `item_search` BEGIN
	INSERT INTO `item_search_fts` (`item_search_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `item_search_au` AFTER UPDATE OF `text` ON `item_search` WHEN old.`text` IS NOT new.`text` BEGIN
	INSERT INTO `item_search_fts` (`item_search_fts`, rowid, `text`) VALUES ('delete', old.`id`, old.`text`);
	INSERT INTO `item_search_fts` (rowid, `text`) VALUES (new.`id`, new.`text`);
END;
