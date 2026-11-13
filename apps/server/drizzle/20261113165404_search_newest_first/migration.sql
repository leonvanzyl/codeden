-- Transcript search, newest first (§6): rebuilt rather than converted. `item_search` is a projection of `items`, so it is emptied here and the background backfill indexes every item again.
DROP TRIGGER IF EXISTS `item_search_ai`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `item_search_ad`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `item_search_au`;
--> statement-breakpoint
DROP TABLE IF EXISTS `item_search_fts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `item_search`;
--> statement-breakpoint
-- `id` is the item's rowid in `items` (creation order), so the index lists matches newest first and can stop early. The thread, kind and time of a hit are read from `items`.
CREATE TABLE `item_search` (
	`id` integer PRIMARY KEY,
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_search_item` ON `item_search` (`session_id`,`item_id`);
--> statement-breakpoint
-- The full-text index over `item_search.text` (external content: the text is stored once, in `item_search`). Trigram tokens find substrings inside identifiers and paths, ignoring case and accents. `detail=none` keeps only rowids (about a quarter of the size with positions), so queries use single trigrams and search checks each candidate's text; `columnsize=0` drops the per-row sizes only ranking needed.
CREATE VIRTUAL TABLE `item_search_fts` USING fts5(`text`, content='item_search', content_rowid='id', tokenize='trigram remove_diacritics 1', detail='none', columnsize=0);
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
--> statement-breakpoint
-- How far the background backfill has read `items` (one row); no row means from the start.
CREATE TABLE `item_search_backfill` (
	`id` integer PRIMARY KEY,
	`after_rowid` integer NOT NULL
);
