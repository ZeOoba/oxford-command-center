// server/warehouse/insurance-history.ts
//
// Insurance premium history builder (2026-09-23 review, Task 24). Read-only display aggregation
// for GET /api/warehouse/insurance/analysis/history — NOT consumed by any scoring, benchmark,
// alert or calibration path. Rows stay keyed by the RAW policy-line key
// ('ins-<stem>-<line>'); resolveInsuranceProperty supplies the display name only, never a re-key.
//
// Two deliberate divergences from server/warehouse/insurance-analysis.ts's own reduction
// (buildInsuranceAnalysis), both accepted as history-display-only limits, not bugs:
//   1. No dedupeLatest step — this builder calls collapseSameTermReissues directly on the raw
//      rows and stops there (plus its own DUP_WINDOW_DAYS re-key filter below). The engine's
//      dedupeLatest exists to pick one CURRENT row per line for a point-in-time snapshot; a
//      history reader wants every surviving term across years, not just the latest one, so
//      running dedupeLatest here would collapse the very renewal history this builder exists to
//      show.
//   2. A same-term reissue whose LATEST capture is unpriced/undated drops the whole term,
//      including whatever priced premium an earlier (superseded) capture of that same term had.
//      collapseSameTermReissues picks one winning row per term before this builder's own
//      undated/unpriced/negative filter runs (see buildPremiumHistory's "Order of reductions"
//      below), so an unpriced latest capture is never rescued by falling back to a priced
//      earlier one — the term is simply absent from that policy year's total.
import type { PremiumHistoryReport } from '../../src/contracts/insurance-analysis';
import { collapseSameTermReissues, type CollapsibleInsuranceRow } from './insurance-analysis';
import { resolveInsuranceProperty } from './insurance-property-map';

/** One property_insurance_policies row as GET /history SELECTs it: the CollapsibleInsuranceRow
 *  columns the engine's same-term rule needs (id, policy_number, effective/expiration_date,
 *  policy_type, source_date) plus the premium. */
export type PremiumHistoryRow = CollapsibleInsuranceRow & { premium_annual: number | null };

/** A same-premium term dated less than one policy year after a prior KEPT term of the same line is
 *  a re-key of that term, not a renewal. The 3034 Westerville duplicate premium row in
 *  data_quality_issues (2024-09-24 vs 2025-09-18 = 359d) is the motivating case; a genuine flat
 *  renewal lands at >= 365d and is kept. */
const DUP_WINDOW_DAYS = 365;

/**
 * Per-line premium terms + policy-year totals.
 *
 * Order of reductions (each term is summed exactly once):
 *   1. collapseSameTermReissues — the analysis engine's SAME-TERM REISSUE rule: rows of one line
 *      with identical effective_date + expiration_date collapse to the most recently captured
 *      row (source_date, then effective_date, then id). This is what the live 9620 State 350
 *      GL/Property pairs need (two rows each, eff/exp 2025-10-18/2026-10-18, different
 *      premium/policy_number); without it policy-year 2025 counted both premiums.
 *   2. Skip undated / unpriced / negative rows.
 *   3. Same-premium duplicate window (DUP_WINDOW_DAYS), compared against KEPT terms only — a
 *      dropped duplicate never shadows a later genuine flat renewal.
 *
 * Documented limits (accepted, not bugs to fix here):
 *   - A same-premium renewal genuinely re-dated EARLY (gap < DUP_WINDOW_DAYS) is collapsed as a
 *     duplicate; same-premium consecutive renewals are rare and the DQ re-key case dominates.
 *   - `policyType` is the first surviving row's label for the line; label drift between terms
 *     of one line is not surfaced.
 */
export function buildPremiumHistory(rows: PremiumHistoryRow[], masterNames: ReadonlyMap<string, string>): PremiumHistoryReport {
  const byLine = new Map<string, { policyType: string; terms: Array<{ effectiveDate: string; premium: number }> }>();
  for (const r of collapseSameTermReissues(rows)) {
    if (!r.effective_date || r.premium_annual === null || r.premium_annual < 0) continue;
    const e = byLine.get(r.property_id) ?? { policyType: r.policy_type, terms: [] };
    e.terms.push({ effectiveDate: r.effective_date.slice(0, 10), premium: r.premium_annual });
    byLine.set(r.property_id, e);
  }
  const lines: PremiumHistoryReport['lines'] = [];
  for (const [lineKey, e] of byLine) {
    const sorted = e.terms.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const terms: typeof sorted = [];
    for (const t of sorted) {
      const isDup = terms.some((p) =>
        p.premium === t.premium && (Date.parse(t.effectiveDate) - Date.parse(p.effectiveDate)) / 86_400_000 < DUP_WINDOW_DAYS);
      if (!isDup) terms.push(t);
    }
    lines.push({ lineKey, property: resolveInsuranceProperty(lineKey, masterNames).name, policyType: e.policyType, terms });
  }
  // byYear.lines = DISTINCT policy lines with a term in that year (not term count — a mid-year
  // rollover is still one line).
  const years = new Map<number, { premium: number; lineKeys: Set<string> }>();
  for (const l of lines) for (const t of l.terms) {
    const y = Number(t.effectiveDate.slice(0, 4));
    const cur = years.get(y) ?? { premium: 0, lineKeys: new Set<string>() };
    cur.premium += t.premium;
    cur.lineKeys.add(l.lineKey);
    years.set(y, cur);
  }
  return {
    byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, premium: v.premium, lines: v.lineKeys.size })),
    lines: lines.sort((a, b) => a.property.localeCompare(b.property) || a.lineKey.localeCompare(b.lineKey)),
  };
}
