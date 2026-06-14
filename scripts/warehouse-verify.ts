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
// Exits 1 with a clear message on any failure. Local-only gate (wired into `npm run gate`,
// NOT gate:ci — CI runners have no FINANCIALS_DIR).
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { classificationSide, resolveMapping, sectionSide, seedMappingsFromFile } from '../server/warehouse/mapping';
import { basisCoverage } from '../server/warehouse/data-quality';
import { PARSER_VERSION, parseQbExcel } from '../server/warehouse/parse/qb-excel';
import { propertyPeriodMetrics } from '../server/warehouse/metrics';
import { noiMatrix } from '../server/warehouse/queries';
import { CANON_PROPERTIES, seedPropertyMaster } from '../server/warehouse/property-master';
import { NOI_INCOME_CLASSES } from '../src/contracts/warehouse';
import { MIN_PROPERTIES_FOR_COLLAPSE_CHECK, SINGLE_BAND_COLLAPSE_SHARE, scoreBandDistribution, scoreProperties } from '../server/warehouse/scores';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
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
    const m = resolveMapping(db, a.name, imp.property_id, a.section);
    if (classificationSide(m.classification) !== 'income') continue; // e.g. 'excluded'
    sum += a.total;
  }
  return sum;
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
      SELECT id, file_name, raw_path, property_id FROM import_batches
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
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
    `SF-less cohort exclusion verified (${CANON_PROPERTIES.filter((p) => p.rentableSf == null).length} non-operating entity/entities)`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
