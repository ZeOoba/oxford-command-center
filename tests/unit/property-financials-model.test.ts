// @vitest-environment node
//
// tests/unit/property-financials-model.test.ts — T5 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The pure view-model the
// Property Financials module renders: Overview KPIs (tied to the calc lib + the value lock in
// data/property-financials/golden.local.json), the computed lede (no hardcoded firm numbers), insight themes and ordering, entity
// matching for leases / insights, and the Scorecard rows with n/m reasons.
import { isSynthetic, pfGolden } from './golden-helpers';
import { describe, expect, it } from 'vitest';
import { SAME_STORE, type PfDataset, type PfInsight, type PfMonthlyProperty } from '@contracts/property-financials';
import { pctChange, recoveryRatio, runRateQ3Table } from '@analytics/property-financials/metrics';
import { pct, usd } from '@analytics/property-financials/format';
import {
  entityForInsight,
  evaluationMatrix,
  excludedNotes,
  fmtLongDate,
  fmtMonth,
  insightThemes,
  insightsForEntity,
  leaseForEntity,
  monthRangeLabel,
  opexDeltaItems,
  overviewKpis,
  overviewLede,
  scorecardRows,
  sortInsights,
  whereTheMoneyIs,
} from '../../src/modules/property-financials/model';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const RE_TAX = 'Real estate & property tax';

function monthlyProp(id: (typeof SAME_STORE)[number]): PfMonthlyProperty {
  const p = D.properties[id];
  if (p.kind !== 'monthly') throw new Error(id);
  return p;
}

const mkInsight = (o: Partial<PfInsight>): PfInsight => ({
  id: 'X-1', severity: 'High', type: 'Revenue', property: 'Portfolio', title: 't', finding: 'f', action: 'a',
  annual_impact_usd: 0, impact_basis: null, tags: ['rent'], evidence: {}, ...o,
});

describe('formatting helpers', () => {
  it('long date, month label, month range', () => {
    expect(fmtLongDate('2026-09-30')).toBe('30 Sep 2026');
    expect(fmtMonth('2023-10')).toBe('Oct 2023');
    expect(monthRangeLabel(['2026-01', '2026-05', '2026-09'])).toBe('Jan-Sep 2026');
    expect(monthRangeLabel(['2025-10', '2026-09'])).toBe('Oct 2025-Sep 2026');
  });

  it('excluded notes come from dataset meta, parenthetical kept', () => {
    expect(excludedNotes(['2203-2207 Northwood (pending)'])).toEqual(['2203-2207 Northwood excluded (pending)']);
    expect(excludedNotes(['Somewhere'])).toEqual(['Somewhere excluded']);
    expect(excludedNotes(D.meta.excluded)).toEqual(['2203-2207 Northwood excluded (pending)']);
  });
});

describe('overviewKpis (real dataset)', () => {
  const k = overviewKpis(D);

  it('same-store base rent Jan-Sep: value from the portfolio view, change = calc-lib pctChange = the value lock', () => {
    const v = D.portfolio.same_store_YTD26_vs_YTD25.view.base_rent;
    expect(k.baseRent.current).toBe(v.current);
    expect(k.baseRent.change).toEqual(pctChange(v.prior, v.current));
    expect(pct(k.baseRent.change.value)).toBe(pfGolden().sameStoreYtd.baseRent);
    // ties to the per-property sum the golden test uses
    const sum = (per: 'YTD25' | 'YTD26') => SAME_STORE.reduce((a, id) => a + monthlyProp(id).periods[per].base_rent, 0);
    expect(k.baseRent.current).toBeCloseTo(sum('YTD26'), 2);
    expect(k.baseRent.members).toBe(6);
    expect(k.periodLabel).toBe('Jan-Sep 2026');
  });

  it('opex excl. RE tax Jan-Sep: equals the value lock', () => {
    const v = D.portfolio.same_store_YTD26_vs_YTD25.view;
    const prior = v.opex.prior - v.opex_by[RE_TAX].prior;
    const current = v.opex.current - v.opex_by[RE_TAX].current;
    expect(k.opexExTax.current).toBeCloseTo(current, 6);
    expect(k.opexExTax.change).toEqual(pctChange(prior, current));
    expect(pct(k.opexExTax.change.value)).toBe(pfGolden().sameStoreYtd.opexExTax);
  });

  it('NOI FY2025 on the PM-reported view; member count read from the data, change from the calc lib', () => {
    const v = D.portfolio.pm_only_FY2025_vs_FY2024;
    expect(k.noiFy.current).toBe(v.view.noi.current);
    expect(k.noiFy.change).toEqual(pctChange(v.view.noi.prior, v.view.noi.current));
    expect(k.noiFy.members).toBe(v.members.length);
  });

  it('High-severity count and gross annual swing', () => {
    const high = D.insights.filter((i) => i.severity === 'High');
    expect(k.high.count).toBe(high.length);
    expect(k.high.grossSwing).toBeCloseTo(high.reduce((a, i) => a + Math.abs(i.annual_impact_usd ?? 0), 0), 6);
  });
});

