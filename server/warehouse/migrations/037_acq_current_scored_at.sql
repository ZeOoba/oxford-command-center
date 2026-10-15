-- 037_acq_current_scored_at.sql
-- Follow-up to 036 (acq_candidates.current_score_id). Kept as its own migration: runMigrations tracks
-- applied migrations by FILENAME with no checksum, so a warehouse that already applied 036 as pushed would
-- silently skip any later edit to it. Additive only.
--
-- current_scored_at: when the current score was last (re)asserted — "scored at" for display and ordering.
-- acq_scores.scored_at is the FIRST time those exact inputs were scored, so it cannot move on a re-score
-- (A->B->A). Semantics are "last re-asserted", not "first computed".
ALTER TABLE acq_candidates ADD COLUMN current_scored_at TEXT;

-- Backfill from the pointer row (036 already pointed it at the latest (scored_at, id) row).
UPDATE acq_candidates
   SET current_scored_at = (SELECT s.scored_at FROM acq_scores s WHERE s.id = acq_candidates.current_score_id);

-- Rolling-deploy safety net: code that predates 036/037 (e.g. an already-running server process) inserts
-- acq_scores rows without touching the pointer. Without this, a backfilled candidate would keep pointing
-- at its OLD score while old code writes new ones — a silently stale current score. A fresh insert becomes
-- current, which is exactly what the old "newest row wins" readers did. persistAndLogScore still sets the
-- pointer explicitly afterwards (the only path that can re-point at an OLDER row). INSERT OR IGNORE no-ops
-- do not fire it.
CREATE TRIGGER IF NOT EXISTS trg_acq_scores_set_current
AFTER INSERT ON acq_scores
BEGIN
  UPDATE acq_candidates
     SET current_score_id = NEW.id, current_scored_at = NEW.scored_at
   WHERE id = NEW.candidate_id;
END;
