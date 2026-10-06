// @vitest-environment node
//
// tests/unit/property-financials-explorer-model.test.ts — T7 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The Property explorer's pure
// view-model against the REAL committed dataset: period groups (partial years never YoY, ≤0 base
// never %), the card grid (golden latest-full-year NOI per property), KPIs (per-SF on CURRENT total
// SF, never annualized), the YoY / category tables, "What changed and why", rent-step events, the
// lease panel (only where a lease exists, matched by the T5 street/building matcher), the computed
// insights with thresholds in ONE config, data gaps and the FVC confirm-me flag. Every property is
// built without throwing, NaN or 'undefined'.
import { describe, expect, it } from 'vitest';
import { PF_ENTITY_IDS, type PfDataset, type PfEntityId } from '@contracts/property-financials';
import { cagr, pctChange, ratio } from '@analytics/property-financials/metrics';
import { pct, pctLevel, usd } from '@analytics/property-financials/format';
import {
  DEFAULT_EXPLORER_ENTITY,
  EXPLORER_RULES,
  buildExplorer,
  cardName,
  explorerInsights,
  normalizeRentSchedule,
  opexStack,
  periodBars,
  periodGroups,
  propertyCards,
  timelineSeries,
  whyView,
  type ExplorerModel,
} from '../../src/modules/property-financials/explorer-model';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();

/** Every string anywhere inside a value (deep), for the no-NaN / no-undefined sweep. */
function strings(x: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof x === 'string') out.push(x);
  else if (typeof x === 'number') out.push(String(x));
  else if (x && typeof x === 'object' && !seen.has(x)) {
    seen.add(x);
    for (const v of Object.values(x as Record<string, unknown>)) strings(v, out, seen);
  }
  return out;
}

describe('cagr (calc lib)', () => {
  it('compound annual growth; refuses a non-positive base or a zero span', () => {
    expect(cagr(100, 121, 2).value).toBeCloseTo(0.1, 10);
    expect(cagr(0, 121, 2).value).toBeNull();
    expect(cagr(-5, 121, 2).value).toBeNull();
    expect(cagr(100, 121, 0).value).toBeNull();
    expect(cagr(100, -1, 2).value).toBeNull();
  });

  it('ratio refuses a non-positive denominator', () => {
    expect(ratio(5, 10).value).toBe(0.5);
    expect(ratio(5, 0).value).toBeNull();
    expect(ratio(5, -3).reason).toBe('no revenue in the period');
  });
});

describe('periodGroups', () => {
  it('monthly entity: full years, partial early years labelled, Jan-Sep pair from the dataset periods', () => {
    const g = periodGroups(D, 'FVC');
    expect(g.map((x) => x.label)).toEqual(['2022 (8 mo)', '2023 (10 mo)', '2024', '2025', 'Jan-Sep 25', 'Jan-Sep 26']);
    expect(g.filter((x) => x.partial).map((x) => x.key)).toEqual(['2022', '2023']);
  });

  it('years with fewer than the minimum months are dropped; the current calendar year only appears as Jan-Sep', () => {
    const g = periodGroups(D, '3034 Westerville');
    expect(g.map((x) => x.key)).toEqual(['2025', 'S25', 'S26']);
    expect(EXPLORER_RULES.minMonthsForYear).toBe(4);
  });

  it('no Jan-Sep pair (Livingston has 3 months of 2025) → current year shown as a partial year', () => {
    const g = periodGroups(D, '3883 Livingston');
    expect(g.map((x) => x.label)).toEqual(['2025 (6 mo)', '2026 (9 mo)']);
    expect(g.every((x) => x.partial)).toBe(true);
  });

  it('annual entities: every statement year, the 2026 partial labelled from the contract period id', () => {
    const g = periodGroups(D, '55 New Plant (EGFLLC)');
    expect(g.map((x) => x.label)).toEqual(['2024', '2025', '2026 to 6/12']);
    expect(g[2]!.partial).toBe(true);
  });

  it('RULE: a partial period never has a prior and never produces a YoY', () => {
    for (const id of PF_ENTITY_IDS) {
      for (const x of periodGroups(D, id)) {
        if (x.partial) {
          expect(x.prev, `${id} ${x.label}`).toBeNull();
          expect(x.change((r) => r.noi).value, `${id} ${x.label}`).toBeNull();
          expect(x.change((r) => r.noi).reason).toMatch(/partial period/);
        }
        if (x.prev) {
          expect(x.prev.partial).toBe(false);
          expect(x.prev.family).toBe(x.family);
          expect(x.prev.year).toBe(x.year - 1);
        }
      }
    }
  });

  it('RULE: a zero / negative base never produces a percent (3540 E 5th 2024 vs a negative 2023)', () => {
    const g = periodGroups(D, '3540 E 5th');
    const y24 = g.find((x) => x.key === '2024')!;
    expect(y24.prev?.key).toBe('2023');
    expect(D.history['3540 E 5th'].yr['2023']!.noi).toBeLessThan(0);
    const c = y24.change((r) => r.noi);
    expect(c.value).toBeNull();
    expect(c.reason).toMatch(/zero or negative/);
  });

  it('Jan-Sep 26 compares only with Jan-Sep 25', () => {
    const g = periodGroups(D, '1100 Rarig');
    const s26 = g.find((x) => x.key === 'S26')!;
    expect(s26.prev?.key).toBe('S25');
    expect(s26.change((r) => r.noi).value).toBeCloseTo(D.history['1100 Rarig'].ytd['2026']!.noi / D.history['1100 Rarig'].ytd['2025']!.noi - 1, 10);
  });
});

