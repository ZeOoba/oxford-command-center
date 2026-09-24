// server/warehouse/insurance-history.ts
//
// Insurance premium history builder (2026-09-23 review, Task 24). Read-only display aggregation
// for GET /api/warehouse/insurance/analysis/history — NOT consumed by any scoring, benchmark,
// alert or calibration path. Rows stay keyed by the RAW policy-line key
// ('ins-<stem>-<line>'); resolveInsuranceProperty supplies the display name only, never a re-key.
import type { PremiumHistoryReport } from '../../src/contracts/insurance-analysis';
import { resolveInsuranceProperty } from './insurance-property-map';

interface Row { property_id: string; policy_type: string; effective_date: string | null; premium_annual: number | null }

/** A same-premium term dated less than one policy year after a prior term of the same line is a
 *  re-key of that term, not a renewal. The 3034 Westerville $7,838 duplicate in
 *  data_quality_issues (2024-09-24 vs 2025-09-18 = 359d) is the motivating case; a genuine flat
 *  renewal lands at >= 365d and is kept. */
const DUP_WINDOW_DAYS = 365;

/** Per-line premium terms + policy-year totals. Skips undated/unpriced rows; collapses a
 *  same-premium term re-keyed within DUP_WINDOW_DAYS so every term is summed exactly once. */
export function buildPremiumHistory(rows: Row[], masterNames: ReadonlyMap<string, string>): PremiumHistoryReport {
  const byLine = new Map<string, { policyType: string; terms: Array<{ effectiveDate: string; premium: number }> }>();
  for (const r of rows) {
    if (!r.effective_date || r.premium_annual === null || r.premium_annual < 0) continue;
    const e = byLine.get(r.property_id) ?? { policyType: r.policy_type, terms: [] };
    e.terms.push({ effectiveDate: r.effective_date.slice(0, 10), premium: r.premium_annual });
    byLine.set(r.property_id, e);
  }
  const lines: PremiumHistoryReport['lines'] = [];
  for (const [lineKey, e] of byLine) {
    const sorted = e.terms.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const terms = sorted.filter((t, i) => !sorted.slice(0, i).some((p) =>
      p.premium === t.premium && (Date.parse(t.effectiveDate) - Date.parse(p.effectiveDate)) / 86_400_000 < DUP_WINDOW_DAYS));
    lines.push({ lineKey, property: resolveInsuranceProperty(lineKey, masterNames).name, policyType: e.policyType, terms });
  }
  const years = new Map<number, { premium: number; lines: number }>();
  for (const l of lines) for (const t of l.terms) {
    const y = Number(t.effectiveDate.slice(0, 4));
    const cur = years.get(y) ?? { premium: 0, lines: 0 };
    years.set(y, { premium: cur.premium + t.premium, lines: cur.lines + 1 });
  }
  return {
    byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    lines: lines.sort((a, b) => a.property.localeCompare(b.property)),
  };
}
