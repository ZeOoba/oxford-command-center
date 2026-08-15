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
import { scoreDebtPositionsWithTrust } from '../server/warehouse/debt-scoring';
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

    // Round 19b (adversarial refute, MEDIUM-HIGH — reproduced): the trust check MUST precede the
    // empty-scores early return. Round 19a put it after, so the WORST case — a damaged write that
    // destroyed every active row — routed straight around it and exited 0 with
    // "no active debt positions to score", an affirmative claim of an unlevered portfolio when
    // the truth is "we destroyed the rows and don't know". Verified-null vs inferred-null, in the
    // very guard written to prevent it.
    // Round 19d (adversarial refute, MEDIUM — reproduced): gate on 'degraded' ONLY, matching
    // persistDebtScores. 19b refused on ANY standing marker here while the persistence layer
    // deliberately allowed 'refused' rows — and since this CLI is the sole production caller of
    // persistDebtScores, that allowance was UNREACHABLE. Under 'refused' the figures are the last
    // TRUSTED book, a measured breach survives, every signalReason is annotated, and the row is
    // stamped book_trust='refused' — safe to record, and the gap it fills is a real one.
    // Round 19g (adversarial refute of 19f, MEDIUM-HIGH — reproduced): this still gated on the RAW
    // MARKER (readLastSnapshotRefusal), never re-pointed at readDebtBookTrust when round 19e taught
    // it a SECOND way to reach 'degraded' — an all-unattributed active book, no marker required. On
    // that state the marker check passed, scoreDebtPositionsWithTrust correctly returned
    // scores:[], and the code fell straight to the empty-scores branch: "no active debt positions
    // to score", exit 0 — the identical affirmative-unlevered-claim defect the comment above says
    // this guard exists to prevent, just reached via the path this guard forgot to check. Fixed by
    // consuming the SAME bookTrust scoreDebtPositionsWithTrust already computed, rather than a
    // second, narrower, marker-only read.
    const { scores, bookTrust } = scoreDebtPositionsWithTrust(db, metrics, marketRateFiveYearTreasury);
    if (bookTrust === 'degraded') {
      console.error(
        `debt-scores-snapshot: REFUSED -- the debt book is 'degraded' (the last snapshot write ` +
          'lost rows, or an active loan could not be attributed to a property). Scores derived ' +
          'from it would be fabricated, and debt_scores is a permanent append-only history with ' +
          'no retraction path, so nothing was written.',
      );
      return 1;
    }

    if (scores.length === 0) {
      console.log('debt-scores-snapshot: no active debt positions to score -- debt_scores unchanged.');
      return 0;
    }

    const result = persistDebtScores(db, scores, metrics, snapshotDate, governors.refiTriggerBps);
    console.log(`debt-scores-snapshot: ${result.written} score(s) written (snapshot_date=${snapshotDate})`);
    if (result.skipped.length > 0) {
      // Round 19: print each skip's OWN reason. This line previously hardcoded "(no full-year NOI
      // period)" — the only skip reason that existed when it was written — so the new book-trust
      // refusal would have been reported to the operator under a wholly unrelated cause, sending
      // them to look for missing NOI data while the real problem was a damaged debt book.
      console.log(`  ${result.skipped.length} score(s) skipped:`);
      for (const s of result.skipped) {
        console.log(`    ${s.propertyId}: ${s.reason}`);
      }
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