describe('property cards', () => {
  const cards = propertyCards(D);

  it('all 11 entities, dataset order', () => {
    expect(cards.map((c) => c.id)).toEqual([...PF_ENTITY_IDS]);
  });

  it('golden latest FULL-year NOI on each card (rounded dollars)', () => {
    const golden: Record<PfEntityId, [string, number]> = {
      '1100 Rarig': ['2025', REDACTED-AMT],
      // v03.2 (prepaid-rent ruling 2026-10-06): Yardi Prepaid Rental Income excluded from revenue; was 365_562.
      '1900 Broadway': ['2025', 366_902],
      '29000 Info Lane': ['2025', 487_373],
      '3034 Westerville': ['2025', REDACTED-AMT],
      '3540 E 5th': ['2025', 279_963],
      '3883 Livingston': ['2026 (9 mo)', REDACTED-AMT],
      // v03.2 prepaid-rent ruling: was 905_390.
      '9050 Red Branch': ['2025', 912_337],
      // REDACTED-AMT since the v03.1 correction (2026-10-05): the 2025-09 recap's $REDACTED-AMT of expense lines,
      // previously read as revenue, are opex now (was REDACTED-AMT = REDACTED-AMT + 2 x REDACTED-AMT).
      '9620 State 350': ['2025', REDACTED-AMT],
      FVC: ['2025', 837_090],
      '55 New Plant (EGFLLC)': ['2025', 422_488],
      '1851 South Club Solar': ['2025', 507_472],
    };
    for (const c of cards) {
      const [label, noi] = golden[c.id];
      expect(c.periodLabel, c.id).toBe(label);
      expect(Math.round(c.noi!), c.id).toBe(noi);
    }
  });

  it('YoY chip: Rarig FY25 vs FY24 = +27.3%; Livingston (partial only) is n/m with the reason', () => {
    const rarig = cards.find((c) => c.id === '1100 Rarig')!;
    expect(rarig.change.value).toBeCloseTo(REDACTED-AMT / D.history['1100 Rarig'].yr['2024']!.noi - 1, 6);
    const liv = cards.find((c) => c.id === '3883 Livingston')!;
    expect(liv.change.value).toBeNull();
    expect(liv.partial).toBe(true);
  });

  it('SF from the dataset sf block (current total SF); none for the solar entity', () => {
    expect(cards.find((c) => c.id === 'FVC')!.sf).toBe(D.sf.FVC.sf);
    expect(cards.find((c) => c.id === '1851 South Club Solar')!.sf).toBeNull();
  });

  it('card names drop descriptive parentheticals only', () => {
    expect(cardName(D.properties.FVC.label)).toBe('FVC');
    expect(cardName(D.properties['9620 State 350'].label)).toBe('9620 State 350');
    expect(cardName(D.properties['55 New Plant (EGFLLC)'].label)).toBe('55 New Plant Ct (EGFLLC)');
  });

  it('sparkline = full-year NOI series (≥2 points or none)', () => {
    const b = cards.find((c) => c.id === '1900 Broadway')!;
    expect(b.spark.length).toBe(10);
    expect(cards.find((c) => c.id === '3883 Livingston')!.spark).toEqual([]);
  });
});

