# Ops Runbook: Acquisition advisory-score audit (read-only)

Status: REUSABLE. Run against the live warehouse (`data/warehouse/finance.sqlite`) when you need to know whether any
acquisition score was persisted from **non-ratified** math, or from a **superseded** ruleset/RCT.
Source: cc-audit-army 2026-09-28, finding `acq-score-proposed-fallback` (Invariant 4). Route fixed for NEW rows in PR #406.

Guardrails: **SELECT only.** Open the database read-only (`readonly: true` / `mode=ro`). Never run DDL or DML against
`data/warehouse/finance.sqlite`. Nothing here changes data.

## Why this exists

`POST /acq/score/:candidateId` used to fall back to a non-ratified ruleset when the ratified config failed to load, and it
still persisted the score and logged a calibration verdict. Those rows are read by:

- `capital-allocation.ts` (BUY gate and IC memo column): latest `acq_scores` row per candidate by `scored_at DESC, id DESC`,
  **with no `advisory_only` filter**;
- `GET /acq/intel` (ranked list) and the calibration record.

PR #406 stops new advisory rows. This audit checks for any that already exist, and for scores from a superseded engine.

## Run it

From the main checkout (it has `node_modules` and the live DB):

```bash
node -e "
const Database=require('better-sqlite3'), fs=require('fs');
const md=fs.readFileSync('docs/ops/2026-09-28-acq-advisory-score-audit.md','utf8');
const db=new Database(process.env.WAREHOUSE_DB||'data/warehouse/finance.sqlite',{readonly:true,fileMustExist:true});
db.pragma('busy_timeout = 5000');
[...md.matchAll(/\`\`\`sql\n([\s\S]*?)\`\`\`/g)].forEach((m,i)=>{
  try{const r=db.prepare(m[1].trim().replace(/;\s*\$/,'')).all(); console.log('\n'+(m[1].match(/-- (Q\d.*)/)||[])[1]+'  rows='+r.length); console.table(r.slice(0,25));}
  catch(e){console.log('\nblock '+(i+1)+' ERROR:',e.message);}
});"
```

Each block below is one query; the command runs them all. To run one by hand, paste it into any read-only SQLite session.

## Queries

```sql
-- Q1 Headline: scores by advisory flag and engine versions.
SELECT s.advisory_only, i.ruleset_version, i.rct_version,
       COUNT(*) AS scores, COUNT(DISTINCT s.candidate_id) AS candidates,
       MIN(s.scored_at) AS first_scored, MAX(s.scored_at) AS last_scored
FROM acq_scores s
JOIN acq_score_inputs i ON i.id = s.score_input_id
GROUP BY s.advisory_only, i.ruleset_version, i.rct_version
ORDER BY s.advisory_only DESC, last_scored DESC
```

```sql
-- Q2 Every advisory row; is_live_read=1 means capital-allocation would read it today (nothing newer for that candidate).
SELECT s.id AS acq_score_id, s.candidate_id, c.address, c.status AS candidate_status,
       s.verdict, s.tier, ROUND(s.composite, 1) AS composite,
       i.ruleset_version, i.rct_version, i.scored_by, s.scored_at, s.calibration_verdict_id,
       CASE WHEN s.id = (SELECT s2.id FROM acq_scores s2 WHERE s2.candidate_id = s.candidate_id
                         ORDER BY s2.scored_at DESC, s2.id DESC LIMIT 1)
            THEN 1 ELSE 0 END AS is_live_read
FROM acq_scores s
JOIN acq_score_inputs i ON i.id = s.score_input_id
LEFT JOIN acq_candidates c ON c.id = s.candidate_id
WHERE s.advisory_only = 1
ORDER BY is_live_read DESC, s.scored_at DESC
```

