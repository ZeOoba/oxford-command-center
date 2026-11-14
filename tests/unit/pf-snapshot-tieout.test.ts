// @vitest-environment node
//
// tests/unit/pf-snapshot-tieout.test.ts — snapshot (workbook model) vs Property Financials tie-out.
// Hand-built cases pin the rules (all NOI, SF and LTV values are synthetic); entity labels and ids are taken
// from mapping.ts ENTITY_TO_CANONICAL at run time rather than spelled out here. The last blocks run the
// committed synthetic snapshot + PF dataset (fixtures/synthetic) for structural invariants only.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset } from '@contracts/property-financials';
import { tieOutSnapshotToPf, type TieOutSnapshot, type TieOutPf } from '../../server/property-financials/snapshot-tieout';
import { CROSSCHECK_THRESHOLDS } from '../../server/property-financials/crosscheck-config';
import { ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';

const T = CROSSCHECK_THRESHOLDS.tieOut;
const exact = Object.entries(ENTITY_TO_CANONICAL).filter(([, v]) => v.method === 'exact');
const inferred = Object.entries(ENTITY_TO_CANONICAL).find(([, v]) => v.method === 'inferred');
const [EA, { id: A }] = exact[0]!;
const [EB, { id: B }] = exact[1]!;
const [EC, { id: C }] = exact[2]!;

const prop = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, sf: 20_000, noi: 100_000, oxfordOwnPct: 1, ltv: null, loanBalance: null, ...over,
});
const snap = (properties: unknown[], loans: unknown[] = []) => ({ properties, loans }) as unknown as TieOutSnapshot;
const pf = (entities: Record<string, { noi?: number; sf?: number; kind?: 'monthly' | 'annual' }>): TieOutPf => {
  const properties: Record<string, unknown> = {};
  const sf: Record<string, unknown> = {};
  for (const [e, v] of Object.entries(entities)) {
    properties[e] =
      v.kind === 'annual'
        ? { kind: 'annual', periods: { FY2025: { noi: v.noi ?? 0 } } }
        : { kind: 'monthly', periods: { TTM26: { noi: v.noi ?? 0 } } };
    sf[e] = { sf: v.sf ?? 20_000 };
  }
  return { properties, sf, meta: { as_of: '2026-09-30' } } as unknown as TieOutPf;
};
const noi = (rows: ReturnType<typeof tieOutSnapshotToPf>, id: string) => rows.find((r) => r.check === 'noi' && r.propertyId === id)!;

