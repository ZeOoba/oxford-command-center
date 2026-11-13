// tests/unit/noi-reader-sweep.test.ts
//
// Follow-up to audit 2026-11-12 HIGH #2 (PR #579): the NOI-reader sweep. A blank workbook NOI cell
// (parse flag governorInputBlank / rawValue 'noi') is summed as $0. Every reader below used to show
// that $0 as a real figure; each now names the blank row and says "incomplete", with NO bound
// direction (a blank NOI may be negative). All fixtures are synthetic.
import { describe, expect, it } from 'vitest';
import type { Lease, PortfolioSnapshot, Property } from '@contracts/index';
import { GOVERNOR_INPUT_BLANK_FIELD } from '../../src/analytics/governor-inputs';
import { marketAllocation, portfolioKpis, buildAnalytics } from '../../src/analytics/engine';
import { noiGapNames, noiGapText, noiTotalSummary } from '../../src/analytics/noi-incomplete';
import { evaluateConditions } from '../../src/analytics/conditions';
import { pctNoiText, tenantScorecards } from '../../src/brain/tenants';
import { buildEntityItems } from '../../src/brain/searchIndex';
import { principalKpis } from '../../src/modules/principal/principal-kpis';
import { buildFilterSlice, filterSliceText } from '../../src/shell/filter-slice';
import { acquisitionLens } from '../../src/modules/market/acquisition-lens';
import { runTool } from '../../server/ai/tools';

const base = {
  index: 1, address: '1 Test Way', city: null, state: null, type: 'Flex',
  sf: 10_000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 2_000_000,
  grossIncome: 0, expenses: 0, noiScenarioAdj: 0, netCashFlow: 0, capRate: null, valuePerSf: null,
  rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false,
  debtService: 0, loanBalance: 0, dscr: null, ltv: null, lender: null,
};
const prop = (id: string, name: string, market: string, noi: number, blank = false): Property =>
  ({
    ...base, id, name, market, noi,
    flags: blank ? [{ entity: id, field: GOVERNOR_INPUT_BLANK_FIELD, issue: 'blank', rawValue: 'noi', severity: 'warn' as const }] : [],
  }) as unknown as Property;

const alpha = prop('a', 'Alpha', 'Columbus OH', 300_000);
const bravo = prop('b', 'Bravo', 'Columbus OH', 0, true);
const charlie = prop('c', 'Charlie', 'Kansas City MO', 100_000);
const delta = prop('d', 'Delta', 'Madison WI', 0, true); // the only row in its market

const lease = (id: string, propertyId: string, tenant: string, annualRent: number): Lease =>
  ({
    id, propertyKey: propertyId, propertyId, tenantName: tenant, company: tenant, suite: null, sf: 5_000, annualRent,
    monthlyRent: annualRent / 12, leaseStart: '2024-01-01', leaseEnd: '2029-12-31', status: 'Active', flags: [],
  }) as unknown as Lease;

