// @vitest-environment node
//
// tests/unit/pf-tax-timing.test.ts — YTD real estate tax vs prior-YTD detector over the PF dataset.
// Hand-built cases pin the rules; the last block runs the committed synthetic PF dataset
// (fixtures/synthetic) for structural invariants only. All entity labels and dollar amounts are synthetic.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset } from '@contracts/property-financials';
import { taxTimingRows, taxTimingInsights } from '../../server/property-financials/tax-timing';
import { CROSSCHECK_THRESHOLDS } from '../../server/property-financials/crosscheck-config';

type Hist = Parameters<typeof taxTimingRows>[0];
/** 2026 YTD = Jan-Sep = 9 months: the full-period length a Sep-30 as-of date implies. */
const runRows = (h: Hist) => taxTimingRows(h, '2026', 9);

const TAX = 'Real estate & property tax';
const months = (y: string, n: number) => Array.from({ length: n }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

function entity(opts: { ytd25: number | null; ytd26: number | null; n25?: number; n26?: number; tx26?: number[]; tx25?: number[] }) {
  const n25 = opts.n25 ?? 9;
  const n26 = opts.n26 ?? 9;
  const g = [...months('2025', n25), ...months('2026', n26)];
  const tx = [...(opts.tx25 ?? Array(n25).fill(0)), ...(opts.tx26 ?? Array(n26).fill(0))];
  const mk = (n: number, tax: number | null) => ({ n, cats: tax === null ? {} : { [TAX]: tax } });
  return {
    monthly: true,
    ytd: { '2025': mk(n25, opts.ytd25), '2026': mk(n26, opts.ytd26) },
    months: { g, br: g.map(() => 0), rv: g.map(() => 0), ox: g.map(() => 0), tx },
  };
}
const hist = (e: Record<string, ReturnType<typeof entity>>) => e as unknown as Hist;

describe('taxTimingRows', () => {
  it('flags a drop of >=30% and >=$5K as a possible missing installment', () => {
    const [r] = runRows(hist({ 'Entity A': entity({ ytd25: 60_000, ytd26: 24_000 }) }));
    expect(r!.kind).toBe('drop');
    expect(r!.delta).toBeCloseTo(-36_000, 0);
    expect(r!.pct).toBeCloseTo(-0.6, 2);
  });

  it('flags a rise of >=40% and >=$5K', () => {
    const [r] = runRows(hist({ 'Entity B': entity({ ytd25: 15_000, ytd26: 32_000 }) }));
    expect(r!.kind).toBe('rise');
  });

  it('is ok inside the band, and the thresholds are inclusive', () => {
    const t = CROSSCHECK_THRESHOLDS;
    expect(runRows(hist({ A: entity({ ytd25: 40_000, ytd26: 38_000 }) }))[0]!.kind).toBe('ok');
    const atEdge = 100_000 * (1 - t.taxDropPct);
    expect(runRows(hist({ A: entity({ ytd25: 100_000, ytd26: atEdge }) }))[0]!.kind).toBe('drop');
  });

  it('does not flag a big percent on a tiny dollar base (min-dollar guard)', () => {
    expect(runRows(hist({ A: entity({ ytd25: 2_000, ytd26: 500 }) }))[0]!.kind).toBe('ok');
  });

  it('is n/m with a reason when month counts differ (partial period is never compared)', () => {
    const [r] = runRows(hist({ A: entity({ ytd25: 60_000, ytd26: 10_000, n26: 6 }) }));
    expect(r!.kind).toBe('n/m');
    expect(r!.reason).toMatch(/month/i);
  });

  it('is n/m when BOTH years are equally partial (8 of 9 months): equal n is not the same as a full period', () => {
    const [r] = runRows(hist({ A: entity({ ytd25: 60_000, ytd26: 10_000, n25: 8, n26: 8 }) }));
    expect(r!.kind).toBe('n/m');
    expect(r!.reason).toMatch(/9/);
  });

  it('is n/m when there is no prior-year base', () => {
    expect(runRows(hist({ A: entity({ ytd25: 0, ytd26: 5_000 }) }))[0]!.kind).toBe('n/m');
    expect(runRows(hist({ A: entity({ ytd25: null, ytd26: 5_000 }) }))[0]!.reason).toMatch(/prior/i);
  });

  it('skips non-monthly (annual) entities', () => {
    const annual = { monthly: false, ytd: {}, months: null } as unknown as ReturnType<typeof entity>;
    const rows = runRows(hist({ 'Annual Entity': annual }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('n/m');
    expect(rows[0]!.reason).toMatch(/annual statements only/);
  });

  it('names the months that paid tax last year but nothing this year', () => {
    const tx25 = [0, 0, 20_000, 0, 0, 0, 0, 0, 20_000];
    const tx26 = [0, 0, 20_000, 0, 0, 0, 0, 0, 0];
    const [r] = runRows(hist({ A: entity({ ytd25: 40_000, ytd26: 20_000, tx25, tx26 }) }));
    expect(r!.kind).toBe('drop');
    expect(r!.quietMonths).toEqual(['2026-09']);
  });
});

describe('taxTimingInsights', () => {
  const rows = runRows(
    hist({
      'Entity A': entity({ ytd25: 60_000, ytd26: 24_000 }),
      'Entity B': entity({ ytd25: 15_000, ytd26: 32_000 }),
      'Entity C': entity({ ytd25: 30_000, ytd26: 29_000 }),
    }),
  );
  const toId = (e: string) => ({ 'Entity A': 'prop-a', 'Entity B': 'prop-b' } as Record<string, string>)[e] ?? null;

  it('drop -> warning; rise -> info; ok -> nothing', () => {
    const ins = taxTimingInsights(rows, toId);
    const a = ins.find((i) => i.entityId === 'prop-a')!;
    expect(a.severity).toBe('warning');
    expect(a.category).toBe('anomaly');
    // a YTD gap is not an annual figure, so it must not be carried as impactAnnualUsd (the brief prints it as $/yr)
    expect(a.impactAnnualUsd).toBeNull();
    expect(a.detail).toMatch(/\$36,000/);
    expect(a.id).toBe('pf-tax-drop-prop-a-ytd2026');
    const b = ins.find((i) => i.entityId === 'prop-b')!;
    expect(b.severity).toBe('info');
    expect(b.impactAnnualUsd).toBeNull();
    expect(ins).toHaveLength(2);
  });

  it('drops an insight whose entity has no canonical id rather than emitting an unattributed alert', () => {
    expect(taxTimingInsights(rows, () => null)).toEqual([]);
  });

  it('a NEGATIVE ytd (refund/credit booked) is described as a credit, not as an unpaid installment', () => {
    const r = runRows(hist({ 'Entity A': entity({ ytd25: 20_000, ytd26: -5_000 }) }));
    expect(r[0]!.kind).toBe('drop');
    const [i] = taxTimingInsights(r, toId);
    expect(i!.detail).toMatch(/refund|credit/i);
    expect(i!.detail).not.toMatch(/unpaid|overstated/i);
  });

  it('PF is 100% basis: a 50% asset shows the ORA share dollars and says so', () => {
    const half = (id: string) => (id === 'prop-a' ? 0.5 : 1);
    const a = taxTimingInsights(rows, toId, undefined, half).find((i) => i.entityId === 'prop-a')!;
    expect(a.detail).toMatch(/ORA share/);
    expect(a.detail).toMatch(/\$18,000/);
  });

  it('does not assert NOI is overstated as fact: the effect depends on whether the lease passes tax through', () => {
    const a = taxTimingInsights(rows, toId).find((i) => i.entityId === 'prop-a')!;
    expect(a.detail).toMatch(/if .*(pass|reimburs|NNN)/i);
  });

  it('is deterministic: sorted by id', () => {
    const ins = taxTimingInsights(rows, toId);
    expect(ins.map((i) => i.id)).toEqual([...ins.map((i) => i.id)].sort());
  });
});

describe('synthetic PF dataset: structural invariants', () => {
  const ds = parsePropertyFinancialsDataset(JSON.parse(readFileSync('fixtures/synthetic/data/property-financials/dataset.json', 'utf8')));
  const rows = taxTimingRows(ds.history, ds.meta.as_of.slice(0, 4), Number(ds.meta.as_of.slice(5, 7)));

  it('emits one row per history entity, sorted by entity', () => {
    expect(rows.map((r) => r.entity)).toEqual(Object.keys(ds.history).sort());
  });

  it('annual entities appear only as n/m rows with a reason', () => {
    const annual = rows.filter((r) => !ds.history[r.entity as keyof typeof ds.history]!.monthly);
    expect(annual.length).toBeGreaterThan(0);
    expect(annual.every((r) => r.kind === 'n/m' && (r.reason ?? '').length > 0)).toBe(true);
  });

  it('every n/m row carries a reason, and every finding carries a delta and a percent', () => {
    expect(rows.filter((r) => r.kind === 'n/m').every((r) => (r.reason ?? '').length > 0)).toBe(true);
    for (const r of rows.filter((x) => x.kind === 'drop' || x.kind === 'rise')) {
      expect(typeof r.delta).toBe('number');
      expect(typeof r.pct).toBe('number');
    }
  });
});
