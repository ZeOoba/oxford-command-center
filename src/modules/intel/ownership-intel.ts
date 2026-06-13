// src/modules/intel/ownership-intel.ts
//
// Pure, deterministic roll-ups backing the Ownership Intelligence Center's portfolio KPI
// band. Two helpers only — the *decision* synthesis (attention ranking, action list,
// risks, capital grouping) lives in synthesis.ts and is consumed directly. Here we just
// total the latest FULL-YEAR levels per property (NOI / Oxford-share NOI) and count the
// scores that need ownership attention. No I/O, no React, no clock; inputs untouched.
import type { PeriodMetrics, PropertyScore } from './analytics-hooks';

export interface PortfolioTotals {
  /** Number of properties with at least one full-year metric row. */
  propertyCount: number;
  /** Σ of each property's latest full-year NOI. */
  portfolioNoi: number;
  /** Σ of each property's latest full-year Oxford-share NOI. */
  oxfordNoi: number;
}

/** Roll metric rows into the portfolio band. Only full-year rows count toward the level
 *  (YTD is partial — pre-mortem #5); a property contributing only YTD data is excluded
 *  from the count and totals. Each property contributes its LATEST full year. */
export function portfolioTotals(metrics: PeriodMetrics[]): PortfolioTotals {
  // Per property, keep the latest full-year row (period is string-sortable: 'YYYY').
  const latestByProperty = new Map<string, PeriodMetrics>();
  for (const m of metrics) {
    if (m.grainHint !== 'year') continue;
    const cur = latestByProperty.get(m.propertyId);
    if (!cur || m.period.localeCompare(cur.period) > 0) latestByProperty.set(m.propertyId, m);
  }
  let portfolioNoi = 0;
  let oxfordNoi = 0;
  for (const m of latestByProperty.values()) {
    portfolioNoi += m.noi;
    oxfordNoi += m.oxfordNoi;
  }
  return { propertyCount: latestByProperty.size, portfolioNoi, oxfordNoi };
}

export interface AttentionCounts {
  /** Properties in the orange or red attention bands — what ownership must look at now. */
  needingAttention: number;
  /** Properties the engine flagged as disposition candidates. */
  dispositionCandidates: number;
}

/** Count the scores demanding ownership attention (orange+red) and disposition candidates. */
export function attentionCounts(scores: PropertyScore[]): AttentionCounts {
  let needingAttention = 0;
  let dispositionCandidates = 0;
  for (const s of scores) {
    if (s.attentionBand === 'orange' || s.attentionBand === 'red') needingAttention += 1;
    if (s.capitalAction === 'disposition-candidate') dispositionCandidates += 1;
  }
  return { needingAttention, dispositionCandidates };
}
