// scripts/warehouse-verify.ts — systematized acceptance gate for the financial warehouse.
//
// Builds a FRESH warehouse in a temp dir (os.tmpdir — never data/warehouse), runs the
// same seed + ingest pipeline over FINANCIALS_DIR, then asserts:
//   1. zero 'empty-parse' data-quality issues (adapter/layout regressions)
//   1b. zero 'foot-mismatch' data-quality issues (report-stated totals vs parsed sums)
//   2. zero unmapped accounts on committed imports
//   3. committed import count >= MIN_COMMITTED
//   4. every committed import's active income-side ledger sum ties (±$1) to the income
//      leaves recomputed from the same RawStatement — an internal-consistency tie,
//      structured so a future independent-totals source can replace expectedIncomeFor()
//   5. prints the NOI matrix
//   6. the scored attention/health band distribution does NOT collapse to a single band
//      (a >~90% single-bucket share is the systemic cross-grain-scoring-bug signal that
//      per-property unit tests miss — see scoreBandDistribution / PFI 2026-06-12 lesson)
//   11. the APPROVE re-resolution path (where H3 lives) preserves every dual-side account's
//      ingest-time side over the REAL seed: forces each fully-mapped file to pending-review,
//      approves it, and asserts each dual-side key's income/opex side-sums are unchanged
// Exits 1 with a clear message on any failure. Local-only gate (wired into `npm run gate`,
// NOT gate:ci — CI runners have no FINANCIALS_DIR).
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { approveImport } from '../server/warehouse/actions';
import { ingestFile } from '../server/warehouse/ingest';
import { accountKey, classificationSide, resolveMapping, sectionSide, seedMappingsFromFile } from '../server/warehouse/mapping';
import { basisCoverage } from '../server/warehouse/data-quality';
import { PARSER_VERSION, parseQbExcel } from '../server/warehouse/parse/qb-excel';
import { propertyPeriodMetrics } from '../server/warehouse/metrics';
import { noiMatrix } from '../server/warehouse/queries';
import { CANON_PROPERTIES, seedPropertyMaster } from '../server/warehouse/property-master';
import { NOI_INCOME_CLASSES } from '../src/contracts/warehouse';
import { MIN_PROPERTIES_FOR_COLLAPSE_CHECK, SINGLE_BAND_COLLAPSE_SHARE, scoreBandDistribution, scoreProperties } from '../server/warehouse/scores';

loadEnvFile();

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners/Property Financials';
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');
const MIN_COMMITTED = 32;
const INCOME_TIE_TOLERANCE = 1; // dollars
// Basis-parse coverage ratchet — now CLOSED (0/32). An unknown-basis property is benchmarked against NO
// same-basis peers by scores.ts G3 (it treats 'unknown' as non-comparable), so its NOI/SF benchmark
// position would fall to neutral. With this baseline at 0, ANY future import that fails to yield a basis
// trips the gate — forcing it to be handled rather than silently degrading a scorecard.
//
// All 32 committed imports now resolve a basis (26 cash, 6 accrual). The former 8-file gap was closed in
// qb-excel.ts by reading where each source actually states the basis: the 6 QB Desktop "Jan - Dec 24"
// stripped exports (1851 South Club Solar ×3, 55 New Plant EGFLLC ×3) state "Accrual Basis" in the Excel
// PRINT HEADER (ws.headerFooter) — not in any cell, so the row scan never saw it (corroborated by the
// Depreciation/Amortization in those bodies); the 2 AppFolio "Cash Flow" Northwood imports encode basis
// in the report TYPE. Keep this at 0 — only raise it (with a recorded reason) if a genuinely basis-less
// file type is intentionally admitted.
const MAX_UNKNOWN_BASIS = 0;

interface CommittedImport {
  id: number;
  file_name: string;
  raw_path: string;
  property_id: string;
  /** Year string derived from period_start (e.g. '2025'). Passed to resolveMapping so
   *  period-scoped seed rows (e.g. H4: FVC 2025 easement) fire correctly during the
   *  expectedIncomeFor income-tie re-check. */
  period: string;
}

/**
 * Income-side expectation for a committed import, recomputed from the SAME RawStatement
 * the ingest consumed (re-parse of the immutable raw copy). Mirrors ingest-time mapping:
 * income-SECTION leaves whose resolved classification is income-side (revenue / recovery /
 * other-income). Internal-consistency tie — replace this function with an independent
 * totals source (e.g. the statement's own "Total Operating Income" row or the Master
 * Workbook) without touching the assertion loop.
 */
