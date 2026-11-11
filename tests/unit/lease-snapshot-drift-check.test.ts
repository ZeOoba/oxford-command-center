// tests/unit/lease-snapshot-drift-check.test.ts
//
// Regression cover for the 2026-07-24 re-baseline incident. PR #232 changed lease ids from
// row-position (`banwick-2802-105`) to tenant-identity (`banwick-2802-fully-equipped-...`), so
// EVERY id changed at once. The drift check diffed by id only, so its report read
// "137 removed / 138 new" and said nothing about the five leases whose leaseEnd ACTUALLY moved
// underneath that churn -- two of which had silently gone into holdover on 2026-06-30 while the
// snapshot still showed 8-10 months of remaining term.
//
// computeDrift() pairs id-unmatched leases by BUSINESS key (propertyKey + unit + tenant) so a
// re-key is reported as a re-key, and real value changes surface instead of being buried.
//
// Importing this module must NOT parse the live workbook or exit the test process -- see the
// entrypoint guard at the bottom of the script under test (same pattern as
// scripts/migrate-lease-overlay-ids.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { businessKey, computeDrift, evaluateAnomalyFloor, evaluateReconciliationGate, formatDriftReport, loadPrevious, requireLiveDealsSource, type AnomalyFloorResult, type DriftLeaseView } from '../../scripts/lease-snapshot-drift-check';

/** Asserts refusal and narrows the discriminated union so `.reason` type-checks below. */
function expectRefused(result: AnomalyFloorResult): { refuse: true; reason: string } {
  expect(result.refuse).toBe(true);
  if (!result.refuse) throw new Error('expectRefused: result.refuse was false');
  return result;
}

/** Asserts non-refusal and narrows the discriminated union so `.warning` type-checks below. */
function expectAllowed(result: AnomalyFloorResult): { refuse: false; warning?: string } {
  expect(result.refuse).toBe(false);
  if (result.refuse) throw new Error('expectAllowed: result.refuse was true');
  return result;
}

/** Minimal lease factory -- only the fields computeDrift actually reads. */
function lease(over: Partial<DriftLeaseView> & { id: string }): DriftLeaseView {
  return {
    propertyKey: 'banwick',
    tenantName: 'Some Tenant',
    company: null,
    unit: '2802',
    leaseEnd: '2027-04-30',
    annualRent: 120_000,
    status: 'Active',
    monthsToExpiry: 7,
    ...over,
  };
}

/**
 * The 2026-09-07 rent zero-out (commit 85dfecf, found by the 2026-09-14 financial-code sweep):
 * three RETAINED lease ids went from real rent to annualRent 0 in one scheduled refresh -- two
 * already 'Expired' (a tint shop and a countertop fabricator), one still 'Active' with four months
 * of term left (a consulting tenant). Synthetic names, real shape: the STATUS + rent-to-zero
 * transition is the signal. Nothing was added or removed, so the count floor saw a clean run; no
 * leaseEnd moved, so the date-change bucket saw nothing; and Σannual still tied to the workbook's
 * own Portfolio Total (the workbook itself had zeroed the cells), so the dollar gate passed.
 */
function rentZeroOutIncident(): { previous: DriftLeaseView[]; current: DriftLeaseView[] } {
  const previous = [
    lease({ id: 'zettler-2000-2002-fixture-countertops-llc', unit: '2000-2002', company: 'Fixture Countertops LLC', status: 'Expired', leaseEnd: '2026-07-31', monthsToExpiry: -2, annualRent: 88_888 }),
    lease({ id: 'zettler-2004-fixture-tint-co', unit: '2004', company: 'Fixture Tint Co', status: 'Expired', leaseEnd: '2026-08-31', monthsToExpiry: -1, annualRent: 22_222 }),
    lease({ id: 'information-lane-202-fixture-consulting-group', propertyKey: '29000 Information Lane', unit: '202', company: 'Fixture Consulting Group', status: 'Active', leaseEnd: '2027-01-31', monthsToExpiry: 4, annualRent: 17_654.32 }),
  ];
  const current = previous.map((l) => ({ ...l, annualRent: 0 }));
  return { previous, current };
}

