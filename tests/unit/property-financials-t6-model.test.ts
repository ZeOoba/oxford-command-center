// tests/unit/property-financials-t6-model.test.ts — T6 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. View-model of the Levers,
// Watchlist and Evaluation views (src/modules/property-financials/model.ts) on the REAL dataset.
// Expected values are recomputed here from the raw dataset, not by calling the function under test.
import { describe, expect, it } from 'vitest';
import { OPEX_CATEGORIES, PF_MONTHLY_ENTITY_IDS, PF_SEVERITIES, type PfMonthlyProperty } from '@contracts/property-financials';
import { evaluationResults } from '@analytics/property-financials/metrics';
import { EVALUATION_TEST_IDS, THRESHOLDS, ragStatus, type EvaluationTestId, type EvaluationThreshold } from '@analytics/property-financials/thresholds';
import {
  WATCHLIST_ALL,
  WATCHLIST_MOVER_RULES,
  evaluationMatrix,
  filterWatchlist,
  leverInsights,
  runRateRows,
  topOpexMovers,
  watchlistPropertyOptions,
} from '../../src/modules/property-financials/model';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const SEV = { High: 0, Medium: 1, Low: 2 } as const;

describe('Levers: revenue + recovery items', () => {
  it('only Revenue and Recovery insights, severity then |impact| (unknown impact last in band)', () => {
    const got = leverInsights(D.insights);
    const want = D.insights.filter((i) => i.type === 'Revenue' || i.type === 'Recovery');
    expect(new Set(got.map((i) => i.id))).toEqual(new Set(want.map((i) => i.id)));
    for (let k = 1; k < got.length; k++) {
      const a = got[k - 1]!;
      const b = got[k]!;
      expect(SEV[a.severity] <= SEV[b.severity]).toBe(true);
      if (a.severity === b.severity) expect(Math.abs(a.annual_impact_usd ?? -1) >= Math.abs(b.annual_impact_usd ?? -1)).toBe(true);
    }
  });
});

describe('Levers: base-rent run-rate rows', () => {
  it('one row per PM asset; Q3 values = mean(Jul..Sep) x 12 from the monthly cube; n/m with a reason', () => {
    const rows = runRateRows(D);
    expect(rows.map((r) => r.id)).toEqual([...PF_MONTHLY_ENTITY_IDS]);
    for (const r of rows) {
      const cube = D.monthly[r.id];
      for (const y of [2024, 2025, 2026] as const) {
        const ms = ['07', '08', '09'].map((m) => cube[`${y}-${m}`]?.base_rent);
        const cell = r.q3[y];
        if (ms.some((v) => v === undefined)) {
          expect(cell.value, `${r.id} ${y}`).toBeNull();
          expect(cell.reason).toMatch(new RegExp(`Jul-Sep ${y}`));
        } else {
          expect(cell.value).toBeCloseTo(((ms[0]! + ms[1]! + ms[2]!) / 3) * 12, 6);
        }
      }
      if (r.q3[2025].value !== null && r.q3[2026].value !== null) expect(r.yoy2026.value).toBeCloseTo(r.q3[2026].value! / r.q3[2025].value! - 1, 10);
      else expect(r.yoy2026.reason).toBeTruthy();
    }
    // Livingston has no 2024/2025 Q3 (lease-up): both changes n/m.
    const l = rows.find((r) => r.id === '3883 Livingston')!;
    expect(l.yoy2025.value).toBeNull();
    expect(l.yoy2026.value).toBeNull();
  });
});