describe('insight themes + lede', () => {
  it('groups High insights by primary tag, ranks groups by gross |impact|', () => {
    const themes = insightThemes([
      mkInsight({ id: 'A-1', tags: ['utilities'], property: '1900 Broadway', annual_impact_usd: 40 }),
      mkInsight({ id: 'A-2', tags: ['utilities'], property: 'FVC', annual_impact_usd: 30 }),
      mkInsight({ id: 'A-3', tags: ['rent'], property: 'FVC', annual_impact_usd: -60 }),
      mkInsight({ id: 'A-4', tags: ['tax'], property: 'Portfolio', annual_impact_usd: 10 }),
      mkInsight({ id: 'A-5', severity: 'Medium', tags: ['solar'], property: 'X', annual_impact_usd: 999 }),
      mkInsight({ id: 'A-6', tags: ['lease'], property: 'Y', annual_impact_usd: null }),
    ]);
    expect(themes.map((t) => t.phrase)).toEqual(['utilities at 1900 Broadway and FVC', 'rent at FVC', 'real estate tax across the portfolio']);
    expect(themes[0]!.total).toBe(70);
    expect(themes[0]!.insightIds).toEqual(['A-1', 'A-2']);
  });

  it('lede states rent and opex-ex-tax growth from the calc lib and names the three biggest themes', () => {
    const lede = overviewLede(D);
    const k = overviewKpis(D);
    const G = pfGolden().sameStoreYtd;
    const abs = (x: string): string => x.replace(/^[+-]/, '');
    expect(lede).toContain(pct(k.baseRent.change.value).replace('+', ''));
    expect(lede).toContain(pct(k.opexExTax.change.value).replace('+', ''));
    const themes = insightThemes(D.insights, 3);
    expect(themes).toHaveLength(3);
    for (const t of themes) expect(lede).toContain(t.phrase);
    expect(lede.startsWith(`Rent is growing ${abs(G.baseRent)} on a same-store basis, while operating cost excluding real estate tax is up ${abs(G.opexExTax)}. The biggest dollars sit in three places: `)).toBe(true);
    expect(lede).toMatch(/The biggest dollars sit in three places: .+, .+, and .+\.$/);
  });

  it('lede wording follows the sign and degrades to n/m honestly', () => {
    const view = D.portfolio.same_store_YTD26_vs_YTD25.view;
    const flipped: PfDataset = {
      ...D,
      insights: [],
      portfolio: {
        ...D.portfolio,
        same_store_YTD26_vs_YTD25: {
          ...D.portfolio.same_store_YTD26_vs_YTD25,
          view: { ...view, base_rent: { prior: 100, current: 90, pct: -0.1 }, opex: { prior: 0, current: 10, pct: null }, opex_by: { ...view.opex_by, [RE_TAX]: { prior: 0, current: 0, pct: null } } },
        },
      },
    };
    expect(overviewLede(flipped)).toBe('Rent is falling 10.0% on a same-store basis, while the change in operating cost excluding real estate tax is not measurable (prior-period base is zero or negative).');
  });
});

describe('sortInsights / whereTheMoneyIs', () => {
  it('sorts severity first, then |annual impact| descending, unknown impact last', () => {
    const s = sortInsights([
      mkInsight({ id: 'L-1', severity: 'Low', annual_impact_usd: 9999 }),
      mkInsight({ id: 'H-1', annual_impact_usd: 10 }),
      mkInsight({ id: 'H-2', annual_impact_usd: -50 }),
      mkInsight({ id: 'H-3', annual_impact_usd: null }),
      mkInsight({ id: 'M-1', severity: 'Medium', annual_impact_usd: 1 }),
    ]);
    expect(s.map((i) => i.id)).toEqual(['H-2', 'H-1', 'H-3', 'M-1', 'L-1']);
  });

  it('where the money is = High only, ranked by |impact|', () => {
    const w = whereTheMoneyIs(D.insights);
    expect(w.every((i) => i.severity === 'High')).toBe(true);
    const abs = w.map((i) => Math.abs(i.annual_impact_usd ?? 0));
    expect([...abs].sort((a, b) => b - a)).toEqual(abs);
    expect(w).toHaveLength(D.insights.filter((i) => i.severity === 'High').length);
  });
});