describe('buildExplorer: every property', () => {
  const models = Object.fromEntries(PF_ENTITY_IDS.map((id) => [id, buildExplorer(D, id)])) as Record<PfEntityId, ExplorerModel>;

  it('builds all 11 without throwing; no NaN / Infinity / undefined anywhere in the view-model', () => {
    for (const id of PF_ENTITY_IDS) {
      const m = models[id];
      const s = strings({ ...m, groups: undefined, cards: undefined }).join('\n');
      expect(s, id).not.toMatch(/\bNaN\b|Infinity|undefined/);
    }
  });

  it('default selection matches the artifact (second PM asset)', () => {
    expect(DEFAULT_EXPLORER_ENTITY).toBe('1900 Broadway');
  });

  it('lede is computed: Rarig NOI rose 27.3% to $REDACTED-AMT in 2025', () => {
    expect(models['1100 Rarig'].lede).toBe('1100 Rarig Ave: NOI rose 27.3% to $REDACTED-AMT in 2025 (revenue +11.5%, operating expense -10.5%).');
  });

  it('lede for a short history says so', () => {
    expect(models['3883 Livingston'].lede).toMatch(/short history/);
  });

  it('RULE: NOI per SF uses CURRENT total SF and the full-year figure (never annualized)', () => {
    const k = models['1100 Rarig'].kpis.find((x) => x.id === 'noiPerSf')!;
    expect(k.value).toBe(`$${(REDACTED-AMT / 21_000).toFixed(2)}`);
    const y = models['1100 Rarig'].yoy;
    const s26 = y.columns.findIndex((c) => c.key === 'S26');
    const row = y.perSf.find((r) => r.label === 'NOI per SF')!;
    expect(row.cells[s26]!.value.value).toBeCloseTo(D.history['1100 Rarig'].ytd['2026']!.noi / 21_000, 10);
    expect(row.cells[s26]!.note).toBe('9 mo');
  });

  it('no per-SF anything for the solar entity', () => {
    const m = models['1851 South Club Solar'];
    expect(m.kpis.some((k) => k.id === 'noiPerSf' || k.id === 'occupancy')).toBe(false);
    expect(m.yoy.perSf).toEqual([]);
  });

  it('RULE: YoY table partial columns are n/m', () => {
    const y = models.FVC.yoy;
    y.columns.forEach((c, i) => {
      if (c.partial) for (const r of y.rows) expect(r.cells[i]!.change.value).toBeNull();
    });
  });

  it('occupancy KPI from the rent-roll block', () => {
    const k = models['9620 State 350'].kpis.find((x) => x.id === 'occupancy')!;
    expect(k.value).toBe('83.3%');
    expect(k.note).toBe('28,555 of 34,300 SF · 9 tenants');
  });

  it('RULE: lease panel ONLY for the four entities with a lease', () => {
    const withLease = PF_ENTITY_IDS.filter((id) => models[id].lease !== null);
    expect(withLease.sort()).toEqual(['3034 Westerville', '3540 E 5th', '3883 Livingston', '55 New Plant (EGFLLC)'].sort());
  });

  it('annual-only entities: no monthly series, honest note, no rent-step events', () => {
    for (const id of ['55 New Plant (EGFLLC)', '1851 South Club Solar'] as const) {
      const m = models[id];
      expect(m.monthly).toBe(false);
      expect(m.annualOnlyNote).toMatch(/annual/i);
      expect(m.events).toEqual([]);
    }
    expect(models['1100 Rarig'].annualOnlyNote).toBeNull();
  });

  it('missing-months note from missing_months_since_2024', () => {
    expect(models['3034 Westerville'].missingMonthsNote).toMatch(/Oct 2024/);
    expect(models['3883 Livingston'].missingMonthsNote).toMatch(/Jul 2025/);
    expect(models['1100 Rarig'].missingMonthsNote).toBeNull();
  });

  it('FVC carries the confirm-me SF mapping flag; nobody else does', () => {
    expect(models.FVC.fvcFlag?.active).toBe(true);
    expect(models.FVC.fvcFlag?.text).toMatch(/Confirm/);
    for (const id of PF_ENTITY_IDS) if (id !== 'FVC') expect(models[id].fvcFlag).toBeNull();
  });

  it('open portfolio-review items per property', () => {
    expect(models.FVC.openItems.map((i) => i.id).sort()).toEqual(['EXP-04', 'REC-01', 'REV-01']);
  });

  it('category table: revenue then opex sections, totals tie to the period row', () => {
    const c = models['1100 Rarig'].categories;
    const total = c.totals.find((r) => r.label === 'Total operating expense')!;
    const i25 = c.columns.findIndex((x) => x.key === '2025');
    expect(total.cells[i25]!.value).toBeCloseTo(REDACTED-AMT, 2);
    expect(c.revenue.map((r) => r.label)).toContain('Base rent');
  });
});

