-- 031_migrations_applied_by.sql
--
-- Record WHICH process applied each migration.
--
-- Why: on 2026-09-17 migration 029 was applied to the live warehouse 108 seconds after a merge,
-- and two engineering sessions with full filesystem access, process listings and scheduled-task
-- history could not determine what did it. The hourly bake was eliminated by its schedule, both
-- sessions by their command history, and the Brain Server by having no running process and no log
-- since August. The event remains unattributed — not because the evidence was hard to read, but
-- because none was recorded.
--
-- `_migrations` is the bootstrap table: migrate.ts creates it before any migration runs. This
-- file extends it anyway, rather than changing that CREATE statement, because a column added
-- inline in TypeScript would never reach a database that already exists — the exact silent-drift
-- hazard the migrations directory exists to prevent (see the note in db.ts).
--
-- Rows applied before this migration keep a NULL applied_by. That is honest: we genuinely do not
-- know who applied them, and backfilling a guess would be worse than the gap.

ALTER TABLE _migrations ADD COLUMN applied_by TEXT;