describe('entity matching (no hardcoded lease-key table)', () => {
  it('finds each lease by street + number, including a number range', () => {
    expect(leaseForEntity(D.leases, '3883 Livingston')?.property).toBe('3875-3883 Livingston');
    expect(leaseForEntity(D.leases, '3034 Westerville')?.property).toBe('3034 Westerville');
    expect(leaseForEntity(D.leases, '3540 E 5th')?.property).toBe('3540 E 5th');
    expect(leaseForEntity(D.leases, '55 New Plant (EGFLLC)')?.property).toBe('55 New Plant (EGFLLC)');
    expect(leaseForEntity(D.leases, 'FVC')).toBeNull();
    expect(leaseForEntity(D.leases, '1900 Broadway')).toBeNull();
  });

  it('insights match their entity by label prefix; entityForInsight is the inverse', () => {
    expect(insightsForEntity(D.insights, '55 New Plant (EGFLLC)').map((i) => i.id)).toEqual(['REV-08']);
    expect(insightsForEntity(D.insights, 'FVC').map((i) => i.id).sort()).toEqual(['EXP-04', 'REC-01', 'REV-01']);
    const rev08 = D.insights.find((i) => i.id === 'REV-08')!;
    expect(entityForInsight(rev08)).toBe('55 New Plant (EGFLLC)');
    expect(entityForInsight(D.insights.find((i) => i.property === 'Portfolio')!)).toBeNull();
    expect(entityForInsight(D.insights.find((i) => i.property === '7658 Fishel')!)).toBeNull();
  });
});

describe('opexDeltaItems (chart 2)', () => {
  it('one item per opex category, current - prior, sorted largest increase first', () => {
    const v = D.portfolio.same_store_YTD26_vs_YTD25.view;
    const items = opexDeltaItems(v);
    expect(items).toHaveLength(8);
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.value).toBeGreaterThanOrEqual(items[i]!.value);
    const tax = items.find((i) => i.category === RE_TAX)!;
    expect(tax.value).toBeCloseTo(v.opex_by[RE_TAX].current - v.opex_by[RE_TAX].prior, 6);
    expect(tax.label).toBe('Real estate tax');
  });
});

