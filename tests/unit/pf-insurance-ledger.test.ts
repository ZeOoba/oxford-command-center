// @vitest-environment node
//
// tests/unit/pf-insurance-ledger.test.ts — insurance tracker vs PF ledger cross-check.
// Hand-built cases pin the rules (every premium and posting below is a synthetic round number); the last
// block runs the committed synthetic snapshot + PF dataset (fixtures/synthetic) for structural invariants.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset } from '@contracts/property-financials';
import {
  insuranceLedgerRows,
  insuranceLedgerInsights,
  policyEntityResolver,
  type LedgerPolicy,
} from '../../server/property-financials/insurance-ledger';
import { CROSSCHECK_THRESHOLDS } from '../../server/property-financials/crosscheck-config';

type Cube = Parameters<typeof insuranceLedgerRows>[1];

const pol = (p: Partial<LedgerPolicy> & Pick<LedgerPolicy, 'id' | 'status' | 'expires' | 'premium'>): LedgerPolicy => ({
  coverage: 'Package (PCKG)',
  effective: null,
  ...p,
});
/** monthly cube for one entity: {YYYY-MM: insurance dollars}; other fields irrelevant here. */
const cube = (entity: string, ins: Record<string, number>): Cube =>
  ({ [entity]: Object.fromEntries(Object.entries(ins).map(([m, v]) => [m, { opex_by: { Insurance: v } }])) }) as unknown as Cube;
const toEntity = (id: string) => (id.startsWith('ins-a-') ? 'A' : id.startsWith('ins-b-') ? 'B' : null);
const months = (from: string, n: number): string[] => {
  const [y, m] = from.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
};
const led = (from: string, n: number, v = 0) => Object.fromEntries(months(from, n).map((m) => [m, v]));

