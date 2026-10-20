-- Dense integer ordering, enforced by the database.
--
-- DEFERRABLE INITIALLY DEFERRED: uniqueness is checked at COMMIT rather than per row,
-- so a transaction can shift/renumber positions in any order. A committed state can
-- never contain two tasks in the same slot of a column (or two columns in one slot).
-- The constraints' indexes also serve the "ORDER BY position" queries.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_column_position_key" UNIQUE ("column_id", "position") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "columns"
  ADD CONSTRAINT "columns_board_position_key" UNIQUE ("board_id", "position") DEFERRABLE INITIALLY DEFERRED;