async function expectedIncomeFor(db: WarehouseDb, imp: CommittedImport): Promise<number> {
  const stmt = await parseQbExcel(imp.raw_path);
  let sum = 0;
  for (const a of stmt.accounts) {
    if (a.total === null) continue;
    if (sectionSide(a.section) !== 'income') continue;
    const m = resolveMapping(db, a.name, imp.property_id, a.section, undefined, imp.period);
    if (classificationSide(m.classification) !== 'income') continue; // e.g. 'excluded'
    sum += a.total;
  }
  return sum;
}

/**
 * Account keys the seed maps on BOTH the income and expense side (gas/electric/water/
 * bad-debt-expense in the real PFI seed). These are exactly the accounts whose approve-time
 * re-resolution could flip an opex row to the income/recovery mapping (or vice versa) under an
 * undefined dual-side seed tiebreak — the H3 class. Derived from the live mappings table so the
 * check tracks the seed instead of hardcoding the four names.
 */
function dualSideAccountKeys(db: WarehouseDb): Set<string> {
  const rows = db.prepare(
    "SELECT DISTINCT raw_account_key, classification FROM account_mappings WHERE match_kind = 'seed'",
  ).all() as Array<{ raw_account_key: string; classification: string }>;
  const sidesByKey = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = classificationSide(r.classification);
    if (s === 'either') continue;
    if (!sidesByKey.has(r.raw_account_key)) sidesByKey.set(r.raw_account_key, new Set());
    sidesByKey.get(r.raw_account_key)!.add(s);
  }
  return new Set([...sidesByKey].filter(([, sides]) => sides.has('income') && sides.has('expense')).map(([k]) => k));
}

/** Per dual-side account key, the {income, opex} amount sums over a set of ledger rows. The H3
 *  invariant: these two sums for each key must be IDENTICAL before vs after approve — approve
 *  re-resolution must never move a dual-side row from one side to the other. */