describe('stale tracker (lapsed in tracker, premium still posting in ledger)', () => {
  it('a live Package renewal explains the posting: a dropped BCL is not flagged as stale', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2026-03-19', premium: 600 }),
        pol({ id: 'ins-a-pckg', status: 'Active', effective: '2026-03-19', expires: '2027-03-19', premium: 6000 }),
      ],
      cube('A', { '2026-03': 6000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('a location whose ledger holds no months is n/m, not a throw', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Active', expires: '2027-03-19', premium: 6000 })],
      { A: {} } as unknown as Cube,
      toEntity,
    );
    expect(rows[0]!.kind).toBe('n/m');
  });

  it('"Excess Flood" and "Package (Property + GL)" are property lines, not liability', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-fl', coverage: 'Excess Flood', status: 'Expired', expires: '2026-03-19', premium: 1000 }),
        pol({ id: 'ins-a-pk', coverage: 'Package (Property + GL)', status: 'Active', expires: '2027-03-19', premium: 1000 }),
      ],
      cube('A', { '2026-01': 0 }),
      toEntity,
    );
    // replacement guard treats them as one family, so the Active package suppresses the lapsed flood line
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('renewal-lump: a posting in the expiry month worth >=50% of the lapsed premium', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-03-19', premium: 6000 })],
      cube('A', { '2026-03': 5000 }),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'stale-tracker')!;
    expect(r.evidence).toBe('renewal-lump');
    expect(r.postedMonths).toEqual(['2026-03']);
    expect(r.posted).toBe(5000);
  });

  it('a posting below the renewal share is not enough', () => {
    const t = CROSSCHECK_THRESHOLDS.insuranceRenewalShare;
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-03-19', premium: 10_000 })],
      cube('A', { '2026-03': 10_000 * t - 1 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('installments: monthly postings continuing in at least two months after the expiry month', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-08-31', premium: 24_000 })],
      cube('A', led('2025-11', 12, 2_000)),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'stale-tracker')!;
    expect(r.evidence).toBe('installments');
    expect(r.postedMonths).toEqual(['2026-09', '2026-10']);
  });

  it('ONE posting after the expiry month is not an installment pattern (a final payment in arrears)', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-08-31', premium: 24_000 })],
      cube('A', led('2025-10', 12, 2_000)),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('a lapsed property line is NOT replaced by a later-expiring liability line (coverage family must match)', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-prop', coverage: 'Package (PCKG)', status: 'Expired', expires: '2026-03-19', premium: 6_000 }),
        pol({ id: 'ins-a-gl', coverage: 'Business Liability', status: 'Current', expires: '2027-05-28', premium: 300 }),
      ],
      cube('A', { '2026-03': 5_000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(true);
  });

  it('bare GL / BCL abbreviations are recognised as liability lines (word-boundary match, not a substring)', () => {
    for (const abbr of ['GL', 'BCL']) {
      const rows = insuranceLedgerRows(
        [
          pol({ id: 'ins-a-x', coverage: abbr, status: 'Expired', expires: '2026-03-19', premium: 5_000 }),
          pol({ id: 'ins-a-pkg', coverage: 'Package (PCKG)', status: 'Current', expires: '2027-05-28', premium: 1_000 }),
        ],
        cube('A', { '2026-03': 4_000 }),
        toEntity,
      );
      expect(rows.some((x) => x.kind === 'stale-tracker'), abbr).toBe(true);
    }
  });

  it('a cancelled liability line IS replaced by a later-expiring liability line', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-gl', coverage: 'General Liability (GL)', status: 'Cancelled', expires: '2026-10-18', premium: 2_500 }),
        pol({ id: 'ins-a-bl', coverage: 'Business Liability', status: 'Current', expires: '2027-05-28', premium: 300 }),
      ],
      cube('A', { '2026-11': 2_900 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('a lapsed line with a null expiry date is skipped, never a crash', () => {
    expect(() =>
      insuranceLedgerRows(
        [pol({ id: 'ins-a-pckg', status: 'Expired', expires: null, premium: 6_000 })],
        cube('A', { '2026-03': 5_000 }),
        toEntity,
      ),
    ).not.toThrow();
  });

  it('a lapse with no later posting is not stale (the existing critical lapse alert stands alone)', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-03-19', premium: 6000 })],
      cube('A', { '2025-03': 6000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('Cancelled counts like Expired', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Cancelled', expires: '2026-03-19', premium: 6000 })],
      cube('A', { '2026-04': 6000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(true);
  });

  it('a lapsed line replaced by a later-expiring current line of the same family is skipped (carrier swap)', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-prop', status: 'Cancelled', expires: '2026-10-18', premium: 28_000 }),
        pol({ id: 'ins-a-new', status: 'Current', expires: '2027-05-28', premium: 18_000 }),
      ],
      cube('A', { '2026-06': 19_000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });
});

describe('ledger excess (trailing-12 ledger insurance vs the tracker premium)', () => {
  it('flags >=1.5x the tracker premium and >= $2K excess (two identical annual postings)', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', expires: '2027-06-11', premium: 5700 }), pol({ id: 'ins-a-bcl', status: 'Current', expires: '2027-06-11', premium: 600 })],
      cube('A', { '2026-05': 6300, '2026-06': 6300 }),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.ledgerT12).toBe(12_600);
    expect(r.trackerPremium).toBe(6300);
    expect(r.ratio).toBeCloseTo(2, 5);
    expect(r.excess).toBe(6300);
  });

  it('the denominator includes cancelled lines too (a mid-year carrier swap is not a double payment)', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-prop', status: 'Cancelled', expires: '2026-10-18', premium: 30_000 }),
        pol({ id: 'ins-a-new', status: 'Current', expires: '2027-05-28', premium: 18_000 }),
      ],
      cube('A', { '2025-11': 29_500, '2025-12': 3_000, '2026-06': 19_000 }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(false);
  });

  it('the window is 12 CALENDAR months: a missing month makes the check n/m, not a false double payment', () => {
    // one annual premium paid Sep-25 and again Sep-26, with 2026-03 absent from the cube: 12 PRESENT months
    // would span 13 calendar months and read as 2x
    const present = months('2025-09', 13).filter((m) => m !== '2026-03');
    const ins = Object.fromEntries(present.map((m) => [m, m === '2025-09' || m === '2026-09' ? 6_000 : 0]));
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', expires: '2027-09-01', premium: 6_000 })],
      cube('A', ins),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(false);
    expect(rows.find((x) => x.kind === 'n/m')!.reason).toMatch(/missing|gap/i);
  });

  it('only the trailing 12 months of the entity count', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', expires: '2027-06-11', premium: 6300 })],
      cube('A', { '2024-01': 6300, ...Object.fromEntries(months('2025-10', 12).map((m, i) => [m, i === 11 ? 6300 : 0])) }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(false);
  });

  it('thresholds are inclusive at the ratio and the dollar floor', () => {
    const t = CROSSCHECK_THRESHOLDS;
    const prem = t.insuranceMinExcessUsd / (t.insuranceDoublePayRatio - 1);
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', expires: '2027-06-11', premium: prem })],
      cube('A', { '2026-06': prem * t.insuranceDoublePayRatio }),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(true);
  });
});

describe('not meaningful', () => {
  it('a policy whose location has no PF monthly ledger is n/m with a reason', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-z-pckg', status: 'Expired', expires: '2026-04-05', premium: 1_000 })],
      cube('A', {}),
      toEntity,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('n/m');
    expect(rows[0]!.reason).toMatch(/monthly/i);
  });

  it('a $0 evidence-of-insurance line has no tracker premium to test against', () => {
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-eoi', status: 'Current', expires: '2027-04-01', premium: 0, coverage: 'Evidence of Property Insurance' })],
      cube('A', { '2026-06': 5_000 }),
      toEntity,
    );
    expect(rows.every((x) => x.kind !== 'excess-ledger' && x.kind !== 'stale-tracker')).toBe(true);
  });
});

describe('insuranceLedgerInsights', () => {
  const rows = insuranceLedgerRows(
    [
      pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-03-19', premium: 6000 }),
      pol({ id: 'ins-b-pckg', status: 'Current', expires: '2027-06-11', premium: 6300 }),
    ],
    { ...cube('A', { '2026-03': 5000 }), ...cube('B', { '2026-05': 6300, '2026-06': 6300 }) } as Cube,
    toEntity,
  );
  const canon = (e: string) => ({ A: 'prop-a', B: 'prop-b' } as Record<string, string>)[e] ?? null;

  it('stale tracker -> info (never suppresses the existing lapse alert); excess -> warning with impact', () => {
    const ins = insuranceLedgerInsights(rows, canon);
    const a = ins.find((i) => i.entityId === 'prop-a')!;
    expect(a.id).toBe('pf-ins-stale-tracker-prop-a');
    expect(a.severity).toBe('info');
    expect(a.category).toBe('insurance');
    expect(a.detail).toMatch(/confirm/i);
    const b = ins.find((i) => i.entityId === 'prop-b')!;
    expect(b.id).toBe('pf-ins-ledger-excess-prop-b');
    expect(b.severity).toBe('warning');
    expect(b.impactAnnualUsd).toBe(6300);
  });

  it('PF dollars are 100% basis: a 50% asset reports the ORA share in impact and says so', () => {
    const half = (id: string) => (id === 'prop-b' ? 0.5 : 1);
    const b = insuranceLedgerInsights(rows, canon, undefined, half).find((i) => i.entityId === 'prop-b')!;
    expect(b.impactAnnualUsd).toBe(3150);
    expect(b.detail).toMatch(/ORA share/);
    const full = insuranceLedgerInsights(rows, canon).find((i) => i.entityId === 'prop-b')!;
    expect(full.detail).not.toMatch(/ORA share/);
  });

  it('n/m and ok rows emit nothing; sorted by id', () => {
    const ins = insuranceLedgerInsights(rows, canon);
    expect(ins.map((i) => i.id)).toEqual([...ins.map((i) => i.id)].sort());
    expect(insuranceLedgerInsights([{ kind: 'n/m', entity: 'A' } as never], canon)).toEqual([]);
  });
});

describe('synthetic snapshot + PF dataset: structural invariants', () => {
  const ds = parsePropertyFinancialsDataset(JSON.parse(readFileSync('fixtures/synthetic/data/property-financials/dataset.json', 'utf8')));
  const snap = JSON.parse(readFileSync('fixtures/synthetic/data/snapshots/portfolio.json', 'utf8')) as { insurance: LedgerPolicy[] };
  const rows = insuranceLedgerRows(snap.insurance, ds.monthly, policyEntityResolver());

  it('runs over the whole tracker without throwing and resolves at least one location to a PF entity', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.kind !== 'n/m')).toBe(true);
  });

  it('locations without a PF monthly ledger are n/m with a reason, never silently clean', () => {
    const nm = rows.filter((r) => r.kind === 'n/m');
    expect(nm.length).toBeGreaterThan(0);
    expect(nm.every((r) => (r.reason ?? '').length > 0)).toBe(true);
  });

  it('every finding carries its evidence fields', () => {
    for (const r of rows.filter((x) => x.kind === 'stale-tracker')) {
      expect(r.evidence).not.toBeNull();
      expect(r.postedMonths.length).toBeGreaterThan(0);
    }
    for (const r of rows.filter((x) => x.kind === 'excess-ledger')) {
      expect(r.ratio).not.toBeNull();
      expect(r.excess).not.toBeNull();
    }
  });
});