describe('NOI tie-out (PF TTM at 100% x ownership vs snapshot Oxford-share NOI)', () => {
  it('scales PF by oxfordOwnPct before comparing (50% asset)', () => {
    const rows = tieOutSnapshotToPf(snap([prop(B, { noi: 450_000, oxfordOwnPct: 0.5 })]), pf({ [EB]: { noi: 900_000 } }));
    expect(noi(rows, B).status).toBe('match');
    expect(noi(rows, B).pfValue).toBeCloseTo(450_000, 0);
  });

  it('in-tolerance inside the percent band OR the dollar band', () => {
    const pctBand = tieOutSnapshotToPf(snap([prop(A, { noi: 1_000_000 })]), pf({ [EA]: { noi: 1_000_000 * (1 - T.pctBand) } }));
    expect(noi(pctBand, A).status).toBe('in-tolerance');
    // the dollar band only applies to genuinely small NOI (<= 3x the band) AND a gap under the large-drift line
    // 28K vs 25K: 10.7% off (outside the percent band) but $3K (inside the dollar band), under the large-drift line
    const absBand = tieOutSnapshotToPf(snap([prop(A, { noi: 28_000 })]), pf({ [EA]: { noi: 25_000 } }));
    expect(noi(absBand, A).status).toBe('in-tolerance');
  });

  it('shares reconcile-noi.ts guards: the dollar band does not wave through a large gap or a mid-size asset', () => {
    // 40K vs 30K = 25% off: large-drift, not in-tolerance (the dollar band must not hide it)
    expect(noi(tieOutSnapshotToPf(snap([prop(A, { noi: 40_000 })]), pf({ [EA]: { noi: 30_000 } })), A).status).toBe('large-drift');
    // 98K vs 89K = 9.2%: above the percent band and above the small-NOI cap, so drift
    expect(noi(tieOutSnapshotToPf(snap([prop(A, { noi: 98_000 })]), pf({ [EA]: { noi: 89_000 } })), A).status).toBe('drift');
  });

  it('a sign conflict (profit vs loss) is never in-tolerance', () => {
    const r = noi(tieOutSnapshotToPf(snap([prop(A, { noi: 4_000 })]), pf({ [EA]: { noi: -5_000 } })), A);
    expect(['drift', 'large-drift']).toContain(r.status);
  });

  it('PF NOI of $0 against a non-zero snapshot NOI is n/m with a reason, not a clean pass', () => {
    const r = noi(tieOutSnapshotToPf(snap([prop(A, { noi: 9_000 })]), pf({ [EA]: { noi: 0 } })), A);
    expect(r.status).toBe('n/m');
    expect(r.reason).toContain('$0');
  });

  it('derives the TTM period from the dataset as-of year (no hard-coded TTM26)', () => {
    const p = pf({ [EA]: { noi: 100_000 } });
    (p.meta as { as_of: string }).as_of = '2027-03-31';
    const r = noi(tieOutSnapshotToPf(snap([prop(A)]), p), A);
    expect(r.status).toBe('n/m');
    expect(r.reason).toContain('TTM27');
  });

  it('a null snapshot NOI is n/m, and the SF check still runs for that property', () => {
    const rows = tieOutSnapshotToPf(snap([prop(A, { noi: null })]), pf({ [EA]: { noi: 100_000 } }));
    expect(noi(rows, A).status).toBe('n/m');
    expect(rows.some((x) => x.check === 'sf' && x.propertyId === A)).toBe(true);
  });

  it('drift between the band and the large-drift line; large-drift at/after it; both are warn, never error', () => {
    const drift = tieOutSnapshotToPf(snap([prop(A, { noi: 500_000 })]), pf({ [EA]: { noi: 410_000 } }));
    expect(noi(drift, A).status).toBe('drift');
    expect(noi(drift, A).severity).toBe('warn');
    const large = tieOutSnapshotToPf(snap([prop(A, { noi: 500_000 })]), pf({ [EA]: { noi: 500_000 * (1 - T.largeDriftPct) } }));
    expect(noi(large, A).status).toBe('large-drift');
    expect(noi(large, A).severity).toBe('warn');
  });

  it('annual-only PF entities are n/m with a reason', () => {
    const rows = tieOutSnapshotToPf(snap([prop(C)]), pf({ [EC]: { kind: 'annual', noi: 1 } }));
    const r = noi(rows, C);
    expect(r.status).toBe('n/m');
    expect(r.reason).toMatch(/annual/i);
  });

  it('a snapshot property with no PF entity is n/m with a reason', () => {
    const rows = tieOutSnapshotToPf(snap([prop('prop-unmapped'), prop(A)]), pf({}));
    expect(noi(rows, 'prop-unmapped').reason).toMatch(/not in the PF/i);
    expect(noi(rows, A).reason).toMatch(/not in the PF/i);
  });

  it('a PF entity whose canonical id is absent from the snapshot is n/m', () => {
    const rows = tieOutSnapshotToPf(snap([]), pf({ [EC]: { kind: 'annual', noi: 1 } }));
    const r = rows.find((x) => x.propertyId === C)!;
    expect(r.status).toBe('n/m');
    expect(r.reason).toMatch(/snapshot/i);
  });

  it.runIf(inferred !== undefined)('flags an inferred mapping on its row so a drift is not read as a clean property-level gap', () => {
    const [entity, { id }] = inferred!;
    const rows = tieOutSnapshotToPf(snap([prop(id, { noi: 750_000 })]), pf({ [entity]: { noi: 850_000 } }));
    expect(noi(rows, id).reason).toMatch(/inferred/i);
  });

  it('an exact mapping carries no inferred caveat', () => {
    const rows = tieOutSnapshotToPf(snap([prop(A, { noi: 750_000 })]), pf({ [EA]: { noi: 850_000 } }));
    expect(noi(rows, A).reason ?? '').not.toMatch(/inferred/i);
  });
});

describe('SF tie-out', () => {
  it('any difference is drift; equal is a match', () => {
    const rows = tieOutSnapshotToPf(snap([prop(A, { sf: 110_000 })]), pf({ [EA]: { sf: 109_500 } }));
    const r = rows.find((x) => x.check === 'sf' && x.propertyId === A)!;
    expect(r.status).toBe('drift');
    const ok = tieOutSnapshotToPf(snap([prop(A, { sf: 20_000 })]), pf({ [EA]: { sf: 20_000 } }));
    expect(ok.find((x) => x.check === 'sf')!.status).toBe('match');
  });
});