function snap(properties: Property[], leases: Lease[] = []): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-11-01', generatedAt: '2026-11-01T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-11-01' },
    properties, leases, loans: [],
    cash: { asOf: '2026-11-01', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, arBalances: [],
    dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

describe('NOI-reader sweep: a blank NOI is named, never a silent $0 (follow-up to audit HIGH #2)', () => {
  it('noiGapText names the blank rows with no bound direction, null when complete', () => {
    const k = portfolioKpis(snap([alpha, bravo]));
    expect(noiGapNames(k)).toEqual(['Bravo']);
    expect(noiGapText(k)).toBe('incomplete — blank NOI on Bravo');
    expect(noiGapText(portfolioKpis(snap([alpha])))).toBeNull();
  });

  it('NOI by market marks a market holding a blank-NOI row, and keeps a market whose only row is blank', () => {
    const m = marketAllocation([alpha, bravo, charlie, delta], 'noi');
    expect(m.find((x) => x.market === 'Columbus OH')!.incomplete).toEqual(['Bravo']);
    expect(m.find((x) => x.market === 'Madison WI')!.incomplete).toEqual(['Delta']);
    expect(m.find((x) => x.market === 'Kansas City MO')!.incomplete).toBeUndefined();
    // Complete input: unchanged shape (no incomplete key anywhere); sf / value never carry it.
    expect(marketAllocation([alpha, charlie], 'noi').every((x) => !('incomplete' in x))).toBe(true);
    expect(marketAllocation([alpha, bravo], 'sf').every((x) => !('incomplete' in x))).toBe(true);
    const bundle = buildAnalytics(snap([alpha, bravo, charlie, delta]));
    expect(bundle.marketByNoi.find((x) => x.market === 'Madison WI')!.incomplete).toEqual(['Delta']);
  });

  it('market order never depends on input row order: $0 ties break by market name (refute wf_325f62d5-344)', () => {
    const x = prop('x', 'Xray', 'Madison WI', 0, true);
    const y = prop('y', 'Yankee', 'Kansas City MO', 0, true);
    const fwd = marketAllocation([alpha, x, y], 'noi');
    const rev = marketAllocation([alpha, y, x], 'noi');
    expect(rev).toEqual(fwd);
    expect(fwd.map((m) => m.market)).toEqual(['Columbus OH', 'Kansas City MO', 'Madison WI']);
  });

  it('AI get_portfolio_summary noiByMarket names the blank rows per market', () => {
    const data = runTool('get_portfolio_summary', snap([alpha, bravo, charlie]), {}).data as Record<string, unknown>;
    const rows = data['noiByMarket'] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['market'] === 'Columbus OH')!['incomplete']).toEqual(['Bravo']);
    expect(rows.find((r) => r['market'] === 'Kansas City MO')!['incomplete']).toBeUndefined();
    expect(data['noiByMarketNote']).toMatch(/blank NOI on Bravo .*every market's NOI share is incomplete/);
    const full = runTool('get_portfolio_summary', snap([alpha, charlie]), {}).data as Record<string, unknown>;
    expect(full['noiByMarketNote']).toBeUndefined();
  });

  it('tenant scorecards carry the blank-NOI rows of the basis; the concentration alert says its share is incomplete', () => {
    const s = snap([alpha, bravo], [lease('l1', 'a', 'Tenant One', 120_000), lease('l2', 'b', 'Tenant Two', 120_000)]);
    const cards = tenantScorecards(s, '2026-11-01');
    for (const c of cards) expect(c.pctNoiIncomplete).toEqual(['Bravo']);
    // Tenant One holds 100% of the KNOWN NOI; the alert must not read as a confirmed share.
    const alert = evaluateConditions(s).find((i) => i.id === 'concentration-tenant-one')!;
    expect(alert.metric).toBe('100.0% (incomplete)');
    expect(alert.detail).toMatch(/incomplete: blank NOI on Bravo is left out of the basis/);
    // Complete basis: no marker.
    const c2 = tenantScorecards(snap([alpha], [lease('l1', 'a', 'Tenant One', 120_000)]), '2026-11-01');
    expect(c2[0]!.pctNoiIncomplete).toEqual([]);
    expect(pctNoiText(cards.find((c) => c.name === 'Tenant One')!)).toBe('100.0% (incomplete)');
    expect(pctNoiText(c2[0]!)).toBe('100.0%');
    const a2 = evaluateConditions(snap([alpha], [lease('l1', 'a', 'Tenant One', 120_000)])).find((i) => i.id === 'concentration-tenant-one')!;
    expect(a2.metric).toBe('100.0%');
    expect(a2.detail).not.toMatch(/incomplete/);
    expect(evaluateConditions(snap([alpha], [lease('l1', 'a', 'Tenant One', 120_000)])).some((i) => i.id === 'concentration::incomplete')).toBe(false);
  });

  it('names the tenants the concentration screen cannot see because their property NOI is blank (refute wf_325f62d5-344)', () => {
    // Eight $100K rows; "Big Tenant" sits on the blank row and reads 0%, so it never crosses the threshold.
    const rows = Array.from({ length: 7 }, (_, i) => prop(`r${i}`, `Row ${i}`, 'Columbus OH', 100_000));
    const blankRow = prop('rx', 'Row X', 'Columbus OH', 0, true);
    const leases = [...rows.map((r, i) => lease(`l${i}`, r.id, `T${i}`, 100_000)), lease('lx', 'rx', 'Big Tenant', 400_000)];
    const insights = evaluateConditions(snap([...rows, blankRow], leases));
    const inc = insights.find((i) => i.id === 'concentration::incomplete')!;
    expect(inc.severity).toBe('info');
    expect(inc.detail).toBe("Blank NOI on Row X is left out of the basis, so every tenant's share of portfolio NOI is incomplete. Not screened (every lease is on a blank-NOI property): Big Tenant.");
    expect(inc.metric).toBe('1 blank NOI row');
    // A tenant named "Incomplete" cannot collide with the screen insight's id.
    expect(evaluateConditions(snap([alpha, bravo], [lease('l9', 'a', 'Incomplete', 120_000)])).filter((i) => i.id.startsWith('concentration')).map((i) => i.id).sort())
      .toEqual(['concentration-incomplete', 'concentration::incomplete']);
  });

  it('a tenant with leases on both a blank and a known row is "partly screened", never "not screened" (refute wf_7b3fb3d6-d93)', () => {
    const s = snap([alpha, bravo], [lease('m1', 'a', 'Mixed Co', 120_000), lease('m2', 'b', 'Mixed Co', 120_000)]);
    const insights = evaluateConditions(s);
    expect(insights.find((i) => i.id === 'concentration-mixed-co')!.metric).toBe('100.0% (incomplete)');
    const inc = insights.find((i) => i.id === 'concentration::incomplete')!;
    expect(inc.detail).toMatch(/Partly screened \(share excludes its blank-NOI property\): Mixed Co\.$/);
    expect(inc.detail).not.toMatch(/Not screened/);
  });

  it('extract-workbook NOI summary names blank rows instead of a confident total', () => {
    expect(noiTotalSummary(400_000, [])).toBe('$400,000');
    expect(noiTotalSummary(400_000, ['Bravo'])).toBe('$400,000 (incomplete: blank NOI on Bravo)');
  });

  it('search subtitle says "NOI blank" instead of "$0 NOI"', () => {
    const items = buildEntityItems(snap([alpha, bravo]));
    expect(items.find((i) => i.title === 'Bravo')!.subtitle).toBe('Flex · 10,000 SF · NOI blank');
    expect(items.find((i) => i.title === 'Alpha')!.subtitle).toMatch(/\$300K NOI$/);
  });

  it('principal NOI card carries the incomplete sublabel', () => {
    const noi = principalKpis(buildAnalytics(snap([alpha, bravo]))).find((x) => x.label === 'NOI')!;
    expect(noi.sublabel).toBe('incomplete — blank NOI on Bravo');
    expect(principalKpis(buildAnalytics(snap([alpha]))).find((x) => x.label === 'NOI')!.sublabel).toBeUndefined();
  });

  it('filter-bar readout marks the summed NOI incomplete when a matched row is blank', () => {
    const slice = buildFilterSlice([alpha, bravo, charlie], [alpha, bravo])!;
    expect(slice.noiBlank).toEqual(['Bravo']);
    expect(filterSliceText(slice)).toBe('2 of 3 assets · $0.3M workbook NOI (incomplete: blank NOI on 1 row)');
    expect(filterSliceText(buildFilterSlice([alpha, bravo, charlie], [alpha, charlie])!)).toBe('2 of 3 assets · $0.4M workbook NOI');
    expect(buildFilterSlice([], [])).toBeUndefined();
  });

  it('Acquisition Lens withholds the cap-rate spread when the weighted cap is incomplete', () => {
    const lens = acquisitionLens(0.08, 4.2, ['Bravo']);
    expect(lens.capText).toBe('8.00% (incomplete)');
    expect(lens.spreadText).toBe('—');
    expect(lens.note).toBe('Spread withheld: the weighted cap rate is incomplete (blank NOI on Bravo).');
    const full = acquisitionLens(0.08, 4.2, []);
    expect(full).toEqual({ capText: '8.00%', spreadText: '380 bps', note: null });
    expect(acquisitionLens(null, 4.2, [])).toEqual({ capText: '—', spreadText: '—', note: null });
  });
});
