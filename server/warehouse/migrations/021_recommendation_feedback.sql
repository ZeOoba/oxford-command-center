-- 021_recommendation_feedback.sql
-- Human accept/dismiss feedback on system-generated recommendations — Design Parity P1
-- (insights wiring). Additive only. No existing table is altered.
--
-- Append-only by convention: a decision is never revised in place. If a user changes their
-- mind, a NEW row is inserted with the same (subject_kind, subject_id) and a later decided_at —
-- readers take the most recent row per subject. There is no UPDATE path and no code should add
-- one; this mirrors the calibration_verdict immutability pattern (005_calibration.sql).
CREATE TABLE IF NOT EXISTS recommendation_feedback (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('insight','alert','allocation')),
  subject_id   TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('accept','dismiss')),
  decided_at   TEXT NOT NULL,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_rec_feedback_subject ON recommendation_feedback(subject_kind, subject_id);