describe('Watchlist filters', () => {
  it('property options: All + each Expense item property once, in dataset order', () => {
    const want = [WATCHLIST_ALL, ...new Set(D.insights.filter((i) => i.type === 'Expense').map((i) => i.property))];
    expect(watchlistPropertyOptions(D.insights)).toEqual(want);
  });

  it('All/All = every Expense item, severity then |impact| descending', () => {
    const got = filterWatchlist(D.insights, { property: WATCHLIST_ALL, severity: WATCHLIST_ALL });
    expect(got.length).toBe(D.insights.filter((i) => i.type === 'Expense').length);
    expect(got.every((i) => i.type === 'Expense')).toBe(true);
    for (let k = 1; k < got.length; k++) {
      const a = got[k - 1]!;
      const b = got[k]!;
      expect(SEV[a.severity] < SEV[b.severity] || (a.severity === b.severity && Math.abs(a.annual_impact_usd ?? -1) >= Math.abs(b.annual_impact_usd ?? -1))).toBe(true);
    }
  });

  it('property and severity filters compose; a combination with nothing returns []', () => {
    for (const sev of PF_SEVERITIES) {
      const got = filterWatchlist(D.insights, { property: 'Portfolio', severity: sev });
      expect(got.map((i) => i.id).sort()).toEqual(D.insights.filter((i) => i.type === 'Expense' && i.property === 'Portfolio' && i.severity === sev).map((i) => i.id).sort());
    }
    expect(filterWatchlist(D.insights, { property: '1100 Rarig', severity: 'High' })).toEqual([]);
  });
});

describe('Watchlist: largest account movers', () => {
  it('opex accounts only, all PM assets, |delta| > $2,500, top 24 by |delta|', () => {
    expect(WATCHLIST_MOVER_RULES).toMatchObject({ minAbsDelta: 2500, limit: 24 });
    const all: Array<{ id: string; delta: number; category: string }> = [];
    for (const id of PF_MONTHLY_ENTITY_IDS) for (const m of D.account_movers[id].YTD26_vs_YTD25) all.push({ id, delta: m.delta, category: m.category });
    const want = all.filter((x) => Math.abs(x.delta) > 2500 && (OPEX_CATEGORIES as readonly string[]).includes(x.category)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 24);
    const got = topOpexMovers(D);
    expect(got).toHaveLength(24);
    expect(got.map((g) => [g.entity, g.mover.delta])).toEqual(want.map((w) => [w.id, w.delta]));
    expect(new Set(got.map((g) => g.entity)).size).toBeGreaterThan(1);
  });

  it('the dollar floor and the limit come from the rules object', () => {
    expect(topOpexMovers(D, { ...WATCHLIST_MOVER_RULES, limit: 5 })).toHaveLength(5);
    const big = topOpexMovers(D, { ...WATCHLIST_MOVER_RULES, minAbsDelta: 20_000, limit: 100 });
    expect(big.every((g) => Math.abs(g.mover.delta) > 20_000)).toBe(true);
  });
});

describe('Evaluation matrix = calc-lib outputs', () => {
  it('nine PM rows x eight tests; every cell status === ragStatus(evaluationResults)', () => {
    const m = evaluationMatrix(D);
    expect(m.map((r) => r.id)).toEqual([...PF_MONTHLY_ENTITY_IDS]);
    for (const row of m) {
      const res = evaluationResults(D.properties[row.id] as PfMonthlyProperty, D.monthly[row.id]);
      for (const t of EVALUATION_TEST_IDS) {
        expect(row.cells[t].result).toEqual(res[t]);
        expect(row.cells[t].status).toBe(ragStatus(t, res[t].value));
      }
    }
  });

  it('a cloned config with a moved boundary changes exactly that column', () => {
    const clone = structuredClone(THRESHOLDS) as Record<EvaluationTestId, EvaluationThreshold>;
    clone.noiMargin = { ...clone.noiMargin, green: 0.7 };
    const a = evaluationMatrix(D);
    const b = evaluationMatrix(D, clone);
    let moved = 0;
    for (let i = 0; i < a.length; i++) {
      for (const t of EVALUATION_TEST_IDS) {
        const changed = a[i]!.cells[t].status !== b[i]!.cells[t].status;
        if (t !== 'noiMargin') expect(changed).toBe(false);
        else if (changed) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });
});
