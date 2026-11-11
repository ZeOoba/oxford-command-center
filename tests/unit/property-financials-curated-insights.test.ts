// @vitest-environment node
//
// tests/unit/property-financials-curated-insights.test.ts — lint of the hand-written (curated)
// insights in scripts/property-financials/config/curated/insights.json against the dataset they sit in.
//
// 1. Every portfolio year-over-year percentage quoted in a Portfolio insight is recomputed from
//    COMPLETE members only (members complete in both windows, inside the dataset's same-store set), and
//    any signed percentage in a Portfolio insight that is not registered here fails: a new quote must
//    be added to the registry (and so recomputed) or to the single-asset allowlist.
// 2. Every mechanically-derived curated impact (EXP-07 / 08 / 09 / 10) is recomputed from the dataset
//    or computeLevers, so a mapping change cannot leave one behind; checked in the curated file AND in
//    the committed dataset.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PF_MONTHLY_ENTITY_IDS, type OpexCategory, type PfDataset, type PfInsight, type PfPeriodFigures, type StandardPeriodId } from '@contracts/property-financials';
import { computeLevers } from '@analytics/property-financials/levers';
import { pct } from '@analytics/property-financials/format';
import { partialReason } from '@analytics/property-financials/periods';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const CURATED = JSON.parse(readFileSync(resolve(process.cwd(), 'scripts', 'property-financials', 'config', 'curated', 'insights.json'), 'utf8')) as {
  insights: PfInsight[];
};
const curated = (id: string) => CURATED.insights.find((i) => i.id === id)!;
const shipped = (id: string) => D.insights.find((i) => i.id === id)!;

type Window = 'FY2025_vs_FY2024' | 'TTM26_vs_TTM25';
const WINDOWS: Record<Window, { cur: StandardPeriodId; prior: StandardPeriodId; sameStore: keyof PfDataset['portfolio'] }> = {
  FY2025_vs_FY2024: { cur: 'FY2025', prior: 'FY2024', sameStore: 'pm_only_FY2025_vs_FY2024' },
  TTM26_vs_TTM25: { cur: 'TTM26', prior: 'TTM25', sameStore: 'same_store_TTM26_vs_TTM25' },
};

/** A monthly PM asset's period figures by standard period id, or null for an annual-only entity. */
function figures(id: string): Record<StandardPeriodId, PfPeriodFigures> | null {
  const p = D.properties[id as (typeof PF_MONTHLY_ENTITY_IDS)[number]];
  return p.kind === 'monthly' ? (p.periods as Record<StandardPeriodId, PfPeriodFigures>) : null;
}

/** PM assets complete in BOTH windows and inside the dataset's same-store set (lease-up assets excluded). */
function completeMembers(w: Window): string[] {
  const { cur, prior, sameStore } = WINDOWS[w];
  const ss = (D.portfolio[sameStore] as { members: string[] }).members;
  return PF_MONTHLY_ENTITY_IDS.filter((id) => {
    const f = figures(id);
    if (!f || !ss.includes(id)) return false;
    return partialReason(cur, f[cur]!.n_months) === null && partialReason(prior, f[prior]!.n_months) === null;
  });
}

function yoy(w: Window, category: OpexCategory): number {
  const { cur, prior } = WINDOWS[w];
  const ms = completeMembers(w);
  const sum = (per: StandardPeriodId) => ms.reduce((a, id) => a + (figures(id)?.[per]?.opex_by[category] ?? 0), 0);
  return sum(cur) / sum(prior) - 1;
}

/** Every portfolio YoY quoted in a Portfolio insight: the exact sentence fragment and how to recompute it. */
const PORTFOLIO_YOY: ReadonlyArray<{ id: string; quote: (p: string) => string; window: Window; category: OpexCategory; digits: number }> = [
  { id: 'EXP-08', quote: (p) => `Same-store tax grew ${p} in FY2025`, window: 'FY2025_vs_FY2024', category: 'Real estate & property tax', digits: 1 },
  { id: 'EXP-09', quote: (p) => `Same-store snow/grounds were ${p} in FY2025`, window: 'FY2025_vs_FY2024', category: 'Grounds / snow / lot', digits: 0 },
  { id: 'EXP-10', quote: (p) => `FY2025 insurance is ${p} against FY2024`, window: 'FY2025_vs_FY2024', category: 'Insurance', digits: 1 },
  { id: 'EXP-10', quote: (p) => `TTM26 is ${p} against TTM25`, window: 'TTM26_vs_TTM25', category: 'Insurance', digits: 1 },
];