describe('businessKey', () => {
  it('keys on propertyKey + unit + company, normalized for case and whitespace', () => {
    const a = lease({ id: 'x-1', propertyKey: 'Banwick', unit: '2802', company: 'Acme  LLC' });
    const b = lease({ id: 'x-2', propertyKey: '  banwick ', unit: ' 2802', company: 'acme llc' });
    expect(businessKey(a)).toBe(businessKey(b));
  });

  it('falls back to tenantName when company is null', () => {
    const withCompany = lease({ id: 'x-1', company: 'Acme LLC', tenantName: 'Jane Doe' });
    const withoutCompany = lease({ id: 'x-2', company: null, tenantName: 'Acme LLC' });
    expect(businessKey(withCompany)).toBe(businessKey(withoutCompany));
  });

  it('tolerates a null unit (single-tenant buildings carry no unit)', () => {
    expect(businessKey(lease({ id: 'x-1', unit: null, company: 'Acme LLC' }))).not.toBeNull();
  });

  it('distinguishes two different units at the same property', () => {
    const u1 = lease({ id: 'x-1', unit: '2802', company: 'Acme LLC' });
    const u2 = lease({ id: 'x-2', unit: '2804', company: 'Acme LLC' });
    expect(businessKey(u1)).not.toBe(businessKey(u2));
  });

  it('returns null when the tenant component is empty -- an unusable key must never pair', () => {
    expect(businessKey(lease({ id: 'x-1', company: '   ', tenantName: '' }))).toBeNull();
  });
});

describe('computeDrift — re-key detection (the incident case)', () => {
  it('reports a pure re-key as re-keyed, not as one removal plus one addition', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.rekeyed[0]!.previous.id).toBe('banwick-2802-105');
    expect(drift.rekeyed[0]!.current.id).toBe('banwick-2802-acme-llc');
    expect(drift.rekeyed[0]!.leaseEndChanged).toBe(false);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
  });

  it('surfaces a leaseEnd change hidden underneath a re-key -- the holdover that went unnoticed', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Spotless Cleaning', leaseEnd: '2027-04-30' }),
    ];
    const current = [
      lease({ id: 'banwick-2802-spotless-cleaning', company: 'Spotless Cleaning', leaseEnd: '2026-06-30' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.rekeyed[0]!.leaseEndChanged).toBe(true);
    expect(drift.rekeyed[0]!.previous.leaseEnd).toBe('2027-04-30');
    expect(drift.rekeyed[0]!.current.leaseEnd).toBe('2026-06-30');
  });

  it('separates a genuinely new lease from the re-keyed cohort', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'banwick-2804-new-tenant-llc', unit: '2804', company: 'New Tenant LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.genuinelyNew.map((l) => l.id)).toEqual(['banwick-2804-new-tenant-llc']);
    expect(drift.genuinelyRemoved).toHaveLength(0);
  });

  it('separates a genuinely removed lease from the re-keyed cohort', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'banwick-2804-106', unit: '2804', company: 'Departed LLC' }),
    ];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.genuinelyRemoved.map((l) => l.id)).toEqual(['banwick-2804-106']);
    expect(drift.genuinelyNew).toHaveLength(0);
  });
});

describe('computeDrift — ambiguity is never silently paired', () => {
  it('refuses to pair when a business key is duplicated in the CURRENT set', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    // Two current leases collapse to the same business key -- pairing either one would be a guess.
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'banwick-2802-acme-llc-2', company: 'Acme LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
    expect(drift.ambiguous[0]!.currentCount).toBe(2);
    // Falls through to the conservative reading rather than inventing a pairing.
    expect(drift.genuinelyRemoved.map((l) => l.id)).toEqual(['banwick-2802-105']);
    expect(drift.genuinelyNew).toHaveLength(2);
  });

  it('refuses to pair when a business key is duplicated in the PREVIOUS set', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'banwick-2802-106', company: 'Acme LLC' }),
    ];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
    expect(drift.ambiguous[0]!.previousCount).toBe(2);
    expect(drift.genuinelyNew.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('never pairs on an unusable (empty-tenant) business key', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: '', tenantName: '' })];
    const current = [lease({ id: 'banwick-2802-x', company: '', tenantName: '' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(1);
    expect(drift.genuinelyRemoved).toHaveLength(1);
  });
});