describe('adversarial-review regressions: live lines explain postings', () => {
  it('a live Package paid monthly explains the post-lapse postings (installments branch)', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Current', effective: '2026-08-31', expires: '2027-08-31', premium: 21_600 }),
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2026-08-31', premium: 2_200 }),
      ],
      cube('A', led('2025-10', 13, 1_800)),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('a live line renewed BEFORE the lapse also explains its postings', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Active', effective: '2025-11-01', expires: '2026-11-01', premium: 6000 }),
        pol({ id: 'ins-a-um', coverage: 'Umbrella', status: 'Expired', expires: '2026-03-15', premium: 1200 }),
      ],
      cube('A', led('2025-01', 21, 500)),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('stale-tracker evidence reports the unexplained residual, not gross postings', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2026-03-19', premium: 600 }),
        pol({ id: 'ins-a-pckg', status: 'Active', effective: '2026-03-15', expires: '2027-03-15', premium: 5000 }),
      ],
      cube('A', { '2026-03': 5000, '2026-04': 600 }),
      toEntity,
    );
    expect(rows.find((x) => x.kind === 'stale-tracker')!.posted).toBe(600);
  });

  it('a renewal paid in advance of the next term is not read as a double payment', () => {
    const ledger = { ...led('2024-01', 33), '2024-10': 7500, '2025-10': 8000, '2026-09': 8500 };
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-10-15', expires: '2026-10-15', premium: 8000 })],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(false);
  });
});

