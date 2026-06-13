// scripts/warehouse-verify.ts — systematized acceptance gate for the financial warehouse.
//
// Builds a FRESH warehouse in a temp dir (os.tmpdir — never data/warehouse), runs the
// same seed + ingest pipeline over FINANCIALS_DIR, then asserts:
//   1. zero 'empty-parse' data-quality issues (adapter/layout regressions)
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
import { parseQbExcel } from '../server/warehouse/parse/qb-excel';
import { seedPropertyMaster } from '../server/warehouse/property-master';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');
const MIN_COMMITTED = 32;
const INCOME_TIE_TOLERANCE = 1; // dollars

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
    const ledgerIncome = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries
      WHERE import_id = ? AND is_active = 1
        AND classification IN ('revenue', 'recovery', 'other-income')
    `);
    for (const imp of committed) {
      const ledger = (ledgerIncome.get(imp.id) as { s: number }).s;
      const expected = await expectedIncomeFor(db, imp);
      const delta = Math.abs(ledger - expected);
      if (delta > INCOME_TIE_TOLERANCE) {
        failures.push(`income tie failed for ${imp.file_name}: active ledger ${ledger.toFixed(2)} vs file ${expected.toFixed(2)} (delta ${delta.toFixed(2)})`);
      }
    }
    console.log(`income tie: ${committed.length} committed imports checked (tolerance $${INCOME_TIE_TOLERANCE})`);

    // 5. NOI matrix
    const noi = db.prepare(`
      SELECT property_id, period,
        ROUND(SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                       WHEN classification = 'opex' THEN -amount ELSE 0 END), 2) AS noi
      FROM ledger_entries WHERE is_active = 1
      GROUP BY property_id, period ORDER BY property_id, period
    `).all();
    console.table(noi);
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('\nwarehouse:verify FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log('\nwarehouse:verify PASSED: 0 empty-parse, 0 unmapped on committed, committed >= ' +
    `${MIN_COMMITTED}, income ties within $${INCOME_TIE_TOLERANCE}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
