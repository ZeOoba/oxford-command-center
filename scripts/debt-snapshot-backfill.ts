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
  // 2026-07-24 (H2a/shrinkage-guard reachability fix, refute-review): writeDebtSnapshot refuses
  // to shrink the active book — a total wipe, OR a majority net loss with no replacement — on an
  // unexplained snapshot unless explicitly told the loss is verified. A legitimate refinance or
  // an id rename that keeps the total loan count intact is NOT affected by this guard and never
  // needs this flag. Unlike the automated server/index.ts reload hook (which never gets this
  // flag — see its call site comment), a CLI run is a deliberate human action, so it is the
  // second SUPERVISED surface (alongside POST /snapshot) allowed to confirm a genuine loss.
  allowEmptySupersede?: boolean;
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
    } else if (arg === '--allow-empty-supersede') {
      args.allowEmptySupersede = true;
    }
  }
  return args;
}

function defaultDbPath(): string {
  return process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
}

/**
 * Selects the outcome message/exit-code for a writeDebtSnapshot() result. Pure and directly
 * testable (extracted round 4, adversarial-review Finding 4) — the original inline version
 * checked `result.written === 0` BEFORE `result.refusedEmptySupersede`, so a shrinkage-guard
 * refusal printed "No borrower-direction active loans found ... check the workbook Loan Index
 * tab" — factually wrong on both counts: loans WERE found, and debt_positions is untouched, not
 * empty. The operator was sent to debug the wrong problem. Order matters: refusedEmptySupersede
 * must be checked before written===0, since a refusal is a distinct outcome from a genuinely
 * empty parse.
 */
export function selectOutcome(
  result: { written: number; refusedEmptySupersede: boolean },
  allowEmptySupersedeFlag: boolean,
): { message: string; exitCode: 0 | 1 } | null {
  if (allowEmptySupersedeFlag && !result.refusedEmptySupersede) {
    return {
      message: `  confirmed supersede performed -- ${result.written} active row(s) written (any prior active rows not in this snapshot were retired).`,
      exitCode: 0,
    };
  }
  if (result.refusedEmptySupersede) {
    return {
      message:
        '  Write REFUSED by the shrinkage guard -- see the warning(s) above for the exact reason. No rows were written this run; the prior debt book is untouched. Re-run with --allow-empty-supersede once the loss is verified.',
      exitCode: 1,
    };
  }
  if (result.written === 0) {
    return {
      message:
        '  No borrower-direction active loans found in the Loan Index -- debt_positions remains empty. Check the workbook Loan Index tab.',
      exitCode: 1,
    };
  }
  return null;
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
    const result = writeDebtSnapshot(db, snapshot.loans, snapshotDate, map, {
      allowEmptySupersede: args.allowEmptySupersede === true,
    });

    console.log(`debt-snapshot-backfill: ${result.written} borrower loan(s) written (snapshot_date=${snapshotDate})`);
    if (unresolved.length > 0) {
      console.log(`  ${unresolved.length} borrower loan(s) unattributed (fill Loan Index collateral-property column): ${unresolved.join(', ')}`);
    }
    if (result.errors.length > 0) {
      // Generic label, matching debt-api.ts's POST /snapshot twin (2026-07-24): errors[] now
      // carries several classes, not just FK-validation backstops.
      console.log(`  ${result.errors.length} writeDebtSnapshot warning(s)/error(s): ${result.errors.join('; ')}`);
    }
    const outcome = selectOutcome(result, args.allowEmptySupersede === true);
    if (outcome) {
      console.log(outcome.message);
      if (outcome.exitCode !== 0) return outcome.exitCode;
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
