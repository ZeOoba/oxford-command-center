// src/modules/intel/ownership-intel.ts
//
// Pure, deterministic roll-ups backing the Ownership Intelligence Center's portfolio KPI
// band. Two helpers only — the *decision* synthesis (attention ranking, action list,
// risks, capital grouping) lives in synthesis.ts and is consumed directly. Here we just
// total the latest FULL-YEAR levels per property (NOI / Oxford-share NOI) and count the
// scores that need ownership attention. No I/O, no React, no clock; inputs untouched.
import { fmtUsdCompact } from '@analytics/index';
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

/** Roll metric rows into the portfolio band for ONE explicit period (the module-level time
 *  control's selection — PFI Phase B.3). Sums each property's row whose `period` matches and
 *  counts those properties. Unlike `portfolioTotals` this honors whatever grain the period is
 *  (full-year OR YTD) — the YTD-partial caveat is surfaced by the module banner, not hidden by
 *  excluding the rows. Absent period / empty input → zeros (null-safe). */
export function portfolioTotalsForPeriod(metrics: PeriodMetrics[], period: string): PortfolioTotals {
  const seen = new Set<string>();
  let portfolioNoi = 0;
  let oxfordNoi = 0;
  for (const m of metrics) {
    if (m.period !== period) continue;
    seen.add(m.propertyId);
    portfolioNoi += m.noi;
    oxfordNoi += m.oxfordNoi;
  }
  return { propertyCount: seen.size, portfolioNoi, oxfordNoi };
}

/** The one-sentence portfolio verdict that opens the morning-briefing hero (PFI Phase B.3).
 *  Deterministic: total NOI (latest full-year `totals` — the scoring basis, NOT the time
 *  control), property count, health-band posture (excellent+good = healthy / watch / concern),
 *  # needing attention (orange+red) and # disposition candidates. Empty → an explicit note. */
export function portfolioVerdict(scores: PropertyScore[], totals: PortfolioTotals): string {
  if (scores.length === 0) return 'No scored properties yet.';
  let healthy = 0;
  let watch = 0;
  let concern = 0;
  let needAttn = 0;
  let disp = 0;
  for (const s of scores) {
    if (s.healthBand === 'excellent' || s.healthBand === 'good') healthy += 1;
    else if (s.healthBand === 'watch') watch += 1;
    else if (s.healthBand === 'concern') concern += 1;
    if (s.attentionBand === 'orange' || s.attentionBand === 'red') needAttn += 1;
    if (s.capitalAction === 'disposition-candidate') disp += 1;
  }
  const n = scores.length;
  const posture = `${fmtUsdCompact(totals.portfolioNoi)} portfolio NOI across ${n} ${
    n === 1 ? 'property' : 'properties'
  }; ${healthy} healthy, ${watch} on watch, ${concern} of concern.`;
  let attn: string;
  if (needAttn === 0) {
    attn = 'No properties need attention.';
  } else {
    const verb = needAttn === 1 ? 'needs' : 'need';
    const dispClause = disp > 0 ? `, ${disp} disposition ${disp === 1 ? 'candidate' : 'candidates'}` : '';
    attn = `${needAttn} ${verb} attention${dispClause}.`;
  }
  return `${posture} ${attn}`;
}
