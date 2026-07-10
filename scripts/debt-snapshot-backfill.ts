// scripts/debt-snapshot-backfill.ts
//
// One-shot backfill: populates warehouse debt_positions from the live ORA Master Workbook's
// Loan Index tab, without needing the full dev server running. Reuses the exact same
// parse -> crosswalk -> writeDebtSnapshot path server/index.ts wires into brain.on('snapshot', ...)
// (the on-refresh hook only fires while the dev server is running and watching the workbook;
// this script invokes that same logic once via CLI so debt_positions can be populated/refreshed
// on demand).
//
// Usage: npx tsx scripts/debt-snapshot-backfill.ts [--db <path>] [--workbook <path>]
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { workbookPath } from '../server/config';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { buildLoanPropertyMap } from '../server/warehouse/property-crosswalk';
import { writeDebtSnapshot } from '../server/warehouse/debt-snapshot';

export interface CliArgs {
  dbPath?: string;
  workbook?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next) throw new Error('missing value for --db');
      args.dbPath = next;
      i += 1;
    } else if (arg === '--workbook') {
      const next = argv[i + 1];
      if (!next) throw new Error('missing value for --workbook');
      args.workbook = next;
      i += 1;
    }
  }
  return args;
}

function defaultDbPath(): string {
  return process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const wbPath = args.workbook ?? workbookPath();
  const dbPath = args.dbPath ?? defaultDbPath();

  console.log(`debt-snapshot-backfill: parsing workbook at ${wbPath}`);
  const { snapshot, flags } = await parseWorkbook(wbPath);
  const loanFlags = flags.filter((f) => /loan/i.test(f.field) || /loan/i.test(f.issue));
  if (loanFlags.length > 0) {
    console.log(`  ${loanFlags.length} Loan Index data-quality flag(s) from parse: ${loanFlags.map((f) => `${f.entity}: ${f.issue}`).join('; ')}`);
  }

  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    const validPropertyIds = new Set(
      (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
    );
    const { map, unresolved } = buildLoanPropertyMap(snapshot.loans, snapshot.properties, validPropertyIds);
    const snapshotDate = snapshot.meta.generatedAt.slice(0, 10);
    const result = writeDebtSnapshot(db, snapshot.loans, snapshotDate, map);

    console.log(`debt-snapshot-backfill: ${result.written} borrower loan(s) written (snapshot_date=${snapshotDate})`);
    if (unresolved.length > 0) {
      console.log(`  ${unresolved.length} borrower loan(s) unattributed (fill Loan Index collateral-property column): ${unresolved.join(', ')}`);
    }
    if (result.errors.length > 0) {
      console.log(`  ${result.errors.length} FK-validation error(s): ${result.errors.join('; ')}`);
    }
    if (result.written === 0) {
      console.log('  No borrower-direction active loans found in the Loan Index -- debt_positions remains empty. Check the workbook Loan Index tab.');
      return 1;
    }
  } finally {
    db.close();
  }

  return 0;
}

// Run the CLI only when invoked directly -- importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/debt-snapshot-backfill.ts')) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
