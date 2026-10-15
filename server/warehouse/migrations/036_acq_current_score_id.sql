-- 036_acq_current_score_id.sql
-- History-independent "current score" pointer for acquisition candidates.
-- Refute wf_f5f45202-de8 (PR #456): acq_scores is deduped on UNIQUE(score_input_id), so re-scoring
-- inputs A after B (A->B->A) writes no new row and "latest by scored_at DESC, id DESC" kept returning B
-- while the engine returned A. persistAndLogScore now points current_score_id at the row for the inputs
-- it was JUST called with (including the idempotent no-op path); readers join on it instead of
-- inferring "latest" from write order. NULL = never scored. acq_scores itself stays immutable.
ALTER TABLE acq_candidates ADD COLUMN current_score_id INTEGER REFERENCES acq_scores(id);

-- Backfill: the pre-existing readers' notion of current (latest scored_at, id), so no visible change at
-- migration time.
UPDATE acq_candidates
   SET current_score_id = (
     SELECT s.id FROM acq_scores s
      WHERE s.candidate_id = acq_candidates.id
      ORDER BY s.scored_at DESC, s.id DESC
      LIMIT 1
   );