describe('chart data (series slots, tooltips)', () => {
  it('grouped bars: revenue = slot 1, opex = slot 2, NOI = slot 3; partial tooltips say not comparable', () => {
    const b = periodBars(periodGroups(D, 'FVC'));
    expect(b.series.map((s) => [s.label, s.slot])).toEqual([
      ['Revenue', 1],
      ['Operating expense', 2],
      ['NOI', 3],
    ]);
    const i22 = b.columns.findIndex((c) => c.key === '2022');
    expect(b.tips[i22]![2]).toContain('Partial period: not comparable');
    const i25 = b.columns.findIndex((c) => c.key === '2025');
    expect(b.tips[i25]![2]!.some((t) => /vs 2024/.test(t))).toBe(true);
    expect(b.values[i25]![2]).toBeCloseTo(D.history.FVC.yr['2025']!.noi, 6);
  });

  it('stacked opex: fixed category order and fixed slots 1-8; share of opex in the tooltip', () => {
    const s = opexStack(periodGroups(D, '1100 Rarig'));
    expect(s.series.map((x) => x.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s.series[0]!.id).toBe('Real estate & property tax');
    const i25 = s.columns.findIndex((c) => c.key === '2025');
    expect(s.tips[i25]![0]!.join(' ')).toMatch(/% of operating expense/);
  });

  it('F3: a net-credit category tooltip shows the signed value, the categoryTable change and no fake -100%', () => {
    const cases = [
      { id: '9620 State 350' as const, col: 'S26', cat: 'Real estate & property tax' as const, value: -REDACTED-AMT },
      { id: '3540 E 5th' as const, col: '2024', cat: 'Grounds / snow / lot' as const, value: -230 },
    ];
    for (const c of cases) {
      const gs = periodGroups(D, c.id);
      const s = opexStack(gs);
      const i = s.columns.findIndex((x) => x.key === c.col);
      const k = s.series.findIndex((x) => x.id === c.cat);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(s.values[i]![k]).toBe(c.value);
      const tip = s.tips[i]![k]!;
      // pinned against the category table the Explorer prints beside the chart
      const row = buildExplorer(D, c.id).categories.opex.find((r) => r.label === c.cat)!;
      const cell = row.cells[i]!;
      expect(cell.value).toBe(c.value);
      expect(tip[1]).toBe(`${usd(c.value, 'f')} (net credit)`);
      const g = gs[i]!;
      const pv = g.prev!.row.cats[c.cat] ?? 0;
      expect(cell.change).not.toBeNull();
      expect(tip[2]).toBe(`${pct(cell.change!.value)} vs ${g.prev!.label} (${usd(c.value - pv, 'f')})`);
      expect(tip.join(' ')).not.toMatch(/-100\.0%/);
      expect(tip.join(' ')).not.toMatch(/\$0\b/);
      expect(tip[3]).toBe('Share of operating expense: n/m (net credit)');
    }
  });

  it('F3: a partial period says why it carries no change line (like the revenue / opex / NOI bars)', () => {
    let seen = 0;
    for (const id of PF_ENTITY_IDS) {
      const gs = periodGroups(D, id);
      const s = opexStack(gs);
      gs.forEach((g, i) => {
        if (!g.partial) return;
        seen++;
        for (const tip of s.tips[i]!) expect(tip).toContain('Partial period: not comparable');
      });
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('F3: a positive category share is taken against the signed category total', () => {
    const gs = periodGroups(D, '9620 State 350');
    const s = opexStack(gs);
    const i = s.columns.findIndex((x) => x.key === 'S26');
    const k = s.series.findIndex((x) => x.id === 'Insurance');
    const cats = gs[i]!.row.cats;
    const total = Object.values(cats).reduce((a, v) => a + (v ?? 0), 0);
    expect(s.tips[i]![k]!.at(-1)).toBe(`${pctLevel((cats.Insurance ?? 0) / total)} of operating expense`);
  });

  it('timeline marker and lease step tooltips', () => {
    const t = timelineSeries(D, '9050 Red Branch', 'all')!;
    expect(t.markers[0]!.row.tip[0]).toMatch(/net base rent change/);
    const m = buildExplorer(D, '3034 Westerville');
    expect(m.lease!.rows[1]!.tip.join(' ')).toMatch(/vs prior step/);
  });
});

describe('rent schedule normalization (lease panel)', () => {
  it('ISO rows pass through; year rows become calendar years', () => {
    const np = D.leases.find((l) => l.property.startsWith('55 New Plant'))!;
    const s = normalizeRentSchedule(np);
    expect(s[0]).toEqual({ from: '2023-01-01', to: '2023-12-31', value: REDACTED-AMT });
  });

  it('relative rows (Y1 / LY1) anchor on the rent start parsed from the lease term', () => {
    const liv = D.leases.find((l) => l.property.includes('Livingston'))!;
    const s = normalizeRentSchedule(liv);
    expect(s[0]).toEqual({ from: '2026-09-01', to: '2027-08-31', value: REDACTED-AMT });
    const e5 = D.leases.find((l) => l.property === '3540 E 5th')!;
    expect(normalizeRentSchedule(e5)[0]!.from).toBe('2023-08-01');
    expect(normalizeRentSchedule(e5)[1]!.from).toBe('2024-08-01');
  });

  it('current and next step relative to the dataset date', () => {
    const m = buildExplorer(D, '3034 Westerville');
    expect(m.lease!.current?.value).toBe(REDACTED-AMT);
    expect(m.lease!.next?.from).toBe('2027-04-01');
    expect(m.lease!.next?.change.value).toBeCloseTo(REDACTED-AMT / REDACTED-AMT - 1, 10);
    expect(m.lease!.currentPerSf.value).toBeCloseTo((REDACTED-AMT * 12) / 18_360, 10);
  });
});

describe('What changed and why', () => {
  it('pairs: Jan-Sep first, then years newest first; labels from the data', () => {
    const w = whyView(D, '9050 Red Branch');
    expect(w.pairs[0]!.key).toBe('YTD26');
    expect(w.pairs[0]!.label).toBe('Jan-Sep 2026 vs Jan-Sep 2025');
    expect(w.pairs[1]!.key).toBe('2025');
    expect(w.pairs[1]!.label).toBe('2025 vs 2024');
  });

  it('effects: ≤10 lines, |effect| ≥ $500, ranked by size; opex increases hurt NOI', () => {
    const w = whyView(D, '1100 Rarig');
    const p = w.pairs[0]!;
    expect(p.effects.length).toBeLessThanOrEqual(EXPLORER_RULES.why.effectLimit);
    for (let i = 1; i < p.effects.length; i++) expect(Math.abs(p.effects[i - 1]!.impact)).toBeGreaterThanOrEqual(Math.abs(p.effects[i]!.impact));
    const tax = p.effects.find((e) => e.name === 'Real estate & property tax')!;
    expect(tax.impact).toBeLessThan(0);
    expect(tax.helps).toBe(false);
    expect(p.effects[0]!.width).toBe(1);
    for (const e of p.effects) expect(e.width).toBeGreaterThan(0);
    expect(tax.tip[2]).toMatch(/^Effect on NOI -\$/);
  });

  it('drivers carry nature tags labelled [INFERRED] from monthly timing, with hint text', () => {
    const w = whyView(D, '1100 Rarig');
    const tax = w.pairs[0]!.drivers.find((d) => d.category === 'Real estate & property tax')!;
    expect(tax.natureLabel).toBe('Lumpy');
    expect(tax.natureTag).toBe('[INFERRED] from monthly timing');
    expect(tax.text).toMatch(/74% sits in Jul 2026/);
    expect(tax.text).toMatch(/installments.*\[INFERRED\]/);
    expect(tax.helps).toBe(false);
  });

  it('a partial period never forms a pair (same guard as periodGroups): Livingston Jan-Sep 2025 has 3 of 9 months', () => {
    expect(D.history['3883 Livingston'].ytd['2025']!.n).toBe(3);
    expect(D.history['3883 Livingston'].drv.YTD26).toBeDefined(); // the dataset carries the drivers; the view must still refuse
    const w = whyView(D, '3883 Livingston');
    expect(w.pairs).toEqual([]);
    // Year pairs need 12 months on both sides; a short prior year drops that pair and nothing else.
    const h = D.history['1100 Rarig'];
    const short = { ...D, history: { ...D.history, '1100 Rarig': { ...h, yr: { ...h.yr, '2024': { ...h.yr['2024']!, n: 11 } } } } };
    expect(whyView(short, '1100 Rarig').pairs.map((p) => p.key)).toEqual(['YTD26']);
    expect(whyView(D, '1100 Rarig').pairs.map((p) => p.key)).toEqual(['YTD26', '2025']);
    // A short current Jan-Sep window drops the YTD pair.
    const shortYtd = { ...D, history: { ...D.history, '1100 Rarig': { ...h, ytd: { ...h.ytd, '2026': { ...h.ytd['2026']!, n: 8 } } } } };
    expect(whyView(shortYtd, '1100 Rarig').pairs.map((p) => p.key)).toEqual(['2025']);
    // Every pair that IS shown compares complete windows.
    for (const id of PF_ENTITY_IDS) {
      for (const p of whyView(D, id).pairs) {
        const hh = D.history[id];
        if (p.key === 'YTD26') expect([hh.ytd['2025']!.n, hh.ytd['2026']!.n]).toEqual([9, 9]);
        else if (hh.monthly) expect([hh.yr[String(Number(p.key) - 1)]!.n, hh.yr[p.key]!.n]).toEqual([12, 12]);
        else expect([hh.yr[String(Number(p.key) - 1)]!.partial, hh.yr[p.key]!.partial]).toEqual([false, false]);
      }
    }
  });

  it('annual entities: nature "annual" and the annual-only text', () => {
    const w = whyView(D, '1851 South Club Solar');
    expect(w.pairs.map((p) => p.key)).toEqual(['2025']);
    const d0 = w.pairs[0]!.drivers[0]!;
    expect(d0.natureLabel).toBe('Annual');
    expect(d0.text).toMatch(/Annual totals only/);
  });
});

describe('timeline + rent-step markers', () => {
  it('3-month trailing average; "since" window starts at the FY2024 first month', () => {
    const t = timelineSeries(D, '1100 Rarig', 'since');
    expect(t!.months[0]).toBe(D.meta.periods.FY2024.months[0]);
    const all = timelineSeries(D, '1100 Rarig', 'all')!;
    expect(all.months[0]).toBe('2023-10');
    expect(all.baseRent[0]).toBeNull();
    expect(all.baseRent[1]).toBeNull();
    const br = D.history['1100 Rarig'].months!.br;
    expect(all.baseRent[2]).toBeCloseTo((br[0]! + br[1]! + br[2]!) / 3, 6);
  });

  it('markers only for steps of at least the configured dollars a month, inside the window', () => {
    const all = timelineSeries(D, '9050 Red Branch', 'all')!;
    for (const m of all.markers) expect(Math.abs(m.event.b - m.event.a)).toBeGreaterThanOrEqual(EXPLORER_RULES.rentStepMinDollars);
    expect(timelineSeries(D, '1851 South Club Solar', 'all')).toBeNull();
  });
});

describe('computed insights (rules from the artifact, thresholds in EXPLORER_RULES)', () => {
  const heads = (id: PfEntityId) => explorerInsights(D, id).map((i) => i.heading);

  it('Red Branch: trajectory, this year so far, benchmark, vacancy, margin, recovery, mgmt fee, drivers', () => {
    const h = heads('9050 Red Branch');
    expect(h).toContain('Rent trajectory');
    expect(h).toContain('This year so far');
    expect(h.some((x) => x.startsWith('Per-SF benchmark'))).toBe(true);
    expect(h).toContain('Vacancy');
    expect(h).toContain('Margin');
    expect(h).toContain('Recovery');
    expect(h).toContain('Management fee');
    expect(h.some((x) => x.startsWith('Driver: '))).toBe(true);
  });

  it('rent trajectory CAGR equals the calc lib on the first and last full years', () => {
    const t = explorerInsights(D, '1900 Broadway').find((i) => i.heading === 'Rent trajectory')!;
    const yr = D.history['1900 Broadway'].yr;
    const want = cagr(yr['2016']!.br, yr['2025']!.br, 9).value!;
    expect(t.text).toContain(`${want > 0 ? '+' : ''}${(want * 100).toFixed(1)}%`);
  });

  it('per-SF benchmark goes through perSf: a zero-SF peer is left out, a zero-SF subject has no benchmark or vacancy line (never Infinity/NaN)', () => {
    const withSf = (id: PfEntityId, sf: number | null) => ({ ...D, sf: { ...D.sf, [id]: { ...D.sf[id], sf } } }) as PfDataset;
    const bench = (d: PfDataset, id: PfEntityId) => explorerInsights(d, id).find((i) => i.heading.startsWith('Per-SF benchmark'));
    // Peer with 0 SF: same text as a peer with no SF on file.
    const zeroPeer = bench(withSf('1100 Rarig', 0), '9050 Red Branch');
    expect(zeroPeer).toBeDefined();
    expect(zeroPeer!.text).not.toMatch(/Infinity|NaN/);
    expect(zeroPeer!.text).toBe(bench(withSf('1100 Rarig', null), '9050 Red Branch')!.text);
    // Subject with 0 SF: no per-SF line at all, like a subject with no SF on file.
    const subject = explorerInsights(withSf('9050 Red Branch', 0), '9050 Red Branch');
    expect(subject.some((i) => i.heading.startsWith('Per-SF benchmark'))).toBe(false);
    expect(subject.map((i) => i.heading)).not.toContain('Vacancy');
    for (const i of subject) expect(i.text, i.heading).not.toMatch(/Infinity|NaN/);
  });

  it('vacancy only below the occupancy threshold (Rarig 85.7% yes, Broadway 100% no)', () => {
    expect(heads('1100 Rarig')).toContain('Vacancy');
    expect(heads('1900 Broadway')).not.toContain('Vacancy');
  });

  it('management fee cap read from the lease (3540 E 5th), not hardcoded', () => {
    const t = explorerInsights(D, '3540 E 5th').find((i) => i.heading === 'Management fee')!;
    expect(t.text).toContain(D.leases.find((l) => l.property === '3540 E 5th')!.mgmt_fee_cap!);
  });

  it('data gap item for missing months; short history for Livingston', () => {
    expect(heads('3034 Westerville')).toContain('Data gap');
    expect(heads('3883 Livingston')).toContain('Short history');
  });

  it('driver insights never quote a partial comparison: Livingston (Jan-Sep 2025 = 3 months) has none; Rarig keeps its YTD26 drivers', () => {
    expect(heads('3883 Livingston').some((x) => x.startsWith('Driver: '))).toBe(false);
    expect(heads('1100 Rarig').some((x) => x.startsWith('Driver: '))).toBe(true);
    // Shortening Rarig's current Jan-Sep window to 8 months removes its YTD26 driver insights too.
    const h = D.history['1100 Rarig'];
    const shortYtd = { ...D, history: { ...D.history, '1100 Rarig': { ...h, ytd: { ...h.ytd, '2026': { ...h.ytd['2026']!, n: 8 } } } } };
    const after = explorerInsights(shortYtd, '1100 Rarig').filter((i) => i.heading.startsWith('Driver: '));
    for (const i of after) expect(i.text).not.toMatch(/Jan-Sep 2026/);
  });

  it('a threshold edit moves the rule (vacancy threshold 0.8 drops Rarig)', () => {
    const rules = { ...EXPLORER_RULES, vacancyBelowOccupancy: 0.8 };
    expect(explorerInsights(D, '1100 Rarig', rules).map((i) => i.heading)).not.toContain('Vacancy');
  });

  it('costs outrunning rent: only categories above the dollar floor growing faster than rent + the points margin', () => {
    for (const id of PF_ENTITY_IDS) {
      const c = explorerInsights(D, id).find((i) => i.heading === 'Costs outrunning rent');
      if (!c) continue;
      expect(c.text).toMatch(/First step for each/);
    }
  });

  it('percent changes in insights refuse a non-positive base (never a raw ratio)', () => {
    expect(pctChange(-1, 5).value).toBeNull();
  });
});
