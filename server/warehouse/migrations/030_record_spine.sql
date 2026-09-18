-- 030_record_spine.sql
--
-- The Record Spine: canonical identity, source documents, cited facts, decisions, and an
-- append-only audit trail. Additive only — no existing table is altered.
--
-- Why: lease and tenant records live in at least five stores (live workbook, warehouse
-- lease_terms, ora-pm Postgres, Notion Tenant DB, TENANTS.json pipeline). Nothing today maps
-- one store's id to another's, so a join is a manual reconciliation every time, and the Notion
-- Tenant DB already required a large remediation after phantom/duplicate rows silently corrupted
-- every analytic built on it. entity_xref makes identity explicit and auditable rather than
-- re-derived per query.
--
-- lease_facts carries page + verbatim quote + a deterministic quote_on_page flag because an
-- extracted lease term with no source citation cannot be checked by a human, and OCR abstraction
-- has already missed a hand-altered term and an unexecuted lease in this portfolio.

CREATE TABLE IF NOT EXISTS entity_xref (
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('property','unit','tenant','lease')),
  canonical_id  TEXT NOT NULL,
  system        TEXT NOT NULL CHECK (system IN
                  ('warehouse','ora_pm','notion','workbook','lease_market','yardi','appfolio','rentmanager','quickbooks','hubspot')),
  external_id   TEXT NOT NULL,
  match_method  TEXT NOT NULL CHECK (match_method IN
                  ('exact_id','exact_address','identity_key','manual','ambiguous')),
  confidence    REAL NOT NULL DEFAULT 1.0,
  verified_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (system, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_xref_canonical ON entity_xref (entity_type, canonical_id);

CREATE TABLE IF NOT EXISTS documents (
  document_id        TEXT PRIMARY KEY,
  sha256             TEXT NOT NULL UNIQUE,
  path               TEXT NOT NULL,
  doc_type           TEXT NOT NULL CHECK (doc_type IN
                       ('lease','amendment','addendum','guaranty','snda','estoppel','coi','om','other')),
  lease_canonical_id TEXT,
  chain_seq          INTEGER,
  executed           TEXT NOT NULL DEFAULT 'unknown' CHECK (executed IN ('yes','no','unknown')),
  contains_pii       INTEGER NOT NULL DEFAULT 0 CHECK (contains_pii IN (0,1)),
  page_count         INTEGER,
  landed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_lease ON documents (lease_canonical_id, chain_seq);

CREATE TABLE IF NOT EXISTS lease_facts (
  fact_id            TEXT PRIMARY KEY,
  lease_canonical_id TEXT NOT NULL,
  field              TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  document_id        TEXT NOT NULL REFERENCES documents(document_id),
  page               INTEGER NOT NULL,
  quote              TEXT NOT NULL,
  quote_on_page      INTEGER NOT NULL CHECK (quote_on_page IN (0,1)),
  confidence         REAL NOT NULL,
  extractor_version  TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('extracted','disputed','verified','superseded')),
  superseded_by      TEXT,
  verified_by        TEXT,
  verified_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lease_facts_lease_field ON lease_facts (lease_canonical_id, field, status);

CREATE TABLE IF NOT EXISTS obligations (
  obligation_id      TEXT PRIMARY KEY,
  lease_canonical_id TEXT NOT NULL,
  kind               TEXT NOT NULL,
  responsible_party  TEXT NOT NULL CHECK (responsible_party IN ('landlord','tenant','shared','unknown')),
  trigger_date       TEXT,
  due_date           TEXT,
  recurrence         TEXT,
  source_fact_ids    TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','satisfied','waived','expired')),
  owner              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations (due_date, status);

CREATE TABLE IF NOT EXISTS deal_decisions (
  decision_id       TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL,
  stage             TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('pass','watch','investigate','underwrite','contact_broker','loi','acquired','lost')),
  reason_codes      TEXT NOT NULL,
  note              TEXT,
  price_at_decision REAL,
  ruleset_version   TEXT NOT NULL,
  decided_by        TEXT NOT NULL,
  decided_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deal_decisions_candidate ON deal_decisions (candidate_id, decided_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id         TEXT PRIMARY KEY,
  pipeline       TEXT NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  input_sha256   TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_usd       REAL,
  status         TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  error          TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id, seq);

-- Append-only enforcement. An audit trail a process can rewrite is not an audit trail; these
-- triggers make tampering a hard error at the database rather than a code-review convention.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
