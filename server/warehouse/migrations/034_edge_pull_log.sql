-- 034_edge_pull_log.sql — Oxford Edge manual-pull done-state (append-only log).
-- User state only; holds no market data. Scope/cadence live in server/edge/pull-queue.ts.
-- Spec: docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md §7.
--
-- Append-only: there is no DELETE path. "Undo" sets voided_at (never-delete rule; history kept).
-- Current state per (pull_kind, scope_key) = the latest row with voided_at IS NULL, ordered
-- done_on DESC, id DESC. scope_key membership is enforced in the route against PULL_ITEMS, not
-- here, so the scope list can change without a migration.
--
-- done_on CHECK: `date(done_on) IS NOT NULL` is added to the spec's `done_on = date(done_on)`.
-- SQLite treats a CHECK whose expression evaluates to NULL as satisfied, and date('not-a-date')
-- is NULL, so the bare equality alone would admit garbage. The equality still rejects overflow
-- dates such as '2026-02-30' (date() normalizes it to a different string).
CREATE TABLE IF NOT EXISTS edge_pull_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_kind   TEXT NOT NULL CHECK (pull_kind IN ('storage', 'ios', 'mfgInvest', 'truck')),
  scope_key   TEXT NOT NULL CHECK (length(scope_key) BETWEEN 2 AND 64),
  done_on     TEXT NOT NULL CHECK (date(done_on) IS NOT NULL AND done_on = date(done_on)),
  note        TEXT CHECK (note IS NULL OR length(note) <= 2000),
  recorded_by TEXT NOT NULL DEFAULT 'ui',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  voided_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_pull_log_kind_scope
  ON edge_pull_log (pull_kind, scope_key, done_on DESC, id DESC);

-- DB-level append-only guard: rows are never deleted ("undo" = UPDATE voided_at).
CREATE TRIGGER IF NOT EXISTS trg_edge_pull_log_no_delete
BEFORE DELETE ON edge_pull_log
BEGIN
  SELECT RAISE(ABORT, 'edge_pull_log is append-only: void with voided_at instead of deleting');
END;

-- Rows are immutable except for ONE one-way change: voided_at NULL -> timestamp. Any other UPDATE
-- (rewriting history, un-voiding, re-voiding, renumbering) aborts. NULL-safe via IS NOT.
CREATE TRIGGER IF NOT EXISTS trg_edge_pull_log_void_only
BEFORE UPDATE ON edge_pull_log
WHEN OLD.voided_at IS NOT NULL
  OR NEW.voided_at IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.pull_kind IS NOT OLD.pull_kind
  OR NEW.scope_key IS NOT OLD.scope_key
  OR NEW.done_on IS NOT OLD.done_on
  OR NEW.note IS NOT OLD.note
  OR NEW.recorded_by IS NOT OLD.recorded_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'edge_pull_log is append-only: only a one-way void (voided_at) is permitted');
END;

-- INSERT OR REPLACE deletes the old row without firing the DELETE trigger (recursive_triggers is
-- off), so an insert that reuses an existing id is refused explicitly.
CREATE TRIGGER IF NOT EXISTS trg_edge_pull_log_no_replace
BEFORE INSERT ON edge_pull_log
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM edge_pull_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'edge_pull_log is append-only: REPLACE is not permitted');
END;