describe('computeDrift — existing id-based behavior is preserved', () => {
  it('an id-matched lease is never considered for business-key pairing', () => {
    // Same id on both sides: already matched, must not also appear as a re-key.
    const previous = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC', leaseEnd: '2027-04-30' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC', leaseEnd: '2026-06-30' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
    // Still reported through the pre-existing id-matched date-change path.
    expect(drift.changedDates.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('preserves the raw id-based removedIds/newIds that the anomaly floor is computed from', () => {
    // The >25% removal floor MUST keep seeing the raw id-level removal count. Business-key pairing
    // is a REPORTING layer -- if it silently fed the floor, an id-scheme change would stop tripping
    // it, which is exactly the safety property the floor exists to provide.
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.removedIds.map((l) => l.id)).toEqual(['banwick-2802-105']);
    expect(drift.newIds.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('reports no drift at all when nothing changed', () => {
    const leases = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(leases, leases);

    expect(drift.newIds).toHaveLength(0);
    expect(drift.removedIds).toHaveLength(0);
    expect(drift.changedDates).toHaveLength(0);
    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(0);
    expect(drift.rentChanged).toHaveLength(0);
  });
});

// Regression cover for the 2026-09-07 rent zero-out -- see rentZeroOutIncident() above. Before this
// bucket existed, computeDrift compared ids and leaseEnd only: a retained lease whose annualRent
// went to $0 produced NO line in any report, on any writer path. This is REPORT-only, like the
// leaseEnd-change bucket: a genuine vacancy zeroes rent too, so refusing here would block real edits.
describe('computeDrift — rentChanged (the 2026-09-07 rent zero-out shape)', () => {
  it('reports every retained (id-matched) lease whose rent went to $0, carrying the prior value -- while every other bucket stays empty', () => {
    const { previous, current } = rentZeroOutIncident();

    const drift = computeDrift(previous, current);

    // The blind spot, stated directly: the pre-existing buckets all read this as a clean run.
    expect(drift.removedIds).toHaveLength(0);
    expect(drift.newIds).toHaveLength(0);
    expect(drift.changedDates).toHaveLength(0);
    expect(drift.rekeyed).toHaveLength(0);

    expect(drift.rentChanged).toHaveLength(3);
    expect(drift.rentChanged.map((r) => r.kind)).toEqual(['to-zero', 'to-zero', 'to-zero']);
    const active = drift.rentChanged.find((r) => r.current.status === 'Active')!;
    expect(active.previous.annualRent).toBeCloseTo(17_654.32);
    expect(active.current.annualRent).toBe(0);
    expect(drift.rentChanged.filter((r) => r.current.status === 'Expired')).toHaveLength(2);
  });

  it('also catches a to-$0 move hidden underneath a re-key (business-key paired), not just id-matched leases', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Fixture Consulting Group', annualRent: 17_654.32 })];
    const current = [lease({ id: 'banwick-2802-fixture-consulting-group', company: 'Fixture Consulting Group', annualRent: 0 })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.rentChanged).toHaveLength(1);
    expect(drift.rentChanged[0]!.kind).toBe('to-zero');
    expect(drift.rentChanged[0]!.previous.id).toBe('banwick-2802-105');
    expect(drift.rentChanged[0]!.current.id).toBe('banwick-2802-fixture-consulting-group');
  });

  it('reports a from-$0 move (a vacant suite re-let) as its own kind', () => {
    const previous = [lease({ id: 'id-1', company: 'Acme LLC', status: 'Vacant', annualRent: 0 })];
    const current = [lease({ id: 'id-1', company: 'Acme LLC', status: 'Active', annualRent: 60_000 })];

    const drift = computeDrift(previous, current);

    expect(drift.rentChanged).toHaveLength(1);
    expect(drift.rentChanged[0]!.kind).toBe('from-zero');
  });

  it('ignores a routine escalation but reports a move beyond the 25% materiality threshold', () => {
    // 3% is an ordinary annual bump and must not turn every anniversary into "drift worth a look";
    // a 40% drop on a retained lease is not an escalation and needs a human.
    const previous = [
      lease({ id: 'escalated', company: 'Escalated LLC', annualRent: 100_000 }),
      lease({ id: 'halved', unit: '2804', company: 'Halved LLC', annualRent: 100_000 }),
    ];
    const current = [
      lease({ id: 'escalated', company: 'Escalated LLC', annualRent: 103_000 }),
      lease({ id: 'halved', unit: '2804', company: 'Halved LLC', annualRent: 60_000 }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rentChanged.map((r) => r.current.id)).toEqual(['halved']);
    expect(drift.rentChanged[0]!.kind).toBe('material');
  });

  it('treats exactly 25% as NOT material -- the threshold trips on >25%, matching the anomaly floor', () => {
    const previous = [lease({ id: 'id-1', company: 'Acme LLC', annualRent: 100_000 })];
    const current = [lease({ id: 'id-1', company: 'Acme LLC', annualRent: 125_000 })];

    expect(computeDrift(previous, current).rentChanged).toHaveLength(0);
  });

  it('does not report a $0 -> $0 lease (a suite that stayed vacant is not a change)', () => {
    const leases = [lease({ id: 'id-1', company: 'Acme LLC', status: 'Vacant', annualRent: 0 })];

    expect(computeDrift(leases, leases).rentChanged).toHaveLength(0);
  });
});

describe('computeDrift — full-set uniqueness, not just the unmatched subset', () => {
  it('does not pair when the key is unique among unmatched leases but duplicated in the full set', () => {
    // 'acme llc' at banwick/2802 appears twice in current -- once id-matched, once not. Pairing the
    // unmatched one against the unmatched previous lease would attach the wrong record, so the
    // uniqueness test deliberately counts over the FULL sets rather than the unmatched subset.
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'shared-id', company: 'Acme LLC' }),
    ];
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'shared-id', company: 'Acme LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
  });
});

// evaluateAnomalyFloor was extracted 2026-07-26 so lease-snapshot-drift-check.ts (the protected
// weekday path) and scripts/extract-workbook.ts (the raw regen / manual `npm run extract` path)
// can share ONE tested refusal decision instead of drifting copies -- see the 2026-07-26
// orphaned-task-forensics finding in event_log.md: a manual `npm run extract` run wrote corrupted
// lease dates through extract-workbook.ts, which had no anomaly floor of its own at all. Before
// this extraction, these branches lived inline in main() and had ZERO unit coverage.
describe('evaluateAnomalyFloor — 0-lease refusal', () => {
  it('refuses when the current parse produces zero leases and a previous baseline exists', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];

    const result = expectRefused(evaluateAnomalyFloor(previous, [], [], '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/0 leases/);
    expect(result.reason).toMatch(/previous snapshot had 1/);
  });

  it('refuses a 0-lease parse even on a first run with no previous baseline -- unconditional per Round-3 REFUTE (gating on previous.length > 0 was the original bug)', () => {
    const result = expectRefused(evaluateAnomalyFloor([], [], [], '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/0 leases/);
    expect(result.reason).toMatch(/previous snapshot had 0/);
  });

  it('--force bypasses the 0-lease refusal and returns a warning instead', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];

    const result = expectAllowed(evaluateAnomalyFloor(previous, [], [], '/tmp/portfolio.json', true));

    expect(result.warning).toMatch(/force/);
    expect(result.warning).toMatch(/0-lease/);
    // The 0-lease branch returns before the mass-removal branch ever runs (see the
    // "does not fire the mass-removal check" test below for the refuse:true side of this same
    // guarantee) -- the force-bypass warning must not also carry mass-removal wording.
    expect(result.warning).not.toMatch(/leases removed/);
  });
});

describe('evaluateAnomalyFloor — >25% mass-removal refusal', () => {
  it('does not refuse when removal is at or below the 25% threshold', () => {
    // 1 of 4 removed = exactly 25% -- the floor trips on >25%, not >=25%.
    const previous = [1, 2, 3, 4].map((n) => lease({ id: `id-${n}`, company: `Tenant ${n}` }));
    const current = previous.slice(1); // 3 remain
    const removedIds = [previous[0]!];

    const result = evaluateAnomalyFloor(previous, current, removedIds, '/tmp/portfolio.json', false);

    expect(result.refuse).toBe(false);
  });

  it('refuses when more than 25% of the previous set would be removed', () => {
    // 2 of 4 removed = 50% -- over the threshold.
    const previous = [1, 2, 3, 4].map((n) => lease({ id: `id-${n}`, company: `Tenant ${n}` }));
    const current = previous.slice(2); // 2 remain
    const removedIds = previous.slice(0, 2);

    const result = expectRefused(evaluateAnomalyFloor(previous, current, removedIds, '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/2 \(50\.0%\) would be removed/);
    expect(result.reason).toMatch(/mass disposition/);
  });

  it('--force bypasses the mass-removal refusal and returns a warning instead', () => {
    const previous = [1, 2, 3, 4].map((n) => lease({ id: `id-${n}`, company: `Tenant ${n}` }));
    const current = previous.slice(2);
    const removedIds = previous.slice(0, 2);

    const result = expectAllowed(evaluateAnomalyFloor(previous, current, removedIds, '/tmp/portfolio.json', true));

    expect(result.warning).toMatch(/2\/4/);
    expect(result.warning).toMatch(/50\.0%/);
  });

  it('is a no-op when there is no previous baseline (first run)', () => {
    const current = [lease({ id: 'id-1', company: 'Tenant 1' })];

    const result = evaluateAnomalyFloor([], current, [], '/tmp/portfolio.json', false);

    expect(result.refuse).toBe(false);
  });

  it('does not fire the mass-removal check when the 0-lease check already covers this parse', () => {
    // Regression guard: the two checks must not double-fire or interact -- 0 current leases is
    // handled entirely by the 0-lease branch, and this branch must not also run against it.
    const previous = [1, 2].map((n) => lease({ id: `id-${n}`, company: `Tenant ${n}` }));

    const result = expectRefused(evaluateAnomalyFloor(previous, [], previous, '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/0 leases/);
    expect(result.reason).not.toMatch(/mass disposition/);
  });
});

// Regression cover for the 2026-08-03 phantom-lease incident (PR #250). The anomaly floor above
// is COUNT-based (0-lease / >25%-removed) and would NOT have caught that defect -- the corrupt
// parse added 10 leases (well under the 25% removal threshold; nothing was removed at all) while
// inflating annual rent by a six-figure amount. `server/reconcile-runtime.ts`'s checkSnapshot() already ties
// parsed lease annualRent to the workbook's own Portfolio Total cell (captured into
// snapshot.workbookTotals.rent by parse.ts) and would have caught this exactly -- it simply was
// never called from either CLI writer, only from server/brain.ts's live-server refresh path. This
// gate closes that gap: same "Refusing to write <path>: ..." + --force framing as
// evaluateAnomalyFloor above, so a genuinely intentional discrepancy (e.g. a hand-verified
// workbook error) is still overridable, but a silent divergence between parsed and workbook totals
// never reaches disk unattended again.
describe('evaluateReconciliationGate — dollar-exact reconciliation, closes the anomaly floor\'s blind spot', () => {
  const cleanSnapshot = (over: Partial<Record<string, unknown>> = {}): PortfolioSnapshot =>
    ({
      properties: [{ id: 'p1', noi: 100, oxfordValue: 1000, sf: 5000 }],
      leases: [{ id: 'l1', annualRent: 1200, monthlyRent: 100 }],
      loans: [],
      deals: [],
      insurance: [],
      cash: { totalCash: 500, entities: [{ id: 'e1', currentBalance: 500 }], history: [{ total: 500 }] },
      counterparties: [],
      dataQuality: [],
      workbookTotals: { noi: 100, value: 1000, rent: 1200 },
      ...over,
    }) as unknown as PortfolioSnapshot;

  it('does not refuse a snapshot that reconciles to the workbook totals', () => {
    const result = evaluateReconciliationGate(cleanSnapshot(), '/tmp/portfolio.json', false);
    expect(result.refuse).toBe(false);
  });

  it('refuses when parsed annual rent diverges from the workbook\'s own Portfolio Total -- the phantom-lease shape', () => {
    // Mirrors the live incident: workbookTotals.rent is the correct figure; leases sums to more
    // because of rows that should never have parsed as tenancies.
    const corrupt = cleanSnapshot({
      leases: [
        { id: 'l1', annualRent: 1200, monthlyRent: 100 },
        { id: 'phantom-1', annualRent: 21_600, monthlyRent: 1_800 }, // a vacancy-block SF value read as rent
      ],
    });

    const result = expectRefused(evaluateReconciliationGate(corrupt, '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/Refusing to write \/tmp\/portfolio\.json/);
    expect(result.reason).toMatch(/leases\.annualRent/);
    expect(result.reason).toMatch(/portfolio\.json was NOT modified/);
  });

  it('--force bypasses the refusal and returns a warning instead, same as the anomaly floor', () => {
    const corrupt = cleanSnapshot({
      leases: [
        { id: 'l1', annualRent: 1200, monthlyRent: 100 },
        { id: 'phantom-1', annualRent: 21_600, monthlyRent: 1_800 },
      ],
    });

    const result = expectAllowed(evaluateReconciliationGate(corrupt, '/tmp/portfolio.json', true));

    expect(result.warning).toMatch(/--force/);
    expect(result.warning).toMatch(/leases\.annualRent/);
  });

  it('does NOT refuse on a warn-severity-only flag (e.g. Σannual ≠ Σmonthly×12) -- error severity is the gate, not "any flag"', () => {
    // checkSnapshot flags this at 'warn', not 'error' (see reconcile-runtime.ts) -- deliberately not
    // a refusal reason, so this test proves the gate filters by severity rather than firing on any
    // flag at all, which would make it far too trigger-happy for routine self-consistency notices.
    const warnOnly = cleanSnapshot({
      leases: [{ id: 'l1', annualRent: 1300, monthlyRent: 100 }], // annualRent != monthly*12, but workbookTotals.rent matches leases sum
      workbookTotals: { noi: 100, value: 1000, rent: 1300 },
    });

    const result = evaluateReconciliationGate(warnOnly, '/tmp/portfolio.json', false);

    expect(result.refuse).toBe(false);
  });

  it('also refuses on a pre-existing error-severity flag already in snapshot.dataQuality -- not just flags checkSnapshot itself computes', () => {
    // checkSnapshot() only recomputes its own 6 categories (cash/rent/workbook-totals/empty-sets/
    // dup-ids/dangling-edges); it never reads snapshot.dataQuality as an input. If a future parse.ts
    // change ever raises its own 'error'-severity flag (today every parse.ts flag is 'warn' -- see
    // that file's flags.push() call sites), a gate that only inspected checkSnapshot()'s OWN output
    // would silently ignore it. "Refuse on any error-severity flag" means the union of both sources.
    const preExistingError = cleanSnapshot({
      dataQuality: [{ entity: 'rent-roll-row-99', field: 'propertyKey', issue: 'simulated future parse-time error', severity: 'error' }],
    });

    const result = expectRefused(evaluateReconciliationGate(preExistingError, '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/rent-roll-row-99/);
  });

  it('is a no-op when the snapshot carries no workbookTotals (legacy fixture / no such workbook row)', () => {
    const noTotals = cleanSnapshot({ workbookTotals: { noi: null, value: null, rent: null } });

    const result = evaluateReconciliationGate(noTotals, '/tmp/portfolio.json', false);

    expect(result.refuse).toBe(false);
  });

  it('reports every error-severity flag, not just the first, when more than one check fails', () => {
    // Cash total mismatch (error) AND rent mismatch (error) simultaneously -- both must appear so
    // an operator sees the full picture in one refusal message, not one problem at a time.
    const doublyWrong = cleanSnapshot({
      cash: { totalCash: 999, entities: [{ id: 'e1', currentBalance: 500 }], history: [{ total: 999 }] },
      leases: [
        { id: 'l1', annualRent: 1200, monthlyRent: 100 },
        { id: 'phantom-1', annualRent: 21_600, monthlyRent: 1_800 },
      ],
    });

    const result = expectRefused(evaluateReconciliationGate(doublyWrong, '/tmp/portfolio.json', false));

    expect(result.reason).toMatch(/cash\.totalCash/);
    expect(result.reason).toMatch(/leases\.annualRent/);
    expect(result.reason).toMatch(/2 error-severity flag/);
  });
});

// loadPrevious() is where the corrupt-previous-snapshot refusal actually lives -- it had zero
// direct coverage before 2026-07-26 (only its downstream effect, via evaluateAnomalyFloor's
// unrelated checks, was ever exercised). `path` is overridable specifically so this is testable
// against a real temp file instead of the live SNAPSHOT_PATH.
describe('loadPrevious', () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-previous-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a normal first-run state (no file yet) as NOT corrupt', () => {
    const result = loadPrevious(join(dir, 'does-not-exist.json'));

    expect(result.corrupt).toBe(false);
    expect(result.leases).toEqual([]);
  });

  it('reports a valid snapshot as not corrupt and returns its leases', () => {
    const path = join(dir, 'valid.json');
    writeFileSync(path, JSON.stringify({ leases: [{ id: 'x-1', propertyKey: 'banwick', tenantName: 'T', company: null, unit: null, leaseEnd: null, annualRent: 0 }] }));

    const result = loadPrevious(path);

    expect(result.corrupt).toBe(false);
    expect(result.leases).toHaveLength(1);
    expect(result.leases[0]!.id).toBe('x-1');
  });

  it('reports syntactically invalid JSON as corrupt', () => {
    const path = join(dir, 'malformed.json');
    writeFileSync(path, '{ this is not valid json');

    const result = loadPrevious(path);

    expect(result.corrupt).toBe(true);
    expect(result.leases).toEqual([]);
  });

  it('reports valid JSON with a missing/wrong-shaped "leases" field as corrupt', () => {
    const path = join(dir, 'wrong-shape.json');
    writeFileSync(path, JSON.stringify({ notLeases: [] }));

    const result = loadPrevious(path);

    expect(result.corrupt).toBe(true);
    expect(result.leases).toEqual([]);
  });

  it('reports valid JSON whose "leases" field is not an array as corrupt', () => {
    const path = join(dir, 'leases-not-array.json');
    writeFileSync(path, JSON.stringify({ leases: 'oops' }));

    const result = loadPrevious(path);

    expect(result.corrupt).toBe(true);
  });
});

// formatDriftReport is the function that actually would have caught the 2026-07-25 incident
// (Tenant 141 LLC / Example Construction leaseEnd corruption) -- evaluateAnomalyFloor
// is count-based and stays silent when nothing is added or removed, only changed. This is the
// regression cover for THAT gap specifically, not a restatement of computeDrift's own tests above.
describe('formatDriftReport', () => {
  it('reports hasDrift: false and a BASELINE line (not a false "all new" drift dump) when there is no previous snapshot', () => {
    // 2026-07-26 REFUTE finding: without this guard, computeDrift([], current) puts every current
    // lease in genuinelyNew, so a first run (or any run after the snapshot file is deleted) reported
    // "drift" and exited 2, dumping the whole portfolio as "new leases". A bootstrap is not drift.
    const current = [
      lease({ id: 'id-1', company: 'Acme LLC' }),
      lease({ id: 'id-2', company: 'Other Tenant LLC', unit: '2804' }),
    ];
    const drift = computeDrift([], current);

    const report = formatDriftReport(drift, [], current);

    expect(report.hasDrift).toBe(false);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatch(/Baseline established \(2 leases\)/);
    expect(report.lines[0]).not.toMatch(/drift/i);
  });

  it('reports hasDrift: false and a clean-run line when nothing changed', () => {
    const leases = [lease({ id: 'id-1', company: 'Acme LLC' })];
    const drift = computeDrift(leases, leases);

    const report = formatDriftReport(drift, leases, leases);

    expect(report.hasDrift).toBe(false);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatch(/No lease drift/);
  });

  it('reports hasDrift: true and surfaces the exact leaseEnd change for an id-matched lease -- the 2026-07-25 incident shape', () => {
    // The incident: a tenant's id is unchanged (never added/removed -- computeDrift.removedIds and
    // .newIds both stay empty), only leaseEnd corrupts underneath it. evaluateAnomalyFloor alone
    // would see this as a completely clean run. This is the one place that must not.
    const previous = [lease({ id: 'zettler-2000-2002-granite-tops', company: 'Tenant 141 LLC', leaseEnd: '2026-05-31' })];
    const current = [lease({ id: 'zettler-2000-2002-granite-tops', company: 'Tenant 141 LLC', leaseEnd: '2026-07-31' })];
    const drift = computeDrift(previous, current);

    // Confirm the incident's actual blind spot directly, not just by inference from empty arrays:
    // the anomaly floor itself, given this exact drift, allows the write through silently.
    const floor = expectAllowed(evaluateAnomalyFloor(previous, current, drift.removedIds, '/tmp/portfolio.json', false));
    expect(floor.warning).toBeUndefined();

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    const dateLine = report.lines.find((l) => l.includes('Tenant 141 LLC'));
    expect(dateLine).toBeDefined();
    expect(dateLine).toMatch(/2026-05-31 -> 2026-07-31/);
  });

  it('surfaces a leaseEnd change hidden underneath a re-key, not just id-matched changes', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Spotless Cleaning', leaseEnd: '2027-04-30' })];
    const current = [lease({ id: 'banwick-2802-spotless-cleaning', company: 'Spotless Cleaning', leaseEnd: '2026-06-30' })];
    const drift = computeDrift(previous, current);

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    const rekeyLine = report.lines.find((l) => l.includes('2027-04-30 -> 2026-06-30'));
    expect(rekeyLine).toBeDefined();
  });

  it('lists genuinely new and genuinely removed leases separately from re-keyed ones', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'banwick-2804-106', unit: '2804', company: 'Departed LLC' }),
    ];
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'banwick-2806-new-tenant', unit: '2806', company: 'New Tenant LLC' }),
    ];
    const drift = computeDrift(previous, current);

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    expect(report.lines.some((l) => l.includes('Genuinely new leases (1)'))).toBe(true);
    expect(report.lines.some((l) => l.includes('New Tenant LLC'))).toBe(true);
    expect(report.lines.some((l) => l.includes('Genuinely removed leases (1)'))).toBe(true);
    expect(report.lines.some((l) => l.includes('Departed LLC'))).toBe(true);
  });

  it('does not report a lease as changed when its leaseEnd is identical (no false positive)', () => {
    const previous = [lease({ id: 'id-1', company: 'Acme LLC', leaseEnd: '2027-01-01' })];
    const current = [lease({ id: 'id-1', company: 'Acme LLC', leaseEnd: '2027-01-01' })];
    const drift = computeDrift(previous, current);

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(false);
  });

  it('surfaces each zeroed-rent retained lease with its status, vacancy context and prior -> current rent -- the 2026-09-07 incident shape; reports, never refuses', () => {
    const { previous, current } = rentZeroOutIncident();
    const drift = computeDrift(previous, current);

    // The blind spot, confirmed directly rather than by inference: the count floor lets this
    // write through with no warning at all.
    const floor = expectAllowed(evaluateAnomalyFloor(previous, current, drift.removedIds, '/tmp/portfolio.json', false));
    expect(floor.warning).toBeUndefined();

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    expect(report.lines.some((l) => /Rent changes on retained leases \(3\)/.test(l))).toBe(true);

    // The one that matters most: still Active, four months of term left, rent now $0. A reader
    // must see the status and the term context on the same line as the dollar move.
    const activeLine = report.lines.find((l) => l.includes('Fixture Consulting Group'));
    expect(activeLine).toBeDefined();
    expect(activeLine).toMatch(/Active/);
    expect(activeLine).toMatch(/2027-01-31/);
    expect(activeLine).toMatch(/4 mo/);
    expect(activeLine).toMatch(/\$17,654 -> \$0/);

    // The Expired pair are plausibly correct zero-outs (a vacated suite) -- still listed, with the
    // status that explains them, so the reader judges rather than the script.
    const expiredLine = report.lines.find((l) => l.includes('Fixture Countertops LLC'));
    expect(expiredLine).toMatch(/Expired/);
    expect(expiredLine).toMatch(/\$88,888 -> \$0/);
  });

  it('shows the id change alongside a rent change that was paired across a re-key', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Fixture Consulting Group', annualRent: 17_654.32 })];
    const current = [lease({ id: 'banwick-2802-fixture-consulting-group', company: 'Fixture Consulting Group', annualRent: 0 })];
    const drift = computeDrift(previous, current);

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    expect(report.lines.some((l) => /\$17,654 -> \$0/.test(l))).toBe(true);
    expect(report.lines.some((l) => l.includes('banwick-2802-105 -> banwick-2802-fixture-consulting-group'))).toBe(true);
  });

  it('a rent change alone (no id or date change) is still drift worth a look, not a clean run', () => {
    const previous = [lease({ id: 'id-1', company: 'Acme LLC', annualRent: 100_000 })];
    const current = [lease({ id: 'id-1', company: 'Acme LLC', annualRent: 0 })];
    const drift = computeDrift(previous, current);

    const report = formatDriftReport(drift, previous, current);

    expect(report.hasDrift).toBe(true);
    expect(report.lines[0]).toMatch(/Lease drift detected/);
  });
});