/** Signed percentages in Portfolio insights that are about ONE asset (not a portfolio YoY). */
const SINGLE_ASSET = ['Info Lane is +20% YTD', 'Red Branch +13% in FY2025', 'Red Branch snow +55% YTD', 'Broadway snow contract +53% in FY2025'];

describe('curated insights: portfolio YoY recomputed from complete members', () => {
  it('the complete-member sets exclude partial windows (Livingston, Westerville) and lease-up (9620)', () => {
    for (const w of Object.keys(WINDOWS) as Window[]) {
      const ms = completeMembers(w);
      for (const out of ['3883 Livingston', '3034 Westerville', '9620 State 350']) expect(ms, w).not.toContain(out);
      expect(ms.length, w).toBe(6);
    }
  });

  it.each(PORTFOLIO_YOY)('$id: $window $category', ({ id, quote, window, category, digits }) => {
    const text = quote(pct(yoy(window, category), digits));
    expect(curated(id).finding).toContain(text);
    expect(shipped(id).finding).toContain(text);
  });

  it('EXP-10 restated: no +21.0% TTM figure summed over partial members; the excluded assets are named', () => {
    const f = curated('EXP-10').finding;
    expect(f).not.toContain('+21.0%');
    expect(f).toMatch(/Livingston \(3 of 12 months in TTM25\)/);
    expect(f).toMatch(/Westerville \(11 of 12\)/);
  });

  it('every signed percentage in a Portfolio insight is registered (portfolio YoY) or allowlisted (single asset)', () => {
    const registered = PORTFOLIO_YOY.map((r) => ({ id: r.id, text: r.quote(pct(yoy(r.window, r.category), r.digits)) }));
    for (const ins of CURATED.insights.filter((i) => i.property === 'Portfolio')) {
      const text = `${ins.title} ${ins.finding} ${ins.action}`;
      for (const m of text.matchAll(/[+-]\d+(?:\.\d+)?%/g)) {
        const at = m.index;
        const covered = [...registered.filter((r) => r.id === ins.id).map((r) => r.text), ...SINGLE_ASSET].some((frag) => {
          const i = text.indexOf(frag);
          return i >= 0 && at >= i && at < i + frag.length;
        });
        expect(covered, `${ins.id}: unregistered signed percentage "${m[0]}" in: ${text.slice(Math.max(0, at - 60), at + 20)}`).toBe(true);
      }
    }
  });
});

describe('curated insights: mechanically-derived impacts recomputed', () => {
  const lever = (id: string) => computeLevers(D).find((l) => l.id === id)!.value.value!;
  const pmFy2025Tax = PF_MONTHLY_ENTITY_IDS.reduce((a, id) => {
    const p = D.properties[id];
    return a + (p.kind === 'monthly' ? (p.periods.FY2025.opex_by['Real estate & property tax'] ?? 0) : 0);
  }, 0);
  const CASES: ReadonlyArray<{ id: string; expected: () => number; why: string }> = [
    { id: 'EXP-07', expected: () => lever('mgmtFee'), why: '50 bps of TTM26 revenue (mgmtFee lever)' },
    { id: 'EXP-08', expected: () => 0.05 * pmFy2025Tax, why: '5% of FY2025 tax across the nine PM properties' },
    { id: 'EXP-09', expected: () => lever('grounds'), why: '10% of TTM26 grounds / snow (grounds lever)' },
    { id: 'EXP-10', expected: () => lever('insurance'), why: '8% of TTM26 insurance (insurance lever)' },
  ];

  it.each(CASES)('$id = $why, in the curated file and in dataset.json', ({ id, expected }) => {
    // Whole dollars. Within $1 rather than exact: the committed curated file and dataset are synthetic
    // stand-ins (dollars scaled, then rounded), so a recomputation can land on the other side of .5.
    // On the real files the two are equal.
    const v = Math.round(expected());
    expect(Number.isInteger(curated(id).annual_impact_usd)).toBe(true);
    expect(Math.abs(curated(id).annual_impact_usd! - v)).toBeLessThanOrEqual(1);
    expect(shipped(id).annual_impact_usd).toBe(curated(id).annual_impact_usd);
  });

  it('EXP-07 after v03.2: the management-fee lever is 0.5% of TTM26 revenue across the PM properties', () => {
    const ttmRevenue = PF_MONTHLY_ENTITY_IDS.reduce((a, id) => a + (figures(id)?.TTM26?.revenue ?? 0), 0);
    expect(lever('mgmtFee')).toBeCloseTo(0.005 * ttmRevenue, 1);
    expect(Math.abs(shipped('EXP-07').annual_impact_usd! - Math.round(lever('mgmtFee')))).toBeLessThanOrEqual(1);
  });
});
