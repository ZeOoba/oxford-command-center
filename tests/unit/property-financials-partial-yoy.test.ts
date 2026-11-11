// @vitest-environment node
//
// tests/unit/property-financials-partial-yoy.test.ts — refute findings F1 + F2: a portfolio view or an
// account-mover list that compares a PARTIAL period must never print a YoY. The committed dataset has
// every same-store member complete, so these tests mutate an in-memory copy (a member's n_months
// lowered) and, for F1, also rebuild from a CSV with one member-month dropped (the refute repro).
import { pfGolden } from './golden-helpers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PF_MONTHLY_ENTITY_IDS, type PfDataset } from '@contracts/property-financials';
import { parseMonthlyLong } from '@analytics/property-financials/aggregate';
import { buildDataset, parseCuratedInputs, parseDerivationConfig, parseEntityRegistry } from '@analytics/property-financials/build-dataset';
import { pct } from '@analytics/property-financials/format';
import { opexDeltaItems, overviewKpis, overviewLede, portfolioViewPartial, moverComparisonPartial, topOpexMovers, WATCHLIST_MOVER_RULES } from '../../src/modules/property-financials/model';
import { auditCsvSkipMarker, itWithAuditCsv, loadCsvText, loadDataset } from './property-financials-helpers';

const D = loadDataset();

/** A deep copy of the dataset with one entity's period n_months overridden. */
function withMonths(entity: string, period: string, n: number): PfDataset {
  const c = structuredClone(D) as PfDataset;
  (c.properties as Record<string, { periods: Record<string, { n_months: number }> }>)[entity]!.periods[period]!.n_months = n;
  return c;
}

describe('F1: Overview same-store views refuse a YoY when any member is partial', () => {
  it('committed data: every member is complete, shipped numbers equal the value lock', () => {
    expect(portfolioViewPartial(D, 'same_store_YTD26_vs_YTD25')).toBeNull();
    expect(portfolioViewPartial(D, 'pm_only_FY2025_vs_FY2024')).toBeNull();
    const k = overviewKpis(D);
    const G = pfGolden().sameStoreYtd;
    expect(pct(k.baseRent.change.value)).toBe(G.baseRent);
    expect(pct(k.opexExTax.change.value)).toBe(G.opexExTax);
    expect(k.noiFy.change.value).not.toBeNull();
    const abs = (x: string): string => x.replace(/^[+-]/, '');
    expect(overviewLede(D).startsWith(`Rent is growing ${abs(G.baseRent)} on a same-store basis, while operating cost excluding real estate tax is up ${abs(G.opexExTax)}.`)).toBe(true);
    for (const x of opexDeltaItems(D.portfolio.same_store_YTD26_vs_YTD25.view, portfolioViewPartial(D, 'same_store_YTD26_vs_YTD25'))) {
      // the change is whatever pctChange says on complete data (never a partial refusal)
      if (x.change.value === null) expect(x.change.reason).not.toMatch(/partial/);
    }
  });

  it('a member partial on the CURRENT side: rent + opex KPI changes are n/m naming the member', () => {
    const m = withMonths('1100 Rarig', 'YTD26', 8);
    expect(portfolioViewPartial(m, 'same_store_YTD26_vs_YTD25')).toBe('1100 Rarig: partial period: 8 of 9 months');
    const k = overviewKpis(m);
    expect(k.baseRent.change).toEqual({ value: null, reason: '1100 Rarig: partial period: 8 of 9 months' });
    expect(k.opexExTax.change.value).toBeNull();
    expect(k.opexExTax.change.reason).toMatch(/1100 Rarig: partial period/);
    // FY view untouched by a YTD gap
    expect(k.noiFy.change.value).not.toBeNull();
  });

  it('a member partial on the PRIOR side is refused too; FY view refuses on its own periods', () => {
    expect(portfolioViewPartial(withMonths('FVC', 'YTD25', 7), 'same_store_YTD26_vs_YTD25')).toBe('FVC: partial period: 7 of 9 months');
    const fy = withMonths('9050 Red Branch', 'FY2024', 11);
    expect(portfolioViewPartial(fy, 'pm_only_FY2025_vs_FY2024')).toBe('9050 Red Branch: partial period: 11 of 12 months');
    expect(overviewKpis(fy).noiFy.change.value).toBeNull();
  });

  it('lede degrades: never prints a growth % when a member is partial', () => {
    const lede = overviewLede(withMonths('1100 Rarig', 'YTD26', 8));
    expect(lede).toMatch(/^Same-store rent growth is not measurable \(1100 Rarig: partial period: 8 of 9 months\), while the change in operating cost excluding real estate tax is not measurable \(1100 Rarig: partial period: 8 of 9 months\)\./);
    expect(lede).not.toMatch(/\d+\.\d%/);
  });

  it('opex delta items: every category change is n/m with the partial reason', () => {
    const m = withMonths('1100 Rarig', 'YTD26', 8);
    const items = opexDeltaItems(m.portfolio.same_store_YTD26_vs_YTD25.view, portfolioViewPartial(m, 'same_store_YTD26_vs_YTD25'));
    expect(items).toHaveLength(8);
    for (const x of items) expect(x.change).toEqual({ value: null, reason: '1100 Rarig: partial period: 8 of 9 months' });
  });

  // Rebuilds from the local-only monthly-long.csv (Gabriel ruling 2026-10-06): skipped with a visible marker without it.
  auditCsvSkipMarker();
  itWithAuditCsv('refute repro: drop 1100 Rarig 2026-03 from the CSV, rebuild -> rent growth is n/m, not 1.9%', () => {
    const CONFIG_DIR = resolve(process.cwd(), 'scripts', 'property-financials', 'config');
    const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
    const rows = parseMonthlyLong(loadCsvText()).filter((r) => !(r.entity === '1100 Rarig' && r.period === '2026-03'));
    const built = buildDataset({
      rows,
      registry: parseEntityRegistry(readJson(resolve(CONFIG_DIR, 'entities.json'))),
      derivation: parseDerivationConfig(readJson(resolve(CONFIG_DIR, 'derivation.v1.json'))),
      curated: parseCuratedInputs({
        meta: readJson(resolve(CONFIG_DIR, 'curated', 'meta.json')),
        insights: readJson(resolve(CONFIG_DIR, 'curated', 'insights.json')),
        leases: readJson(resolve(CONFIG_DIR, 'curated', 'leases.json')),
        data_quality: readJson(resolve(CONFIG_DIR, 'curated', 'data_quality.json')),
        sf: readJson(resolve(CONFIG_DIR, 'curated', 'sf.json')),
      }),
      categories: (readJson(resolve(CONFIG_DIR, 'account-mapping.v1.json')) as { categories: { revenue: string[]; opex: string[]; below_line: Record<string, string> } }).categories,
    }) as unknown as PfDataset;
    expect(built.properties['1100 Rarig'].periods.YTD26.n_months).toBe(8);
    const k = overviewKpis(built);
    expect(k.baseRent.change.value).toBeNull();
    expect(k.baseRent.change.reason).toBe('1100 Rarig: partial period: 8 of 9 months');
  });
});