/**
 * 2026-08-09: the token-less half of the seed-fallback regression. loadDeals()/parse.ts raise an
 * error flag only when a token IS configured and the fetch fails; a MISSING token degrades to the
 * seed set just as destructively (deals ~20 → ~6) but is a supported dev-server mode, so the
 * writers -- not the shared source adapter -- have to refuse it.
 */
describe('requireLiveDealsSource', () => {
  const original = process.env.NOTION_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = original;
  });

  it('refuses to write when NOTION_TOKEN is unset, naming the wipe it prevents', () => {
    delete process.env.NOTION_TOKEN;
    const r = requireLiveDealsSource('/tmp/portfolio.json', false);
    expect(r.refuse).toBe(true);
    if (r.refuse) {
      expect(r.reason).toContain('NOTION_TOKEN is not set');
      expect(r.reason).toContain('was NOT modified');
    }
  });

  it('allows the write when NOTION_TOKEN is set', () => {
    process.env.NOTION_TOKEN = 't';
    expect(requireLiveDealsSource('/tmp/portfolio.json', false).refuse).toBe(false);
  });

  it('--force downgrades the refusal to a warning rather than silently proceeding', () => {
    delete process.env.NOTION_TOKEN;
    const r = requireLiveDealsSource('/tmp/portfolio.json', true);
    expect(r.refuse).toBe(false);
    if (!r.refuse) expect(r.warning).toContain('seed placeholder set');
  });
});