describe('adversarial-review regressions: payment windows', () => {
  it('an annual live Package paid BEFORE the lapse does not silence a renewed-and-unlogged BCL', () => {
    const ledger = { ...led('2025-01', 21), '2026-01': 11_000, '2026-03': 1_200 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Active', effective: '2026-01-20', expires: '2027-01-20', premium: 11_000 }),
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2026-03-19', premium: 1_200 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'stale-tracker')!;
    expect(r.posted).toBe(1_200);
  });

  it('an unrelated live premium paid outside the span does not reduce the reported residual', () => {
    const ledger = { ...led('2025-01', 21), '2026-01': 600, '2026-03': 5_600 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Current', effective: '2026-01-10', expires: '2027-01-10', premium: 600 }),
        pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-03-19', premium: 5_600 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.find((x) => x.kind === 'stale-tracker')!.posted).toBe(5_600);
  });

  it('two renewal-sized postings in the advance window still read as excess', () => {
    const ledger = { ...led('2025-09', 14), '2025-11': 6000, '2026-09': 6000, '2026-10': 6000 };
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-11-15', expires: '2026-11-15', premium: 6000 })],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(true);
  });

  it('a package renewed in advance is not read as a dropped line still being paid', () => {
    const ledger = { ...led('2024-01', 33), '2024-10': 8500, '2025-10': 8000, '2026-09': 8500 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2025-10-20', premium: 600 }),
        pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-11-15', expires: '2026-11-15', premium: 8000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('premium-financed live installments (finance charge) do not trip the installments branch', () => {
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2025-10-05', premium: 600 }),
        pol({ id: 'ins-a-pckg', status: 'Current', effective: '2025-01-01', expires: '2027-01-01', premium: 21_600 }),
      ],
      cube('A', led('2025-01', 21, 1_900)),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });

  it('installment evidence uses a calendar window: a ledger gap does not count old months as recent', () => {
    const ledger = { ...led('2025-01', 6, 500), '2026-07': 500, '2026-08': 500, '2026-09': 0 };
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-06-30', premium: 6000 })],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });
});

describe('adversarial-review regressions: advance renewals and live credits', () => {
  it('a live GL expiring two months after a lapsed Package does not erase the Package renewal lump', () => {
    const ledger = { ...led('2025-01', 22), '2025-09': 7_800, '2025-11': 1_200, '2026-09': 7_500 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Expired', effective: '2025-09-18', expires: '2026-09-18', premium: 7_800 }),
        pol({ id: 'ins-a-gl', coverage: 'General Liability (GL)', status: 'Current', effective: '2025-11-01', expires: '2026-11-01', premium: 1_200 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    // the GL's own next-term payment window is credited once (1,200), so the unexplained remainder is 6,300
    const r = rows.find((x) => x.kind === 'stale-tracker')!;
    expect(r.posted).toBe(6_300);
  });

  it("a live line's advance renewal is not subtracted twice", () => {
    const ledger = { ...led('2025-01', 22), '2025-03': 6000, '2025-10': 3500, '2026-03': 6000, '2026-10': 3500 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Expired', effective: '2025-03-19', expires: '2026-03-19', premium: 6000 }),
        pol({ id: 'ins-a-gl', coverage: 'General Liability (GL)', status: 'Current', effective: '2025-11-01', expires: '2026-11-01', premium: 3500 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(true);
  });

  it('same-month, different-day live expiries are treated as one advance renewal (no false excess)', () => {
    const ledger = { ...led('2026-01', 17), '2026-06': 6300, '2027-05': 6300 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Active', effective: '2026-06-01', expires: '2027-06-01', premium: 5700 }),
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Active', effective: '2026-06-11', expires: '2027-06-11', premium: 600 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'excess-ledger')).toBe(false);
  });

  it("a live premium already posted BEFORE the lapse month is not credited against the lapsed line's renewal", () => {
    const ledger = { ...led('2026-01', 5), '2026-02': 5000, '2026-04': 5000 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Expired', expires: '2026-04-15', premium: 5000 }),
        pol({ id: 'ins-a-gl', coverage: 'General Liability (GL)', status: 'Current', effective: '2026-04-01', expires: '2027-04-01', premium: 5000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(true);
  });
});

describe('refute regressions: advance renewals on staggered terms, monthly payers', () => {
  it('staggered terms switch the advance exclusion off: the same ledger is ok alone, info-for-review beside a later GL', () => {
    const ledger = { ...led('2024-10', 24), '2024-11': 10_000, '2025-06': 1_000, '2025-11': 10_000, '2026-09': 10_000 };
    const pkg = pol({ id: 'ins-a-pckg', status: 'Renewing Soon', effective: '2025-11-01', expires: '2026-11-01', premium: 10_000 });
    const gl = pol({ id: 'ins-a-gl', coverage: 'General Liability', status: 'Current', effective: '2025-06-01', expires: '2027-06-01', premium: 1_000 });
    expect(insuranceLedgerRows([pkg], cube('A', ledger), toEntity).map((r) => r.kind)).toEqual(['ok']);
    const r = insuranceLedgerRows([pkg, gl], cube('A', ledger), toEntity).find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(true);
    expect(r.ledgerT12).toBe(20_000); // nothing excluded
    const [i] = insuranceLedgerInsights([r], () => 'prop-a');
    expect(i!.severity).toBe('info');
    expect(i!.impactAnnualUsd).toBeNull();
  });

  it('a monthly payer keeps its installments in the trailing 12: a 1.5x pattern is flagged', () => {
    // 1,500 a month against a 12,000 premium; the live term ends one month after the ledger.
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', effective: '2025-01-01', expires: '2026-01-01', premium: 12_000 })],
      cube('A', led('2025-01', 12, 1_500)),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.ledgerT12).toBe(18_000);
    expect(r.ratio).toBe(1.5);
    expect(r.staggeredTerms).toBe(false);
    const [i] = insuranceLedgerInsights([r], () => 'prop-a');
    expect(i!.severity).toBe('warning');
    expect(i!.impactAnnualUsd).toBe(6_000);
  });

  it('stale-tracker materiality boundary (EPS-guarded): a residual of exactly 10% of the explained amount is not material', () => {
    // Monthly payer: the live Package explains 1,000 a month; a 100-a-month remainder is exactly 10%.
    const ledger = { ...led('2025-07', 6, 1_000), ...led('2026-01', 3, 1_100) };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-bcl', coverage: 'BCL', status: 'Expired', expires: '2026-01-10', premium: 200 }),
        pol({ id: 'ins-a-pckg', status: 'Current', effective: '2025-07-01', expires: '2027-07-01', premium: 12_000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.some((x) => x.kind === 'stale-tracker')).toBe(false);
  });
});

describe('refute regressions: locale-independent insight order', () => {
  it('insights sort by code point, not by locale collation', () => {
    const row = (entity: string) => ({
      entity, kind: 'excess-ledger' as const, reason: null, evidence: null, lapsedExpires: null, lapsedPremium: null,
      posted: null, postedMonths: [], ledgerT12: 20_000, trackerPremium: 10_000, ratio: 2, excess: 10_000,
      staggeredTerms: false,
    });
    // Code point puts 'Z' (0x5A) before 'a' (0x61); locale collation puts 'a' first.
    const ids = insuranceLedgerInsights([row('a'), row('Z')], (e) => e).map((i) => i.id);
    expect(ids).toEqual(['pf-ins-ledger-excess-Z', 'pf-ins-ledger-excess-a']);
  });
});

describe('refute regressions: mixed monthly and annual lines at one location', () => {
  // A GL paid in installments (500 a month) beside a Package paid once a year.
  const gl = (expires: string) =>
    pol({ id: 'ins-a-gl', coverage: 'General Liability', status: 'Current', effective: '2025-11-15', expires, premium: 6_000 });
  const pkg = pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-11-15', expires: '2026-11-15', premium: 8_000 });

  it('one shared expiry month: the Package lump above the 500 run rate is excluded as an advance renewal', () => {
    const ledger = { ...led('2025-01', 21, 500), '2025-11': 8_500, '2026-09': 8_500 };
    const rows = insuranceLedgerRows([gl('2026-11-15'), pkg], cube('A', ledger), toEntity);
    expect(rows.map((r) => r.kind)).toEqual(['ok']);
  });

  it('one shared expiry month: a duplicate Package payment outside the advance window is a warning with its excess', () => {
    const ledger = { ...led('2025-01', 21, 500), '2025-11': 8_500, '2026-03': 8_500, '2026-09': 8_500 };
    const r = insuranceLedgerRows([gl('2026-11-15'), pkg], cube('A', ledger), toEntity).find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(false);
    expect(r.ledgerT12).toBe(22_000);
    expect(r.trackerPremium).toBe(14_000);
    expect(r.excess).toBe(8_000);
    const [i] = insuranceLedgerInsights([r], () => 'prop-a');
    expect(i!.severity).toBe('warning');
    expect(i!.impactAnnualUsd).toBe(8_000);
  });

  it('the GL installments inside the advance window are never excluded', () => {
    // No Package lump in the window: only installments post there, so the T12 is 12 x 500 + one 8,000 payment.
    const ledger = { ...led('2025-01', 21, 500), '2025-11': 8_500 };
    const rows = insuranceLedgerRows([gl('2026-11-15'), pkg], cube('A', ledger), toEntity);
    expect(rows.map((r) => r.kind)).toEqual(['ok']);
  });

  it('staggered expiries (GL a month before the Package): an early renewal is info for review, not a warning', () => {
    const ledger = { ...led('2025-01', 21, 500), '2025-11': 8_500, '2026-09': 8_500 };
    const r = insuranceLedgerRows([gl('2026-10-01'), pkg], cube('A', ledger), toEntity).find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(true);
    const [i] = insuranceLedgerInsights([r], () => 'prop-a');
    expect(i!.severity).toBe('info');
    expect(i!.impactAnnualUsd).toBeNull();
  });
});

describe('refute regressions (wf_337a17c5-3a2): staggered terms are info for review, never a dollar warning', () => {
  const noDollars = (i: { title: string; detail: string; impactAnnualUsd: number | null }) => {
    expect(i.impactAnnualUsd).toBeNull();
    expect(i.title).not.toMatch(/\$/);
    expect(i.detail).not.toMatch(/\$/);
  };

  it("one policy's on-time current-term payment is not taken as another's advance renewal (duplicate stays visible)", () => {
    // Package paid 2025-11 and again 2026-03 (a duplicate); the GL's own current term is paid on time 2026-09,
    // inside the Package's advance window. The old per-window guard excluded that GL payment as the Package
    // renewal and the duplicate vanished. Now: staggered terms, nothing excluded, info for review.
    const ledger = { ...led('2025-01', 21), '2025-09': 8_000, '2025-11': 8_000, '2026-03': 8_000, '2026-09': 8_000 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Current', effective: '2025-11-15', expires: '2026-11-15', premium: 8_000 }),
        pol({ id: 'ins-a-gl', coverage: 'General Liability', status: 'Current', effective: '2026-09-01', expires: '2027-09-01', premium: 8_000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(true);
    expect(r.ledgerT12).toBe(24_000);
    expect(r.ratio).toBe(1.5);
    const ins = insuranceLedgerInsights(rows, () => 'prop-a');
    expect(ins).toHaveLength(1);
    expect(ins[0]!.severity).toBe('info');
    expect(ins[0]!.title).toMatch(/review/i);
    expect(ins[0]!.title).toMatch(/staggered/i);
    noDollars(ins[0]!);
  });

  it('overlapping advance windows (expiries one month apart) no longer fire a false dollar warning', () => {
    // Both lines renewed early (2026-09 and 2026-10). Greedy per-window filling excluded only one of them and
    // read 1.5x as a warning. Now: staggered terms, info for review, no dollar impact.
    const ledger = { ...led('2025-01', 22), '2025-11': 6_000, '2025-12': 6_000, '2026-09': 6_000, '2026-10': 6_000 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-11-01', expires: '2026-11-01', premium: 6_000 }),
        pol({ id: 'ins-a-gl', coverage: 'General Liability', status: 'Renew Now', effective: '2025-12-01', expires: '2026-12-01', premium: 6_000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(true);
    const ins = insuranceLedgerInsights(rows, () => 'prop-a');
    expect(ins.map((i) => i.severity)).toEqual(['info']);
    noDollars(ins[0]!);
  });

  it('prior round still holds: a single line renewed early is ok', () => {
    const ledger = { ...led('2024-01', 33), '2024-10': 7_500, '2025-10': 8_000, '2026-09': 8_500 };
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-10-15', expires: '2026-10-15', premium: 8_000 })],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.map((r) => r.kind)).toEqual(['ok']);
  });

  it('a genuine duplicate at a single-expiry location is still a warning with its excess', () => {
    const ledger = { ...led('2025-01', 21), '2025-11': 6_000, '2026-03': 6_000, '2026-09': 6_000 };
    const rows = insuranceLedgerRows(
      [pol({ id: 'ins-a-pckg', status: 'Current', effective: '2025-11-15', expires: '2026-11-15', premium: 6_000 })],
      cube('A', ledger),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(false);
    expect(r.ledgerT12).toBe(12_000); // the 2026-09 advance renewal is excluded, the 2026-03 duplicate is not
    expect(r.excess).toBe(6_000);
    const [i] = insuranceLedgerInsights(rows, () => 'prop-a');
    expect(i!.severity).toBe('warning');
    expect(i!.impactAnnualUsd).toBe(6_000);
  });

  it('a $0 live line on another term does not make the location staggered', () => {
    const ledger = { ...led('2024-01', 33), '2024-10': 7_500, '2025-10': 8_000, '2026-09': 8_500 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Renew Now', effective: '2025-10-15', expires: '2026-10-15', premium: 8_000 }),
        pol({ id: 'ins-a-eoi', coverage: 'Evidence of Property Insurance', status: 'Current', expires: '2027-04-01', premium: 0 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    expect(rows.map((r) => r.kind)).toEqual(['ok']);
  });
});

describe('refute round 3 (wf_005b89d6-d5a): an early-logged renewal row is not a staggered term', () => {
  const current = pol({ id: 'ins-a-pckg', status: 'Renewing Soon', effective: '2025-11-15', expires: '2026-11-15', premium: 6_000 });
  const renewal = pol({ id: 'ins-a-pckg-rn', status: 'Bound', effective: '2026-11-15', expires: '2027-11-15', premium: 6_000 });

  it('current row + early-logged renewal row, with a true duplicate: warning with its dollar excess', () => {
    // 2025-11 current term, 2026-03 and 2026-06 duplicates, 2026-09 the advance renewal (excluded).
    // The renewal row is effective after the last ledger month (2026-09), so it adds no term of its own.
    const ledger = { ...led('2025-01', 21), '2025-11': 6_000, '2026-03': 6_000, '2026-06': 6_000, '2026-09': 6_000 };
    const rows = insuranceLedgerRows([current, renewal], cube('A', ledger), toEntity);
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(false);
    expect(r.ledgerT12).toBe(18_000); // 24,000 less the 6,000 advance renewal
    expect(r.trackerPremium).toBe(12_000);
    expect(r.excess).toBe(6_000);
    const [i] = insuranceLedgerInsights(rows, () => 'prop-a');
    expect(i!.severity).toBe('warning');
    expect(i!.impactAnnualUsd).toBe(6_000);
  });

  it('a genuine staggered pair (same family, different terms, both in force) is still info with null impact', () => {
    // Package on a Nov term, Flood on a Mar term; the Package renewed early in 2026-09.
    const ledger = { ...led('2025-01', 21), '2025-11': 8_000, '2026-03': 2_000, '2026-09': 8_000 };
    const rows = insuranceLedgerRows(
      [
        pol({ id: 'ins-a-pckg', status: 'Renewing Soon', effective: '2025-11-15', expires: '2026-11-15', premium: 8_000 }),
        pol({ id: 'ins-a-flood', coverage: 'Flood', status: 'Current', effective: '2026-03-01', expires: '2027-03-01', premium: 2_000 }),
      ],
      cube('A', ledger),
      toEntity,
    );
    const r = rows.find((x) => x.kind === 'excess-ledger')!;
    expect(r.staggeredTerms).toBe(true);
    expect(r.ledgerT12).toBe(18_000); // nothing excluded
    const [i] = insuranceLedgerInsights(rows, () => 'prop-a');
    expect(i!.severity).toBe('info');
    expect(i!.impactAnnualUsd).toBeNull();
  });
});