describe('LTV consistency (properties[].ltv vs the single borrower loan that collateralizes it)', () => {
  const loan = (over: Record<string, unknown>) => ({ id: 'l1', direction: 'borrower', collateralProperty: 'P', ltv: 0.42, ...over });
  const run = (propLtv: number | null, loans: unknown[]) =>
    tieOutSnapshotToPf(snap([prop('p', { name: 'P', ltv: propLtv })], loans), pf({}));
  const ltv = (rows: ReturnType<typeof run>) => rows.find((r) => r.check === 'ltv')!;

  it('flags a gap above the point band (loan row and property row on different value bases)', () => {
    const r = ltv(run(0.37, [loan({})]));
    expect(r.status).toBe('drift');
    expect(r.severity).toBe('warn');
  });

  it('within the band is in-tolerance', () => {
    expect(ltv(run(0.42 - T.ltvGapPoints + 0.001, [loan({})])).status).toBe('in-tolerance');
  });

  it('multiple borrower loans, or a null LTV on either side, are n/m (balance basis is checkDebtBasis territory)', () => {
    expect(ltv(run(0.37, [loan({}), loan({ id: 'l2' })])).status).toBe('n/m');
    expect(ltv(run(null, [loan({})])).status).toBe('n/m');
    expect(ltv(run(0.37, [loan({ ltv: null })])).status).toBe('n/m');
  });

  it('a property with a reported LTV but no borrower loan is n/m, never a comparison', () => {
    for (const loans of [[], [loan({ direction: 'lender' })]]) {
      const r = run(0.37, loans).filter((x) => x.check === 'ltv');
      expect(r).toHaveLength(1);
      expect(r[0]!.status).toBe('n/m');
    }
  });

  it('never compares an LTV to a governor literal (it compares two reported LTVs to each other)', () => {
    const src = readFileSync('server/property-financials/snapshot-tieout.ts', 'utf8');
    // any ltv/dscr code line carrying a governor literal fails, however it is spelled
    const literal = /(?<![\d.])(?:0?\.40?|0?\.65|1\.250?)(?!\d)/;
    const offending = src
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => /ltv|dscr/i.test(l) && literal.test(l));
    expect(offending).toEqual([]);
  });
});

describe('synthetic snapshot + PF dataset: structural invariants', () => {
  const ds = parsePropertyFinancialsDataset(JSON.parse(readFileSync('fixtures/synthetic/data/property-financials/dataset.json', 'utf8')));
  const snapshot = JSON.parse(readFileSync('fixtures/synthetic/data/snapshots/portfolio.json', 'utf8')) as TieOutSnapshot;
  const rows = tieOutSnapshotToPf(snapshot, ds);

  it('covers every snapshot property for NOI and SF', () => {
    for (const p of snapshot.properties) {
      expect(rows.some((r) => r.check === 'noi' && r.propertyId === p.id)).toBe(true);
      expect(rows.some((r) => r.check === 'sf' && r.propertyId === p.id)).toBe(true);
    }
  });

  it('every n/m row has a reason, and warn is only ever drift or large-drift', () => {
    expect(rows.filter((r) => r.status === 'n/m').every((r) => (r.reason ?? '').length > 0)).toBe(true);
    expect(rows.filter((r) => r.severity === 'warn').every((r) => r.status === 'drift' || r.status === 'large-drift')).toBe(true);
  });

  it('rows are sorted by check then property id (deterministic output)', () => {
    const key = (r: (typeof rows)[number]) => `${r.check}|${r.propertyId}`;
    expect(rows.map(key)).toEqual([...rows.map(key)].sort());
  });
});

describe('partial TTM', () => {
  it('a TTM with fewer than 12 months is n/m, never compared as drift', () => {
    const f = pf({ [EA]: { noi: 40_000 } }) as unknown as { properties: Record<string, { periods: { TTM26: { n_months?: number } } }> };
    f.properties[EA]!.periods.TTM26.n_months = 5;
    const rows = tieOutSnapshotToPf(snap([prop(A, { noi: 100_000 })]), f as unknown as TieOutPf);
    expect(noi(rows, A).status).toBe('n/m');
    expect(noi(rows, A).reason).toMatch(/partial period/);
  });
});

describe('governor-literal coupling for this directory (governance-check scans only warehouse/insights)', () => {
  it('no DSCR/LTV governor literal is compared against under server/property-financials (runs the REAL governance rule)', async () => {
    const { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { checkGovernorLiteralCoupling } = await import('../../scripts/governance-check');
    const root = mkdtempSync(join(tmpdir(), 'pf-gov-'));
    try {
      mkdirSync(join(root, 'server', 'warehouse'), { recursive: true });
      for (const f of readdirSync('server/property-financials').filter((n) => n.endsWith('.ts'))) {
        copyFileSync(join('server/property-financials', f), join(root, 'server', 'warehouse', f));
      }
      expect(checkGovernorLiteralCoupling(root).errors).toEqual([]);
      // control: the rule does fire on a violating line, so the empty result above is meaningful
      writeFileSync(join(root, 'server', 'warehouse', 'bad.ts'), 'export const f = (p: { ltv: number }) => p.ltv > 0.40;');
      expect(checkGovernorLiteralCoupling(root).pass).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NOI bands are the reconcile-noi defaults, not copies', async () => {
    const { DEFAULT_TOLERANCE } = await import('../../server/warehouse/reconcile-noi');
    expect(T.pctBand).toBe(DEFAULT_TOLERANCE.pctBand);
    expect(T.absBandUsd).toBe(DEFAULT_TOLERANCE.absBandUsd);
    expect(T.largeDriftPct).toBe(DEFAULT_TOLERANCE.largeDriftPct);
  });

  it('a reported property LTV with no mapped loan is n/m with a reason', () => {
    const rows = tieOutSnapshotToPf(snap([prop(A, { ltv: 0.45 })]), pf({ [EA]: { noi: 100_000 } }));
    const r = rows.find((x) => x.check === 'ltv' && x.propertyId === A)!;
    expect(r.status).toBe('n/m');
    expect(r.reason).toMatch(/no borrower loan/);
  });
});