```sql
-- Q3 Advisory scores that leaked into the calibration record (expected: none).
SELECT v.id AS calibration_verdict_id, v.subject_id, v.predicted_band, v.predicted_value,
       v.as_of_period, v.emitted_by, s.id AS acq_score_id, s.scored_at
FROM acq_scores s
JOIN calibration_verdict v ON v.id = s.calibration_verdict_id
WHERE s.advisory_only = 1
ORDER BY v.id
```

```sql
-- Q4 Latest score per candidate NOT on the current ratified engine versions (superseded, needs a re-score). Update the two literals when the ratified versions move.
SELECT s.candidate_id, c.address, s.verdict, ROUND(s.composite, 1) AS composite,
       i.ruleset_version, i.rct_version, s.advisory_only, s.scored_at
FROM acq_scores s
JOIN acq_score_inputs i ON i.id = s.score_input_id
LEFT JOIN acq_candidates c ON c.id = s.candidate_id
WHERE s.id = (SELECT s2.id FROM acq_scores s2 WHERE s2.candidate_id = s.candidate_id
              ORDER BY s2.scored_at DESC, s2.id DESC LIMIT 1)
  AND (i.ruleset_version <> '2.0.0' OR i.rct_version <> 'replacement-cost.v3.2')
ORDER BY s.scored_at DESC
```

```sql
-- Q5 Capital recommendations for a candidate whose live score is advisory.
SELECT r.*
FROM recommendations r
WHERE r.property_id IN (
  SELECT s.candidate_id FROM acq_scores s
  WHERE s.advisory_only = 1
    AND s.id = (SELECT s2.id FROM acq_scores s2 WHERE s2.candidate_id = s.candidate_id
                ORDER BY s2.scored_at DESC, s2.id DESC LIMIT 1)
)
LIMIT 50
```

## Reading the results

| Result | Meaning | Action |
|---|---|---|
| All five return 0 rows | No advisory or superseded scores exist. | Record the run below. Done. |
| Q1 shows `advisory_only = 1` | Non-ratified scores are stored. | Go to Q2. |
| Q2 `is_live_read = 1` | A non-ratified score is the current input to that candidate's capital BUY gate / IC memo column. | Re-score the candidate on the ratified config (`POST /acq/score/:candidateId`); the newer row wins. Do **not** delete rows (Invariant: never delete; the ledger is append-only). |
| Q3 returns rows | A calibration prediction was made from non-ratified math and now feeds the learning loop. | Flag to Gabriel. Do not edit `calibration_verdict`; decide with the calibration owner whether to exclude the verdict in reporting. |
| Q4 returns rows | Latest score is from a superseded ruleset/RCT (stale denominator). | Re-score on the ratified config. After an RCT version bump, every cached score is expected to appear here until re-scored. |
| Q5 returns rows | A capital recommendation may have been driven by an advisory score. | Re-run the capital allocation after re-scoring; review the row's `advisory_only` and `inputs_version`. |

Open follow-up (not fixed): `capital-allocation.ts` still reads `acq_scores` with no `advisory_only = 0` filter. Adding one is a
defensive change to a financial-decision file and needs its own refute-reviewed PR.

## Run log

| Date | Warehouse | Result | By |
|---|---|---|---|
| 2026-09-28 | `data/warehouse/finance.sqlite` (main checkout, read-only) | `acq_scores` = 0 rows, `acq_candidates` = 5 (none scored). Q1 to Q5: 0 rows. No exposure. | Claude Code session (supervised) |

Query self-test (2026-09-28, throwaway warehouse seeded with a live advisory score, a superseded advisory score and a stale-engine latest score): Q1, Q2
(`is_live_read` 1 for the live row, 0 for the superseded one) and Q4 returned the expected rows. Q3 and Q5 were verified to compile and run against the real
schema but have not yet returned rows, because that needs a calibration verdict linked to an advisory score or a persisted capital recommendation.

Add a row each time this is run. A deployed mirror (`public/warehouse.json`) is a baked snapshot; audit its source database, not the JSON.
