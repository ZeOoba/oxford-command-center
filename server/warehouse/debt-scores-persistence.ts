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
//
// NOI BASIS DISCONTINUITY (2026-08-22, marked 2026-08-24 — migration 028): scoreDebtPositions'
// NOI basis changed from 100%-basis (m.noi) to ownership-adjusted (m.oxfordNoi) on 2026-08-22
// (9cb6169). Rows written before it, for any fractionally-owned property, carry DSCR/debt_yield
// computed on the OLD (100%-basis) NOI; rows written after carry the corrected (ownership-
// adjusted) basis. There is no retraction path (see above), so migration 028 added a noi_basis
// column instead: existing rows default to '100pct' (true by construction — 9cb6169 is the only
// commit that has ever changed this table's NOI derivation), and every row this module writes
// from here on is stamped 'oxford-share'. A trend reader spanning 2026-08-22 for a fractionally-
// owned property can now tell a basis correction apart from a real change in debt position
// instead of seeing an unexplained step-change.
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
      debt_yield, signal, signal_reason, refi_trigger_bps, capital_config_version, score, score_band,
      book_trust, noi_basis
    ) VALUES (
      @propertyId, @scoredAt, @snapshotDate, @noiPeriod, @dscr, @dscrHeadroom, @ltv, @ltvHeadroom,
      @debtYield, @signal, @signalReason, @refiTriggerBps, @capitalConfigVersion, @score, @scoreBand,
      @bookTrust, @noiBasis
    )
  `);

  const skipped: PersistDebtScoresResult['skipped'] = [];
  const tx = db.transaction((rows: DebtScore[]) => {
    // Round 19 (H1 — 2026-07-27 integrity sweep, HIGH): refuse to append while the book is
    // distrusted. This table is a PERMANENT append-only trend history with no retraction path, so
    // a governor verdict written under a degraded/refused marker is not merely wrong for the
    // duration of the damage — it is wrong forever, and every downstream trend consumer reads it
    // as fact long after the book recovers. This module's own header says the writer was delayed
    // until the scoring defects were fixed precisely so unverified scores would not be "baked
    // into a permanent trend history"; that reasoning applies with more force to a book the
    // warehouse has explicitly marked untrusted than to one merely suspected of bugs.
    //
    // Checked from bookTrust (set by scoreDebtPositions inside the same transaction that read the
    // rows) rather than by re-reading the marker here: re-reading would be a SECOND, later
    // observation and could disagree with the state the scores were actually computed under.
    // Trust travels WITH the data.
    // Round 19b (adversarial refute, MEDIUM): gate on 'degraded' ONLY, not on `!== 'trusted'`.
    // Round 19a swept 'refused' in too — but under a refusal zero rows changed, the figures ARE
    // the last trusted book, and applyBookTrust deliberately preserves a measured breach there.
    // Refusing to append for the whole refusal window therefore stopped recording a STANDING
    // Hard-Invariant-4 breach in the permanent trend history: a later reader would see a gap
    // where a breach actually persisted. A 'refused'-era row is written, and stamped with its
    // trust level (migration 027) so no reader can mistake it for a clean-book observation.
    const distrusted = rows.filter((s) => s.bookTrust === 'degraded');
    if (distrusted.length > 0) {
      for (const s of distrusted) {
        skipped.push({
          propertyId: s.propertyId,
          reason: `debt book is '${s.bookTrust}' — refusing to append a governor verdict to the permanent trend history`,
        });
      }
      // All-or-nothing: a partial write would leave the history claiming the untouched properties
      // were scored against a healthy book on this date, which is exactly the false-provenance
      // problem. Matches writeDebtSnapshot's own all-or-nothing refusal posture.
      return 0;
    }

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
        // Round 19b: the row states its own provenance (migration 027), so a refusal-window
        // observation can never be mistaken for a clean-book one by a future trend reader.
        bookTrust: s.bookTrust,
        // Migration 028: every row this module writes uses the ownership-adjusted basis (see
        // module header) — 'oxford-share', never the old '100pct' default, which only pre-
        // migration historical rows carry.
        noiBasis: 'oxford-share',
      });
      count++;
    }
    return count;
  });

  const written = tx(scores);
  return { written, skipped };
}
