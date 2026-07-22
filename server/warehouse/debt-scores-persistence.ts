// server/warehouse/debt-scores-persistence.ts
//
// Persists scoreDebtPositions() output into the debt_scores table (migration 010) for trend
// tracking — the writer that migration's own header comment describes but that never existed
// until this pass. Built only after the 2026-07-21 adversarial REFUTE pass on debt-scoring.ts
// confirmed and fixed 3 real bugs (see R1/R2/R3 regressions in debt-scoring.test.ts) — persisting
// unverified scores would have baked those defects into a permanent trend history.
//
// Pure append: every call writes new rows (one per score), never an upsert. debt_scores is a
// history table; a caller wanting "latest only" queries `ORDER BY scored_at DESC, id DESC LIMIT 1`
// per property (the `id DESC` tiebreaker matters: scored_at is wall-clock write time, distinct
// from snapshot_date the business date, but two runs within the same second are possible — same
// convention as acq_scores/api.ts/capital-allocation.ts/brain-report.ts elsewhere in this repo).
import type { WarehouseDb } from './db';
import type { DebtScore } from '../../src/contracts/debt';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import { latestFullYearPeriod } from './metrics';

export interface PersistDebtScoresResult {
  written: number;
  skipped: Array<{ propertyId: string; reason: string }>;
}

export function persistDebtScores(
  db: WarehouseDb,
  scores: DebtScore[],
  metrics: PeriodMetrics[],
  snapshotDate: string,
  refiTriggerBps: number,
): PersistDebtScoresResult {
  const metricsByProperty = new Map<string, PeriodMetrics[]>();
  for (const m of metrics) {
    const list = metricsByProperty.get(m.propertyId);
    if (list) list.push(m);
    else metricsByProperty.set(m.propertyId, [m]);
  }

  const insert = db.prepare(`
    INSERT INTO debt_scores (
      property_id, scored_at, snapshot_date, noi_period, dscr, dscr_headroom, ltv, ltv_headroom,
      debt_yield, signal, signal_reason, refi_trigger_bps, capital_config_version, score, score_band
    ) VALUES (
      @propertyId, @scoredAt, @snapshotDate, @noiPeriod, @dscr, @dscrHeadroom, @ltv, @ltvHeadroom,
      @debtYield, @signal, @signalReason, @refiTriggerBps, @capitalConfigVersion, @score, @scoreBand
    )
  `);

  const skipped: PersistDebtScoresResult['skipped'] = [];
  const tx = db.transaction((rows: DebtScore[]) => {
    let count = 0;
    for (const s of rows) {
      const noiPeriod = latestFullYearPeriod(metricsByProperty.get(s.propertyId) ?? []);
      if (noiPeriod === null) {
        // noi_period is NOT NULL in the schema — a property with no full-year period (e.g.
        // YTD-only coverage) has no true value to write here; skip rather than fabricate one
        // (Hard Invariant 7).
        skipped.push({ propertyId: s.propertyId, reason: 'no full-year NOI period available for this property' });
        continue;
      }
      insert.run({
        propertyId: s.propertyId,
        // scored_at = actual write time (wall-clock), distinct from snapshot_date (the business
        // date the caller is scoring as-of) — see module header comment.
        scoredAt: new Date().toISOString(),
        snapshotDate,
        noiPeriod,
        dscr: s.dscr,
        dscrHeadroom: s.dscrHeadroom,
        ltv: s.ltv,
        ltvHeadroom: s.ltvHeadroom,
        debtYield: s.debtYield,
        signal: s.signal,
        signalReason: s.signalReason,
        refiTriggerBps,
        capitalConfigVersion: s.capitalConfigVersion,
        score: s.score,
        scoreBand: s.scoreBand,
      });
      count++;
    }
    return count;
  });

  const written = tx(scores);
  return { written, skipped };
}
