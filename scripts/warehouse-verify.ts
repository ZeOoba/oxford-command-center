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
import { parseQbExcel } from '../server/warehouse/parse/qb-excel';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { NOI_INCOME_CLASSES } from '../src/contracts/warehouse';

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

    // 5. NOI matrix (income classes from the contract; opex is the single fixed negative pivot)
    const noi = db.prepare(`
      SELECT property_id, period,
        ROUND(SUM(CASE WHEN classification IN (${incomePlaceholders}) THEN amount
                       WHEN classification = 'opex' THEN -amount ELSE 0 END), 2) AS noi
      FROM ledger_entries WHERE is_active = 1
      GROUP BY property_id, period ORDER BY property_id, period
    `).all(...NOI_INCOME_CLASSES);
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
    `committed >= ${MIN_COMMITTED}, income ties within $${INCOME_TIE_TOLERANCE}, unknown-basis <= ${MAX_UNKNOWN_BASIS}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