function dualSideSideSums(
  rows: Array<{ raw_account: string; classification: string; amount: number }>,
  keys: Set<string>,
): Map<string, { income: number; opex: number }> {
  const out = new Map<string, { income: number; opex: number }>();
  for (const r of rows) {
    const k = accountKey(r.raw_account);
    if (!keys.has(k)) continue;
    if (!out.has(k)) out.set(k, { income: 0, opex: 0 });
    const bucket = out.get(k)!;
    const side = classificationSide(r.classification);
    if (side === 'income') bucket.income += r.amount;
    else if (r.classification === 'opex') bucket.opex += r.amount;
  }
  return out;
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), 'wh-verify-'));
  const failures: string[] = [];
  try {
    const db = openWarehouse(join(tmp, 'finance.sqlite'));
    seedPropertyMaster(db);
    const seeded = seedMappingsFromFile(db, SEED_PATH);
    console.log(`warehouse:verify — fresh build in ${tmp} (${seeded} seed mappings)`);

    const files = readdirSync(FINANCIALS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    const counts: Record<string, number> = {};
    for (const f of files) {
      const r = await ingestFile(db, join(FINANCIALS_DIR, f), {
        rawDir: join(tmp, 'raw'),
        importedAt: new Date().toISOString(),
        importedBy: 'warehouse-verify',
      });
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (r.unmapped) console.log(`  unmapped in ${r.file}: [${r.unmapped.join('; ')}]`);
    }
    console.log('status counts:', JSON.stringify(counts));

    // 1. zero empty-parse DQ issues
    const emptyParse = db.prepare(
      "SELECT COUNT(*) AS c FROM data_quality_issues WHERE kind = 'empty-parse'",
    ).get() as { c: number };
    if (emptyParse.c > 0) {
      failures.push(`${emptyParse.c} 'empty-parse' data-quality issue(s) — an adapter/layout regression parsed 0 accounts`);
    }

    // 1b. zero foot-mismatch DQ issues anywhere in the backfill — a report's own stated
    // totals disagreeing with the parsed side sums means a section drop or wrong value
    // column; report each verbatim.
    const footMismatches = db.prepare(`
      SELECT b.file_name, d.detail FROM data_quality_issues d
      JOIN import_batches b ON b.id = d.import_id
      WHERE d.kind = 'foot-mismatch' ORDER BY b.file_name
    `).all() as Array<{ file_name: string; detail: string }>;
    for (const fm of footMismatches) {
      failures.push(`foot-mismatch in ${fm.file_name}: ${fm.detail}`);
    }

    // 2. zero unmapped accounts on committed imports
    const unmappedCommitted = db.prepare(`
      SELECT COUNT(*) AS c FROM data_quality_issues d
      JOIN import_batches b ON b.id = d.import_id
      WHERE d.kind = 'unmapped-account' AND b.status = 'committed'
    `).get() as { c: number };
    if (unmappedCommitted.c > 0) {
      failures.push(`${unmappedCommitted.c} unmapped account(s) on committed imports — seed/mapping gap`);
    }

    // 3. committed count floor
    const committed = db.prepare(`
      SELECT id, file_name, raw_path, property_id,
             substr(period_start, 1, 4) AS period
      FROM import_batches
      WHERE status = 'committed' ORDER BY id
    `).all() as CommittedImport[];
    if (committed.length < MIN_COMMITTED) {
      failures.push(`only ${committed.length} committed imports (expected >= ${MIN_COMMITTED}) — a previously-ingestible file regressed`);
    }

    // 4. income-side ledger tie per committed import (±$INCOME_TIE_TOLERANCE)
    // Income classes come from the contract (NOI_INCOME_CLASSES) — bound as parameters so this list
    // can never drift from queries.ts / NOI_CLASSES.
    const incomePlaceholders = NOI_INCOME_CLASSES.map(() => '?').join(',');
    const ledgerIncome = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries
      WHERE import_id = ? AND is_active = 1
        AND classification IN (${incomePlaceholders})
    `);
    for (const imp of committed) {
      const ledger = (ledgerIncome.get(imp.id, ...NOI_INCOME_CLASSES) as { s: number }).s;
      const expected = await expectedIncomeFor(db, imp);
      const delta = Math.abs(ledger - expected);
      if (delta > INCOME_TIE_TOLERANCE) {
        failures.push(`income tie failed for ${imp.file_name}: active ledger ${ledger.toFixed(2)} vs file ${expected.toFixed(2)} (delta ${delta.toFixed(2)})`);
      }
    }
    console.log(`income tie: ${committed.length} committed imports checked (tolerance $${INCOME_TIE_TOLERANCE})`);

    // 5. NOI matrix — print the COHERENT figure the /noi API serves. noiMatrix() derives from
    //    propertyPeriodMetrics (selectCoherentBatch), so a coexisting full-year + same-year YTD
    //    resolves to the full-year batch instead of summing both (the ~2x double-count a raw
    //    GROUP BY over all active rows reports). Sharing the API codepath means the gate prints
    //    exactly what the platform reports — it can no longer miss the double-count.
    const noi = noiMatrix(db).map((c) => ({ property_id: c.propertyId, period: c.period, noi: c.noi }));
    console.table(noi);

    // 6. basis coverage — accounting-basis parse gap. scores.ts G3 benchmarks an unknown-basis property
    //    against NO same-basis peers, so its NOI/SF benchmark position falls to neutral. Surfaced every
    //    run; fails only on regression past the baseline (drive the baseline toward 0 as parsing improves).
    const bc = basisCoverage(db);
    console.log(`basis coverage: ${bc.unknown}/${bc.committed} committed imports have unknown accounting `
      + `basis (period-header parse gap; 'unknown' is non-comparable in scores.ts G3 — benchmarked against no same-basis peers)`);
    if (bc.unknown > MAX_UNKNOWN_BASIS) {
      failures.push(`unknown-basis imports ${bc.unknown} exceed baseline ${MAX_UNKNOWN_BASIS} — QB `
        + `period-header basis parse regressed: ${bc.unknownFiles.join('; ')}`);
    }

    // 7. score-band distribution sanity — promote the PFI 2026-06-12 "live-backfill-then-diff"
    // check into the gate. Two cross-grain scoring bugs (partial-year YTD ranked against a full
    // prior year) made EVERY property collapse into one attention band; 414 green unit tests
    // missed it because each property passed in isolation — only the cross-property distribution
    // exposed it. FAIL loudly if the scored distribution collapses to a single attention/health
    // band on the real backfill. Print the histogram either way.
    const scores = scoreProperties(db, propertyPeriodMetrics(db));
    const dist = scoreBandDistribution(scores);
    console.log(
      `score bands (${dist.total} scored): attention=${JSON.stringify(dist.attentionHist)} ` +
      `health=${JSON.stringify(dist.healthHist)} noiPerSfQuartile=${JSON.stringify(dist.quartileHist)}`,
    );
    // Guard against a VACUOUS pass: if the committed floor cleared but scoring produced too few
    // rows to even run the collapse check, scores silently vanished — that is itself an anomaly.
    if (committed.length >= MIN_COMMITTED && dist.total < MIN_PROPERTIES_FOR_COLLAPSE_CHECK) {
      failures.push(`only ${dist.total} scored properties despite ${committed.length} committed imports (>= ${MIN_COMMITTED}) — scoring silently produced too few rows; the band-collapse check could not run`);
    }
    if (dist.collapsed) {
      failures.push(`score-band distribution collapsed — ${dist.reason}`);
    }

    // 8. Structural integrity invariants — catch the bug-states the parser-version re-ingest path
    //    could otherwise leave: a committed import must have >= 1 ACTIVE ledger row (no silently
    //    emptied period), every superseded_by must point to an existing row, and at most ONE
    //    committed import may exist per (property, period) — the supersede invariant.
    const emptyCommitted = db.prepare(`
      SELECT b.file_name FROM import_batches b WHERE b.status = 'committed'
        AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.import_id = b.id AND l.is_active = 1)
      ORDER BY b.file_name
    `).all() as Array<{ file_name: string }>;
    for (const e of emptyCommitted) failures.push(`committed import with 0 active ledger rows (emptied period): ${e.file_name}`);
    const danglingRef = db.prepare(`
      SELECT b.id, b.superseded_by AS target FROM import_batches b
      WHERE b.superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM import_batches t WHERE t.id = b.superseded_by)
    `).all() as Array<{ id: number; target: number }>;
    for (const d of danglingRef) failures.push(`import ${d.id} superseded_by points to non-existent row ${d.target}`);
    const dupPeriod = db.prepare(`
      SELECT property_id, period_start, period_end, COUNT(*) AS n FROM import_batches
      WHERE status = 'committed' GROUP BY property_id, period_start, period_end HAVING n > 1
    `).all() as Array<{ property_id: string; period_start: string; period_end: string; n: number }>;
    for (const d of dupPeriod) failures.push(`${d.n} committed imports for the same period (${d.property_id} ${d.period_start}..${d.period_end}) — supersede invariant violated`);

    // 8b. Migration 008 schema presence — property_insurance_policies must exist.
    const insTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='property_insurance_policies'",
    ).get() as { name: string } | undefined;
    if (!insTable) {
      failures.push('property_insurance_policies table missing — migration 008 did not apply');
    }

    // 8c. Migration 009 schema presence — debt_positions must exist.
    const debtPositionsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='debt_positions'",
    ).get() as { name: string } | undefined;
    if (!debtPositionsExists) {
      failures.push('debt_positions table missing — migration 009 did not apply');
    }

    // 8d. Migration 011 schema presence — lease_events must exist (Phase 3 leasing-velocity log).
    const leaseEventsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='lease_events'",
    ).get() as { name: string } | undefined;
    if (!leaseEventsExists) {
      failures.push('lease_events table missing — migration 011 did not apply');
    }

    // 8e. Migration 012 schema presence — prospect_demand_events must exist (Prospect Demand foundation).
    const prospectDemandExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='prospect_demand_events'",
    ).get() as { name: string } | undefined;
    if (!prospectDemandExists) {
      failures.push('prospect_demand_events table missing — migration 012 did not apply');
    }

    // 8f. Phase 5 schema assertions — market_series table exists (migration 013).
    const marketSeriesExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='market_series'",
    ).get() as { name: string } | undefined;
    if (!marketSeriesExists) {
      failures.push('market_series table missing — migration 013 did not apply');
    }

    // 8g. Phase 5 schema assertions — ix_market_series_cluster_asof index exists (migration 013).
    const marketSeriesIndexExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_market_series_cluster_asof'",
    ).get() as { name: string } | undefined;
    if (!marketSeriesIndexExists) {
      failures.push('ix_market_series_cluster_asof index missing — migration 013 did not apply');
    }

    // 8h. Phase 5 schema assertions — recommendations table exists (migration 014).
    const recommendationsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recommendations'",
    ).get() as { name: string } | undefined;
    if (!recommendationsExists) {
      failures.push('recommendations table missing — migration 014 did not apply');
    }

    // 8i. Phase 5 schema assertions — ix_recommendations_property index exists (migration 014).
    const recommendationsIndexExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ix_recommendations_property'",
    ).get() as { name: string } | undefined;
    if (!recommendationsIndexExists) {
      failures.push('ix_recommendations_property index missing — migration 014 did not apply');
    }

    // 8j. Phase 5 schema assertions — capital_config has hurdle_rate_pct column (migration 015).
    const capitalConfigInfo = db.prepare(
      "PRAGMA table_info(capital_config)",
    ).all() as Array<{ name: string; type: string; dflt_value: string | null }>;
    const hurdleRatePctCol = capitalConfigInfo.find((col) => col.name === 'hurdle_rate_pct');
    if (!hurdleRatePctCol) {
      failures.push('capital_config.hurdle_rate_pct column missing — migration 015 did not apply');
    } else if (hurdleRatePctCol.dflt_value !== '0.08') {
      failures.push(`capital_config.hurdle_rate_pct dflt_value is '${hurdleRatePctCol.dflt_value}' (expected '0.08') — migration 015 default incorrect`);
    }

    // 8k. Phase 5 schema assertions — capital_config has hurdle_rate_ratification column with default 'proposed' (migration 015).
    const hurdleRatRatifCol = capitalConfigInfo.find((col) => col.name === 'hurdle_rate_ratification');
    if (!hurdleRatRatifCol) {
      failures.push('capital_config.hurdle_rate_ratification column missing — migration 015 did not apply');
    } else if (hurdleRatRatifCol.dflt_value !== "'proposed'") {
      failures.push(`capital_config.hurdle_rate_ratification dflt_value is '${hurdleRatRatifCol.dflt_value}' (expected "'proposed'") — migration 015 default incorrect`);
    }

    // 8l. Phase 5 schema assertions — property_onboarding table exists (migration 016).
    const propertyOnboardingExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='property_onboarding'",
    ).get() as { name: string } | undefined;
    if (!propertyOnboardingExists) {
      failures.push('property_onboarding table missing — migration 016 did not apply');
    }

    // 8m. Migration 017/018 schema presence — constraint indexes must exist.
    const marketSeriesTupleIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_market_series_tuple'",
    ).get() as { name: string } | undefined;
    if (!marketSeriesTupleIdx) {
      failures.push('ux_market_series_tuple index missing — migration 017 did not apply');
    }
    const recommendationsVersionedIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_recommendations_versioned'",
    ).get() as { name: string } | undefined;
    if (!recommendationsVersionedIdx) {
      failures.push('ux_recommendations_versioned index missing — migration 018 did not apply');
    }

    // 8n. Migration 020 schema presence — property_tax_assessments + tax_appeals tables with
    // expected columns.
    const propertyTaxAssessmentsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='property_tax_assessments'",
    ).get() as { name: string } | undefined;
    if (!propertyTaxAssessmentsExists) {
      failures.push('property_tax_assessments table missing — migration 020 did not apply');
    } else {
      const cols = (db.prepare('PRAGMA table_info(property_tax_assessments)').all() as Array<{ name: string }>).map((c) => c.name);
      const expected = ['id', 'property_id', 'tax_year', 'jurisdiction', 'assessed_value', 'assessment_ratio', 'millage_rate', 'annual_tax_billed', 'source', 'as_of', 'created_at'];
      for (const col of expected) {
        if (!cols.includes(col)) failures.push(`property_tax_assessments.${col} column missing — migration 020 did not apply`);
      }
    }
    const taxAppealsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tax_appeals'",
    ).get() as { name: string } | undefined;
    if (!taxAppealsExists) {
      failures.push('tax_appeals table missing — migration 020 did not apply');
    } else {
      const cols = (db.prepare('PRAGMA table_info(tax_appeals)').all() as Array<{ name: string }>).map((c) => c.name);
      const expected = ['id', 'property_id', 'tax_year', 'status', 'filed_date', 'est_savings_annual', 'realized_savings_annual', 'notes', 'created_at', 'updated_at'];
      for (const col of expected) {
        if (!cols.includes(col)) failures.push(`tax_appeals.${col} column missing — migration 020 did not apply`);
      }
    }

    // 8o. Migration 020 constraint enforcement — UNIQUE(property_id, tax_year) and the
    // assessment_ratio / tax_appeals.status CHECK constraints reject invalid rows. Each probe
    // runs inside its own db.transaction() so a thrown constraint violation auto-rolls-back —
    // no probe row should ever persist in the warehouse being verified.
    {
      const probeProperty = CANON_PROPERTIES[0]?.id;
      if (probeProperty === undefined) {
        failures.push('migration 020 constraint probe: CANON_PROPERTIES is empty — cannot pick a probe property id');
      } else {
        const rejects = (fn: () => void): boolean => {
          try {
            db.transaction(fn)();
            return false; // did not throw — constraint failed to reject
          } catch {
            return true; // threw as expected — transaction auto-rolled back
          }
        };
        if (!rejects(() => {
          db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES (?, 2026, 'verify-probe')`).run(probeProperty);
          db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES (?, 2026, 'verify-probe')`).run(probeProperty);
        })) {
          failures.push('property_tax_assessments UNIQUE(property_id, tax_year) did not reject a duplicate — migration 020 constraint regression');
        }
        if (!rejects(() => {
          db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, assessment_ratio, source) VALUES (?, 2099, 1.5, 'verify-probe')`).run(probeProperty);
        })) {
          failures.push('property_tax_assessments assessment_ratio CHECK did not reject 1.5 — migration 020 constraint regression');
        }
        if (!rejects(() => {
          db.prepare(`INSERT INTO tax_appeals (id, property_id, tax_year, status) VALUES ('verify-probe-appeal', ?, 2026, 'bogus')`).run(probeProperty);
        })) {
          failures.push('tax_appeals status CHECK did not reject an unrecognized value — migration 020 constraint regression');
        }
        const residue = (db.prepare(`SELECT COUNT(*) AS c FROM property_tax_assessments WHERE source = 'verify-probe'`).get() as { c: number }).c;
        if (residue > 0) {
          failures.push(`migration 020 constraint probe left ${residue} residual row(s) — transaction rollback did not clean up`);
        }
      }
    }

    // 8p. Migration 021 schema presence — recommendation_feedback table with expected columns.
    const recommendationFeedbackExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recommendation_feedback'",
    ).get() as { name: string } | undefined;
    if (!recommendationFeedbackExists) {
      failures.push('recommendation_feedback table missing — migration 021 did not apply');
    } else {
      const cols = (db.prepare('PRAGMA table_info(recommendation_feedback)').all() as Array<{ name: string }>).map((c) => c.name);
      const expected = ['id', 'subject_kind', 'subject_id', 'decision', 'decided_at', 'note'];
      for (const col of expected) {
        if (!cols.includes(col)) failures.push(`recommendation_feedback.${col} column missing — migration 021 did not apply`);
      }
    }

    // 8q. Migration 021 constraint enforcement — subject_kind CHECK rejects an unrecognized
    // value (probe wrapped in a transaction; auto-rolled back on throw).
    {
      let badSubjectKindRejected = false;
      try {
        db.transaction(() => {
          db.prepare(`INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at) VALUES ('verify-probe-fb', 'bogus', 'x', 'accept', '2026-01-01')`).run();
        })();
      } catch {
        badSubjectKindRejected = true;
      }
      if (!badSubjectKindRejected) {
        failures.push('recommendation_feedback subject_kind CHECK did not reject an unrecognized value — migration 021 constraint regression');
      }
      const residue = (db.prepare(`SELECT COUNT(*) AS c FROM recommendation_feedback WHERE id = 'verify-probe-fb'`).get() as { c: number }).c;
      if (residue > 0) failures.push('migration 021 constraint probe left a residual row — transaction rollback did not clean up');
    }

    // 8r. Migration 022 schema presence — insurance_loss_events table + property_insurance_policies
    // deductible/coverage_limit columns.
    const insuranceLossEventsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='insurance_loss_events'",
    ).get() as { name: string } | undefined;
    if (!insuranceLossEventsExists) {
      failures.push('insurance_loss_events table missing — migration 022 did not apply');
    } else {
      const cols = (db.prepare('PRAGMA table_info(insurance_loss_events)').all() as Array<{ name: string }>).map((c) => c.name);
      const expected = ['id', 'property_id', 'policy_ref', 'loss_date', 'cause', 'gross_incurred', 'paid', 'reserve', 'source', 'created_at'];
      for (const col of expected) {
        if (!cols.includes(col)) failures.push(`insurance_loss_events.${col} column missing — migration 022 did not apply`);
      }
    }
    const policyCols = (db.prepare('PRAGMA table_info(property_insurance_policies)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!policyCols.includes('deductible')) {
      failures.push('property_insurance_policies.deductible column missing — migration 022 did not apply');
    }
    if (!policyCols.includes('coverage_limit')) {
      failures.push('property_insurance_policies.coverage_limit column missing — migration 022 did not apply');
    }

    // 8s. Migration 022 constraint enforcement — UNIQUE(property_id, loss_date, cause,
    // gross_incurred) rejects a duplicate loss occurrence (probe wrapped in a transaction;
    // auto-rolled back on throw).
    {
      const probeProperty2 = CANON_PROPERTIES[0]?.id;
      if (probeProperty2 === undefined) {
        failures.push('migration 022 constraint probe: CANON_PROPERTIES is empty — cannot pick a probe property id');
      } else {
        let dupRejected = false;
        try {
          db.transaction(() => {
            db.prepare(`INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source) VALUES ('verify-probe-loss-1', ?, '2026-01-01', 'fire', 1000, 'verify-probe')`).run(probeProperty2);
            db.prepare(`INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source) VALUES ('verify-probe-loss-2', ?, '2026-01-01', 'fire', 1000, 'verify-probe')`).run(probeProperty2);
          })();
        } catch {
          dupRejected = true;
        }
        if (!dupRejected) {
          failures.push('insurance_loss_events UNIQUE(property_id, loss_date, cause, gross_incurred) did not reject a duplicate — migration 022 constraint regression');
        }
        const residue = (db.prepare(`SELECT COUNT(*) AS c FROM insurance_loss_events WHERE source = 'verify-probe'`).get() as { c: number }).c;
        if (residue > 0) failures.push(`migration 022 constraint probe left ${residue} residual row(s) — transaction rollback did not clean up`);
      }
    }

    // 9. Re-ingest smoke — exercise the parser-version RESTALE re-derive path, which verify otherwise
    //    never hits (it builds a fresh DB). Stale every committed import's parser_version, re-ingest the
    //    same files (→ in-place re-derive), then assert the re-derive is idempotent (same basis), empties
    //    no period, and advances every committed row to the current parser version.
    const basisBefore = new Map((db.prepare(
      "SELECT file_name, basis FROM import_batches WHERE status = 'committed'",
    ).all() as Array<{ file_name: string; basis: string }>).map((r) => [r.file_name, r.basis]));
    const committedBefore = basisBefore.size;
    db.prepare("UPDATE import_batches SET parser_version = 0 WHERE status = 'committed'").run();
    for (const f of files) {
      await ingestFile(db, join(FINANCIALS_DIR, f), {
        rawDir: join(tmp, 'raw'), importedAt: new Date().toISOString(), importedBy: 'warehouse-verify-reingest',
      });
    }
    const committedAfter = db.prepare(
      "SELECT id, file_name, basis, parser_version FROM import_batches WHERE status = 'committed' ORDER BY file_name",
    ).all() as Array<{ id: number; file_name: string; basis: string; parser_version: number }>;
    if (committedAfter.length !== committedBefore) {
      failures.push(`re-ingest smoke: committed count changed ${committedBefore} -> ${committedAfter.length} (restale re-derive lost/added an import)`);
    }
    for (const c of committedAfter) {
      if (basisBefore.has(c.file_name) && basisBefore.get(c.file_name) !== c.basis) {
        failures.push(`re-ingest smoke: basis drift on re-derive for ${c.file_name}: ${basisBefore.get(c.file_name)} -> ${c.basis}`);
      }
      const active = (db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE import_id = ? AND is_active = 1").get(c.id) as { n: number }).n;
      if (active === 0) failures.push(`re-ingest smoke: committed import ${c.file_name} has 0 active ledger rows after re-derive (emptied period)`);
      if (c.parser_version < PARSER_VERSION) failures.push(`re-ingest smoke: ${c.file_name} still below parser_version ${PARSER_VERSION} after re-ingest (${c.parser_version})`);
    }
    console.log(`re-ingest smoke: ${committedAfter.length} committed imports re-derived in place (v0 -> v${PARSER_VERSION}), 0 emptied, basis stable`);

    // 10. SF-less entity efficiency cohort ratchet — any CANON_PROPERTIES entry with rentableSf null
    // must score neutral expenseEfficiency (50). A violation means the entity joined the revenue-ratio
    // expense percentile cohort despite having no comparable operating-expense profile (defect class:
    // solar royalty joining the accrual building cohort after 8ca91a5 relabeled 6 QB Desktop imports).
    // This ratchet turns a latent capital-allocation artifact into a gate failure automatically.
    const sfLessIds = CANON_PROPERTIES.filter((p) => p.rentableSf == null).map((p) => p.id);
    for (const id of sfLessIds) {
      const s = scores.find((score) => score.propertyId === id);
      if (s !== undefined && s.subScores.expenseEfficiency !== 50) {
        failures.push(
          `SF-less entity '${id}' scored expenseEfficiency ${s.subScores.expenseEfficiency} (expected 50) ` +
          `— non-real-estate entity joined the expense-ratio percentile cohort (cohort-exclusion regression)`,
        );
      }
    }

    // 11. APPROVE-PATH acceptance over REAL data — the H3 (approve-only NOI sign-flip) class lives
    //     in approveImport's re-resolution, which steps 1-10 never exercise (they only auto-commit at
    //     ingest). Build a second isolated warehouse, force every fully-mapped file into pending-review
    //     (autoCommitThreshold 0.99), then APPROVE each one — asserting that every dual-side account key
    //     (gas/electric/water/bad-debt-expense in the PFI seed) preserves its ingest-time side: the
    //     income-side and opex side-sums for each such key must be IDENTICAL pre vs post approve. A
    //     future approve-path regression on ANY dual-side account — not just the one Gas unit fixture —
    //     trips here against the real seed.
    {
      const adb = openWarehouse(join(tmp, 'approve-verify.sqlite'));
      seedPropertyMaster(adb);
      seedMappingsFromFile(adb, SEED_PATH);
      const dualKeys = dualSideAccountKeys(adb);
      let approved = 0;
      let dualRowsChecked = 0;
      for (const f of files) {
        const r = await ingestFile(adb, join(FINANCIALS_DIR, f), {
          rawDir: join(tmp, 'approve-raw'),
          importedAt: new Date().toISOString(),
          importedBy: 'warehouse-verify-approve',
          autoCommitThreshold: 0.99, // force fully-mapped imports through the review queue
        });
        if (r.status !== 'pending-review' || r.importId == null) continue;

        // Snapshot the dual-side side-sums from the ingest-time (inactive) rows for THIS import.
        const before = adb.prepare(
          'SELECT raw_account, classification, amount FROM ledger_entries WHERE import_id = ?',
        ).all(r.importId) as Array<{ raw_account: string; classification: string; amount: number }>;
        const beforeSums = dualSideSideSums(before, dualKeys);

        const ok = approveImport(adb, r.importId);
        if (!ok.ok) {
          failures.push(`approve-path: approveImport refused a fully-mapped real import (${f}): unmapped=[${ok.unmapped.join('; ')}]${ok.error ? ` error=${ok.error}` : ''}`);
          continue;
        }
        approved += 1;

        // Re-read the now-ACTIVE rows and compare per-key side-sums. Any drift means approve moved a
        // dual-side row across the income/expense divide — the exact NOI sign-flip H3 fixed.
        const after = adb.prepare(
          'SELECT raw_account, classification, amount FROM ledger_entries WHERE import_id = ? AND is_active = 1',
        ).all(r.importId) as Array<{ raw_account: string; classification: string; amount: number }>;
        const afterSums = dualSideSideSums(after, dualKeys);
        for (const [k, b] of beforeSums) {
          dualRowsChecked += 1;
          const a = afterSums.get(k) ?? { income: 0, opex: 0 };
          if (Math.abs(a.income - b.income) > INCOME_TIE_TOLERANCE || Math.abs(a.opex - b.opex) > INCOME_TIE_TOLERANCE) {
            failures.push(
              `approve-path NOI sign-flip on dual-side account '${k}' in ${f}: ` +
              `income ${b.income.toFixed(2)} -> ${a.income.toFixed(2)}, opex ${b.opex.toFixed(2)} -> ${a.opex.toFixed(2)} ` +
              `(approve re-resolution moved a row across the income/expense divide)`,
            );
          }
        }
      }
      console.log(`approve-path: ${approved} forced-pending real imports approved; ${dualRowsChecked} dual-side account-key side-sums preserved across approve (keys: ${[...dualKeys].join(', ') || 'none'})`);
      adb.close();
    }

    db.close();
  } finally {
    // Windows AV/EDR real-time scanning can transiently hold a handle on the freshly-written
    // better-sqlite3 file right after close(), racing this delete (EPERM/EBUSY). maxRetries lets
    // Node's built-in linear-backoff retry (fs docs: recursive rm only) absorb that race; the
    // outer catch makes a still-locked tmp dir non-fatal so a real PASS/FAILED result (from
    // `failures` below) is never masked by a bare cleanup stack trace.
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.warn(`warehouse:verify — temp dir cleanup failed, left behind (non-fatal): ${tmp}`, e);
    }
  }

  if (failures.length > 0) {
    console.error('\nwarehouse:verify FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log('\nwarehouse:verify PASSED: 0 empty-parse, 0 foot-mismatch, 0 unmapped on committed, ' +
    `committed >= ${MIN_COMMITTED}, income ties within $${INCOME_TIE_TOLERANCE}, ` +
    `unknown-basis <= ${MAX_UNKNOWN_BASIS}, ` +
    `no score-band collapse (< ${Math.round(SINGLE_BAND_COLLAPSE_SHARE * 100)}% single-bucket), ` +
    `integrity invariants hold, re-ingest re-derive idempotent, ` +
    `approve-path dual-side sides preserved over the real seed, ` +
    `SF-less cohort exclusion verified (${CANON_PROPERTIES.filter((p) => p.rentableSf == null).length} non-operating entity/entities), ` +
    `property_insurance_policies schema present (migration 008), ` +
    `debt_positions schema present (migration 009), ` +
    `lease_events schema present (migration 011), ` +
    `prospect_demand_events schema present (migration 012), ` +
    `Phase 5 tables present (migrations 013-016: market_series, recommendations, hurdle_rate columns, property_onboarding), ` +
    `ux_market_series_tuple index present (migration 017), ` +
    `ux_recommendations_versioned index present (migration 018), ` +
    `property_tax_assessments/tax_appeals schema + constraints present (migration 020), ` +
    `recommendation_feedback schema + constraints present (migration 021), ` +
    `insurance_loss_events schema + constraints present + property_insurance_policies deductible/coverage_limit columns present (migration 022)`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
