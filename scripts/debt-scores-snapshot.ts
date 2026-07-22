// scripts/debt-scores-snapshot.ts
//
// One-shot snapshot: scores all active debt positions (same logic as GET /api/warehouse/debt/scores)
// and persists the result into debt_scores (migration 010) via persistDebtScores(). Built after the
// 2026-07-21 adversarial REFUTE pass on debt-scoring.ts confirmed and fixed 3 real bugs — debt_scores
// stayed empty until the underlying engine was verified (see debt-scoring.test.ts R1/R2/R3).
//
// This is a manually/scheduled-invokable snapshot action, not wired into the read-only GET /scores
// route — that route is documented as a pure read (H6 read boundary) and should stay side-effect-free.
//
// Usage: npx tsx scripts/debt-scores-snapshot.ts [--db <path>] [--snapshot-date YYYY-MM-DD]
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { scoreDebtPositions } from '../server/warehouse/debt-scoring';
import { persistDebtScores } from '../server/warehouse/debt-scores-persistence';
import { propertyPeriodMetrics } from '../server/warehouse/metrics';
import { loadGovernors } from '../server/warehouse/governors';
import { fetchFredMacro } from '../server/macro/fred';
import { referenceDate } from '../server/config';

export interface CliArgs {
  dbPath?: string;
  snapshotDate?: string;
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
    } else if (arg === '--snapshot-date') {
      const next = argv[i + 1];
      if (!next) throw new Error('missing value for --snapshot-date');
      args.snapshotDate = next;
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
  const dbPath = args.dbPath ?? defaultDbPath();
  const snapshotDate = args.snapshotDate ?? referenceDate();

  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    const metrics = propertyPeriodMetrics(db);
    const governors = loadGovernors(db);

    // Same FRED-fetch pattern as debt-api.ts GET /scores: non-fatal, null market rate suppresses
    // the refi signal rather than failing the whole snapshot.
    let marketRateFiveYearTreasury: number | null = null;
    const fredSnap = await fetchFredMacro().catch(() => null);
    if (fredSnap !== null) {
      const dgs5 = fredSnap.indicators.find((ind) => ind.id === 'DGS5');
      if (dgs5 !== undefined && dgs5.value !== null) {
        marketRateFiveYearTreasury = dgs5.value / 100;
      }
    }

    const scores = scoreDebtPositions(db, metrics, marketRateFiveYearTreasury);
    if (scores.length === 0) {
      console.log('debt-scores-snapshot: no active debt positions to score -- debt_scores unchanged.');
      return 0;
    }

    const result = persistDebtScores(db, scores, metrics, snapshotDate, governors.refiTriggerBps);
    console.log(`debt-scores-snapshot: ${result.written} score(s) written (snapshot_date=${snapshotDate})`);
    if (result.skipped.length > 0) {
      console.log(`  ${result.skipped.length} score(s) skipped (no full-year NOI period): ${result.skipped.map((s) => s.propertyId).join(', ')}`);
    }
  } finally {
    db.close();
  }

  return 0;
}

// Run the CLI only when invoked directly -- importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/debt-scores-snapshot.ts')) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