describe('scorecardRows', () => {
  const rows = scorecardRows(D);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it('one row per entity, PM monthly first then the annual entity statements', () => {
    expect(rows.map((r) => r.id)).toEqual(Object.keys(D.properties));
    expect(row('FVC').sourceNote).toBe('PM monthly, Feb 2022 to Sep 2026');
    expect(row('1851 South Club Solar').sourceNote).toBe('Entity annual P&L');
  });

  it('a partial FY is n/m with the partial-period reason (never a number)', () => {
    expect(row('3034 Westerville').noiFy24).toEqual({ value: null, reason: 'partial period: 3 of 12 months' });
    expect(row('3883 Livingston').noiFy25.value).toBeNull();
    expect(row('FVC').noiFy25.value).toBe(D.properties.FVC.periods.FY2025.noi);
  });

  it('run-rate YoY and recovery come from the calc lib; annual entities are n/m with a reason', () => {
    const fvc = D.properties.FVC as PfMonthlyProperty;
    expect(row('FVC').runRateYoy).toEqual(runRateQ3Table(D.monthly.FVC).yoy_2026);
    expect(row('FVC').recovery).toEqual(recoveryRatio(fvc.periods.TTM26));
    expect(row('FVC').noiTtm.value).toBe(fvc.periods.TTM26.noi);
    const solar = row('1851 South Club Solar');
    for (const m of [solar.runRateYoy, solar.recovery, solar.noiTtm]) {
      expect(m.value).toBeNull();
      expect(m.reason).toMatch(/annual/);
    }
    const sfy = D.properties['1851 South Club Solar'].periods.FY2025;
    expect(solar.margin.value).toBeCloseTo(sfy.noi / sfy.revenue, 12);
  });

  it('ratios come from the raw figures via ratio(), never the dataset\'s 2-dp fields (which must not be displayed anywhere)', () => {
    // Monthly: Scorecard == Evaluation on every shared metric (value AND reason), for every PM asset.
    for (const ev of evaluationMatrix(D)) {
      const s = row(ev.id);
      expect(s.margin, `${ev.id}/margin`).toEqual(ev.cells.noiMargin.result);
      expect(s.mgmtFee, `${ev.id}/mgmtFee`).toEqual(ev.cells.mgmtFeePct.result);
      expect(s.recovery, `${ev.id}/recovery`).toEqual(ev.cells.recoveryRatio.result);
      expect(s.runRateYoy, `${ev.id}/runRateYoy`).toEqual(ev.cells.rentRunRateGrowth.result);
      const t = monthlyProp(ev.id as (typeof SAME_STORE)[number]).periods.TTM26;
      expect(s.opexRatio.value, `${ev.id}/opexRatio`).toBeCloseTo(t.opex / t.revenue, 12);
    }
    // The rounded fields really do differ from the raw ratios, so this test is not vacuous:
    // (the 9620 TTM26 management fee sits just above its rounded field on the real data); the raw
    // ratios are pinned by the value lock (data/property-financials/golden.local.json).
    const fee = (id: string) => row(id).mgmtFee.value!;
    const rounded = (id: string) => (D.properties[id as keyof typeof D.properties] as PfMonthlyProperty).periods.TTM26.mgmt_fee_pct!;
    const G = pfGolden().mgmtFeeTtm26;
    for (const id of ['9620 State 350', '3883 Livingston', '9050 Red Branch']) expect(fee(id), id).toBeCloseTo(G[id]!, 10);
    expect(['9620 State 350', '3883 Livingston', '9050 Red Branch', '3540 E 5th'].some((id) => fee(id) !== rounded(id))).toBe(true);
    // Literal real ratios (a fee share and its rounding direction): real file only. The synthetic copy
    // draws fees and revenue independently, so it does not (and must not) reproduce them.
    if (!isSynthetic('data/property-financials/dataset.json')) {
      expect(fee('9050 Red Branch')).toBeLessThan(rounded('9050 Red Branch'));
      expect(fee('3540 E 5th')).toBeCloseTo(REDACTED-AMT, 4);
    }
    // Annual entities: FY2025 raw ratios.
    for (const id of ['55 New Plant (EGFLLC)', '1851 South Club Solar'] as const) {
      const fy = D.properties[id].periods.FY2025;
      const s = row(id);
      expect(s.margin.value, `${id}/margin`).toBeCloseTo(fy.noi / fy.revenue, 12);
      expect(s.opexRatio.value, `${id}/opexRatio`).toBeCloseTo(fy.opex / fy.revenue, 12);
      expect(s.mgmtFee.value, `${id}/mgmtFee`).toBeCloseTo(fy.opex_by['Management fees'] / fy.revenue, 12);
    }
    expect(row('55 New Plant (EGFLLC)').margin.value).not.toBe(D.properties['55 New Plant (EGFLLC)'].periods.FY2025.noi_margin);
  });

  it('a zero-revenue period is n/m with the ratio() reason, not Infinity', () => {
    const id = '1100 Rarig';
    const p = monthlyProp(id);
    const zero = { ...D, properties: { ...D.properties, [id]: { ...p, periods: { ...p.periods, TTM26: { ...p.periods.TTM26, revenue: 0 } } } } } as PfDataset;
    const s = scorecardRows(zero).find((r) => r.id === id)!;
    for (const m of [s.margin, s.opexRatio, s.mgmtFee]) expect(m).toEqual({ value: null, reason: 'no revenue in the period' });
  });

  it('a partial TTM26 gives the SAME n/m reason as the Evaluation matrix (with and without revenue)', () => {
    const id = '1100 Rarig';
    const p = monthlyProp(id);
    for (const revenue of [p.periods.TTM26.revenue, 0]) {
      const part = { ...D, properties: { ...D.properties, [id]: { ...p, periods: { ...p.periods, TTM26: { ...p.periods.TTM26, n_months: 11, revenue } } } } } as PfDataset;
      const s = scorecardRows(part).find((r) => r.id === id)!;
      const ev = evaluationMatrix(part).find((r) => r.id === id)!;
      expect(s.margin, `rev ${revenue}/margin`).toEqual(ev.cells.noiMargin.result);
      expect(s.mgmtFee, `rev ${revenue}/mgmtFee`).toEqual(ev.cells.mgmtFeePct.result);
      expect(s.recovery, `rev ${revenue}/recovery`).toEqual(ev.cells.recoveryRatio.result);
      expect(s.opexRatio, `rev ${revenue}/opexRatio`).toEqual(ev.cells.noiMargin.result); // same TTM revenue base, same refusal
      expect(s.margin.value).toBeNull();
    }
  });

  it('flags = number of review items for the entity', () => {
    expect(row('FVC').flags).toBe(3);
    expect(row('55 New Plant (EGFLLC)').flags).toBe(1);
  });

  it('every n/m carries a reason', () => {
    for (const r of rows) {
      for (const m of [r.noiFy24, r.noiFy25, r.noiTtm, r.margin, r.runRateYoy, r.opexRatio, r.mgmtFee, r.recovery]) {
        if (m.value === null) expect(m.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

it('usd formatting stays the calc-lib formatter (sanity)', () => {
  expect(usd(1_234_567)).toBe('$1.23M');
});