describe('F2: account movers skip entities whose comparison periods are partial', () => {
  it('moverComparisonPartial reads the comparison periods (YTD26/YTD25, FY2025/FY2024)', () => {
    expect(moverComparisonPartial(D, '1100 Rarig', 'YTD26_vs_YTD25')).toBeNull();
    // committed data: Livingston's YTD25 holds 3 of 9 months; Westerville's FY2024 3 of 12
    expect(moverComparisonPartial(D, '3883 Livingston', 'YTD26_vs_YTD25')).toBe('partial period: 3 of 9 months (Jan-Sep 25)');
    expect(moverComparisonPartial(D, '3034 Westerville', 'FY2025_vs_FY2024')).toBe('partial period: 3 of 12 months (FY24)');
    expect(moverComparisonPartial(D, '3034 Westerville', 'YTD26_vs_YTD25')).toBeNull();
  });

  it('topOpexMovers leaves out partial entities and returns them for the note', () => {
    const got = topOpexMovers(D);
    expect(got.rows.some((r) => r.entity === '3883 Livingston')).toBe(false);
    expect(got.excluded).toEqual([{ entity: '3883 Livingston', label: D.properties['3883 Livingston'].label, reason: 'partial period: 3 of 9 months (Jan-Sep 25)' }]);
    for (const r of got.rows) expect(moverComparisonPartial(D, r.entity, WATCHLIST_MOVER_RULES.comparison)).toBeNull();
  });

  it('a mutated dataset: lowering a member n_months drops its movers and names it', () => {
    const m = withMonths('9620 State 350', 'YTD26', 8);
    const before = topOpexMovers(D).rows.filter((r) => r.entity === '9620 State 350');
    expect(before.length).toBeGreaterThan(0);
    const got = topOpexMovers(m);
    expect(got.rows.some((r) => r.entity === '9620 State 350')).toBe(false);
    expect(got.excluded.map((e) => e.entity)).toEqual(['9620 State 350', '3883 Livingston'].sort((a, b) => PF_MONTHLY_ENTITY_IDS.indexOf(a as never) - PF_MONTHLY_ENTITY_IDS.indexOf(b as never)));
    expect(got.excluded.find((e) => e.entity === '9620 State 350')!.reason).toBe('partial period: 8 of 9 months (Jan-Sep 26)');
  });

  it('FY comparison rules use the FY periods', () => {
    const got = topOpexMovers(D, { comparison: 'FY2025_vs_FY2024', minAbsDelta: 2500, limit: 100 });
    expect(new Set(got.excluded.map((e) => e.entity))).toEqual(new Set(['3034 Westerville', '3883 Livingston', '9620 State 350']));
    expect(got.rows.some((r) => ['3034 Westerville', '3883 Livingston', '9620 State 350'].includes(r.entity))).toBe(false);
  });
});
