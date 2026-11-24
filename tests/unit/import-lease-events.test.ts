// @vitest-environment node
//
// scripts/import-lease-events.ts: snapshot -> capture parsing, the tenancy-chain derivation and each
// false-event guard, the replace-derived importer (idempotency, retraction, no-shrink, unknown
// property, per-row isolation), the cutover proof (leasingVelocity reads a vacate->commence gap), and
// parseArgs. The "refute" blocks reproduce the triggers from refute runs wf_0e8573e6-c57 (round 1)
// and wf_d7dfc6cb-dc6 (round 2) wf_12470799-a63 (round 3) and wf_4d9846fe-f7c (round 4) against the real leasingVelocity. Synthetic tenants only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { leasingVelocity } from '../../server/warehouse/lease-velocity';
import {
  archiveName,
  CaptureSetShrankError,
  captureFromSnapshot,
  deriveLeaseEvents,
  importLeaseEvents,
  normaliseTenant,
  parseArgs,
  replaceDerivedLeaseEvents,
} from '../../scripts/import-lease-events';
import type { Capture, LeaseEventRow } from '../../scripts/import-lease-events';

const opened: WarehouseDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function freshDb(ids: string[] = ['prop-a']): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'import-lease-events-')), 'w.sqlite'));
  opened.push(db);
  for (const id of ids) {
    db.prepare(`INSERT INTO property_master (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
      VALUES (?, ?, 'Alpha Metro', 'pnl', 10000, '2020-01-01', 1, 'active')`).run(id, id);
  }
  return db;
}

type L = { propertyId?: string; unit?: string | null; tenantName?: string; leaseStart?: string | null; leaseEnd?: string | null; status?: string };
function snap(asOf: string, leases: L[], generatedAt = `${asOf}T12:00:00.000Z`) {
  return {
    meta: { asOf, generatedAt },
    leases: leases.map((l) => ({ propertyId: 'prop-a', unit: 'A', tenantName: 'Acme Widgets', leaseStart: '2024-01-01', leaseEnd: '2027-12-31', status: 'Active', ...l })),
  };
}
function cap(asOf: string, leases: L[], label = asOf, generatedAt?: string): Capture {
  const r = captureFromSnapshot(snap(asOf, leases, generatedAt), label);
  if ('error' in r) throw new Error(r.error);
  return r.capture;
}
const vacates = (rows: LeaseEventRow[]) => rows.filter((r) => r.eventKind === 'vacate');
const commences = (rows: LeaseEventRow[]) => rows.filter((r) => r.eventKind === 'commence');
const STAY: L = { unit: 'Z', tenantName: 'Stay Co' };
const velocity = (db: WarehouseDb) => leasingVelocity(db, [{ id: 'prop-a', name: 'Prop A' }]).find((v) => v.propertyId === 'prop-a');
/** Import `caps` into a fresh warehouse and return prop-a's velocity row. */
const velocityOf = (caps: Capture[]) => { const db = freshDb(); importLeaseEvents(db, caps); return velocity(db); };

describe('captureFromSnapshot', () => {
  it('rejects a payload without an ISO meta.asOf or a leases array', () => {
    expect(captureFromSnapshot({ meta: { asOf: '10/01/2026' }, leases: [] }, 'x')).toEqual({ error: expect.stringMatching(/meta.asOf/) });
    expect(captureFromSnapshot({ meta: { asOf: '2026-10-01' } }, 'x')).toEqual({ error: expect.stringMatching(/no leases/) });
    expect(captureFromSnapshot(null, 'x')).toEqual({ error: expect.stringMatching(/not a JSON object/) });
  });

  it('drops Vacant lines and leases with no propertyId; blanks a non-ISO leaseStart; normalises suite', () => {
    const c = cap('2026-10-01', [
      { unit: ' suite  100 ' },
      { status: 'Vacant', tenantName: 'VACANT' },
      { propertyId: '' },
      { unit: null, leaseStart: '01/05/2024' },
    ]);
    expect(c.leases).toHaveLength(2);
    expect(c.leases.map((l) => [l.suiteKey, l.leaseStart])).toEqual([['', null], ['SUITE 100', '2024-01-01']]);
  });

  it('orders leases by a total key, so file order never reaches the derivation', () => {
    const p: L = { tenantName: 'P Co', leaseStart: '2024-05-01' };
    const q: L = { tenantName: 'Q Co', leaseStart: '2024-05-01' };
    const one = deriveLeaseEvents([cap('2026-09-01', [p, q]), cap('2026-10-01', [p, q])]);
    const two = deriveLeaseEvents([cap('2026-09-01', [q, p]), cap('2026-10-01', [q, p])]);
    expect(one.rows).toEqual(two.rows);
  });

  it('normalises tenant names; archive names carry the snapshot stem', () => {
    expect(normaliseTenant('Acme Widgets, LLC')).toBe(normaliseTenant('ACME WIDGETS'));
    expect(archiveName(cap('2026-10-01', [], 'x', '2026-10-02T03:04:05.000Z'))).toBe('portfolio_2026-10-01_20261002T030405000Z.json');
  });
});

describe('deriveLeaseEvents', () => {
  it('one commence per confirmed tenancy, dated leaseStart; future commencements are not events yet', () => {
    const future: L = { unit: 'C', tenantName: 'Future Co', leaseStart: '2026-12-01' };
    const { rows, notes } = deriveLeaseEvents([cap('2026-09-01', [{}, future]), cap('2026-10-01', [{}, future])]);
    expect(commences(rows)).toEqual([expect.objectContaining({ suite: 'A', eventDate: '2024-01-01', basis: 'lease_start', abstractDate: '2026-09-01' })]);
    expect(notes.filter((n) => n.kind === 'future-commence')).toHaveLength(1);
  });

  it('a tenancy seen once is held in the newest capture and dropped as a phantom elsewhere', () => {
    const { rows, notes } = deriveLeaseEvents([
      cap('2026-08-01', [STAY]), cap('2026-09-01', [STAY, { tenantName: 'Typo Co' }]), cap('2026-10-01', [STAY]),
      cap('2026-11-01', [STAY, { unit: 'B', tenantName: 'Brand New' }]),
    ]);
    expect(rows.filter((r) => r.tenant !== 'Stay Co')).toEqual([]);
    expect(notes.map((n) => n.kind)).toEqual(expect.arrayContaining(['phantom-tenancy', 'commence-unconfirmed']));
  });

  it('a tenancy first seen in the earliest capture counts as confirmed (history starts there)', () => {
    const { rows } = deriveLeaseEvents([cap('2026-08-01', [{ leaseEnd: '2026-08-20' }, STAY]), cap('2026-09-01', [STAY]), cap('2026-10-01', [STAY])]);
    // A month-wide window: the lease end is not used (round 6), the vacate is the first absence.
    expect(vacates(rows)).toEqual([expect.objectContaining({ suite: 'A', eventDate: '2026-09-01', basis: 'first_absent' })]);
  });

  it('vacate dated leaseEnd when it falls inside a tight window between the last sighting and the first absence', () => {
    const { rows } = deriveLeaseEvents([
      cap('2026-09-03', [{ leaseEnd: '2026-09-15' }, STAY]), cap('2026-09-10', [{ leaseEnd: '2026-09-15' }, STAY]),
      cap('2026-09-17', [STAY]), cap('2026-09-24', [STAY]),
    ]);
    expect(vacates(rows)).toEqual([expect.objectContaining({ suite: 'A', tenant: 'Acme Widgets', eventDate: '2026-09-15', basis: 'lease_end' })]);
    expect(vacates(rows)[0]!.sourceFile).toBe('rent-roll-diff 2026-09-10 -> 2026-09-17 [DERIVED:lease_end]');
  });

  it('a window wider than LEASE_END_WINDOW_DAYS dates the vacate at the first absence', () => {
    const { rows } = deriveLeaseEvents([
      cap('2026-08-01', [{ leaseEnd: '2026-09-15' }, STAY]), cap('2026-09-01', [{ leaseEnd: '2026-09-15' }, STAY]),
      cap('2026-10-01', [STAY]), cap('2026-11-01', [STAY]),
    ]);
    expect(vacates(rows)).toEqual([expect.objectContaining({ eventDate: '2026-10-01', basis: 'first_absent' })]);
  });

  it('vacate dated at the first absent capture for a holdover or an early termination with no successor', () => {
    for (const leaseEnd of ['2026-06-30', '2028-06-30']) {
      const { rows } = deriveLeaseEvents([
        cap('2026-08-01', [{ leaseEnd }, STAY]), cap('2026-09-01', [{ leaseEnd }, STAY]), cap('2026-10-01', [STAY]), cap('2026-11-01', [STAY]),
      ]);
      expect(vacates(rows)[0]).toMatchObject({ eventDate: '2026-10-01', basis: 'first_absent' });
    }
  });

  it('a vacate seen only in the newest capture holding the property is held', () => {
    const { rows, notes } = deriveLeaseEvents([cap('2026-08-01', [{}, STAY]), cap('2026-09-01', [{}, STAY]), cap('2026-10-01', [STAY])]);
    expect(vacates(rows)).toEqual([]);
    expect(notes.some((n) => n.kind === 'vacate-unconfirmed')).toBe(true);
  });

  it('no vacate and no second commence for a tenant rename, a suite relabel or a renewal', () => {
    const series = (later: L) => [cap('2026-08-01', [{}]), cap('2026-09-01', [{}]), cap('2026-10-01', [later]), cap('2026-11-01', [later])];
    for (const later of [{ tenantName: 'Acme Widgets Holdings' }, { unit: 'A-1' }, { leaseStart: '2026-09-15' }]) {
      const { rows } = deriveLeaseEvents(series(later));
      expect(vacates(rows)).toEqual([]);
      expect(commences(rows)).toHaveLength(1); // only the original 2024-01-01 start
    }
  });

  it('a lease that drops out for a capture and comes back is the same tenancy', () => {
    const { rows } = deriveLeaseEvents([cap('2026-08-01', [{}, STAY]), cap('2026-09-01', [STAY]), cap('2026-10-01', [{}, STAY]), cap('2026-11-01', [{}, STAY])]);
    expect(vacates(rows)).toEqual([]);
    expect(commences(rows).filter((r) => r.suite === 'A')).toHaveLength(1);
  });

  it('no vacate when the whole property disappears from every later capture', () => {
    const other: L = { propertyId: 'prop-b', tenantName: 'Other' };
    const { rows, notes } = deriveLeaseEvents([cap('2026-08-01', [{}, other]), cap('2026-09-01', [{}, other]), cap('2026-10-01', [other]), cap('2026-11-01', [other])]);
    expect(vacates(rows)).toEqual([]);
    expect(notes.some((n) => n.kind === 'property-gone' && n.propertyId === 'prop-a')).toBe(true);
  });

  it('leaves one collapsed capture out; two in a row fail the run', () => {
    const four: L[] = ['A', 'B', 'C', 'D'].map((u) => ({ unit: u, tenantName: `T${u}` }));
    const { rows, notes } = deriveLeaseEvents([cap('2026-08-01', four), cap('2026-09-01', [four[0]!]), cap('2026-10-01', four), cap('2026-11-01', four)]);
    expect(vacates(rows)).toEqual([]);
    expect(notes.some((n) => n.kind === 'capture-defective')).toBe(true);
    expect(() => deriveLeaseEvents([cap('2026-08-01', four), cap('2026-09-01', [four[0]!]), cap('2026-10-01', [four[1]!])]))
      .toThrow(/two consecutive captures collapsed/);
  });

  it('same-asOf captures resolve by generatedAt, then label, never by input order', () => {
    const stale = cap('2026-09-01', [{}, STAY], 'old', '2026-09-01T08:00:00Z');
    const fresh = cap('2026-09-01', [STAY], 'new', '2026-09-01T20:00:00Z');
    const tieA = cap('2026-09-01', [{}, STAY], 'a', '2026-09-01T08:00:00Z');
    const tieB = cap('2026-09-01', [STAY], 'b', '2026-09-01T08:00:00Z');
    const rest = [cap('2026-08-01', [{}, STAY]), cap('2026-10-01', [STAY]), cap('2026-11-01', [STAY])];
    for (const [x, y, keptLabel] of [[stale, fresh, 'new'], [tieA, tieB, 'b']] as const) {
      const one = deriveLeaseEvents([x, y, ...rest]);
      const two = deriveLeaseEvents([...rest, y, x]);
      expect(one.rows).toEqual(two.rows);
      expect(one.notes.find((n) => n.kind === 'capture-duplicate')!.detail).toMatch(new RegExp(`superseded by ${keptLabel} `));
    }
  });

  it('skips no-unit leases of a property with two concurrent no-unit leases, and says so', () => {
    const one: L = { unit: null, tenantName: 'One' };
    const two: L = { unit: null, tenantName: 'Two' };
    const { rows, notes } = deriveLeaseEvents([cap('2026-08-01', [one, two]), cap('2026-09-01', [one, two]), cap('2026-10-01', [two]), cap('2026-11-01', [two])]);
    expect(rows).toEqual([]);
    expect(notes).toContainEqual(expect.objectContaining({ kind: 'ambiguous-suite', propertyId: 'prop-a' }));
  });
});

describe('refute round 1 (wf_0e8573e6-c57) triggers', () => {
  it('turnover with a holdover pairs with the successor, not with the successor\'s renewal a year out', () => {
    const v = velocityOf([
      cap('2026-07-01', [{ tenantName: 'Alpha', leaseStart: '2019-01-01', leaseEnd: '2026-06-30' }, STAY]),
      cap('2026-08-01', [{ tenantName: 'Alpha', leaseStart: '2019-01-01', leaseEnd: '2026-06-30' }, STAY]),
      cap('2026-10-01', [{ tenantName: 'Beta', leaseStart: '2026-09-01', leaseEnd: '2027-08-31' }, STAY]),
      cap('2027-10-01', [{ tenantName: 'Beta', leaseStart: '2027-09-01', leaseEnd: '2030-08-31' }, STAY]),
    ])!;
    expect(v.leasingEventsN).toBe(1);
    // Alpha was still listed 08-01, past its 06-30 lease end, with no successor beside it: a holdover
    // whose departure falls in (08-01, 10-01]. Round 1 asserted 63 days (backdated to 06-30); round 3
    // (wf_12470799-a63 H2) showed that raises a false slow flag. The vacate is bounded above by Beta's
    // 09-01 start, so the gap understates, never overstates.
    expect(v.medianDaysToLease).toBe(0);
    expect(v.slowLeasing).toBe(false);
  });

  it('a blip in the newest capture never becomes a permanent vacate across runs', () => {
    const db = freshDb();
    const alpha: L = { tenantName: 'Alpha', leaseStart: '2022-01-01' };
    const h0 = cap('2026-07-25', [alpha, STAY]);
    const h = cap('2026-08-01', [alpha, STAY]);
    const blip = cap('2026-08-08', [STAY]);
    const after = cap('2026-08-10', [STAY]); // the blip looks confirmed in this run
    const back = cap('2026-08-15', [alpha, STAY]);
    const renewed = cap('2027-02-01', [{ tenantName: 'Alpha', leaseStart: '2027-01-01' }, STAY]);
    importLeaseEvents(db, [h0, h, blip, after]);
    importLeaseEvents(db, [h0, h, blip, after, back]);
    importLeaseEvents(db, [h0, h, blip, after, back, renewed]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lease_events WHERE event_kind = 'vacate'").get()).toEqual({ n: 0 });
    expect(velocity(db)!.medianDaysToLease).toBeNull();
  });

  it('the table depends on the capture set, not on the order runs happened in', () => {
    const a0 = cap('2026-07-01', [{ leaseEnd: '2026-06-30' }, STAY]);
    const a = cap('2026-08-01', [{ leaseEnd: '2026-06-30' }, STAY]);
    const mid = cap('2026-09-01', [STAY]);
    const c = cap('2026-10-01', [STAY]);
    const d = cap('2026-11-01', [STAY]);
    const incremental = freshDb();
    importLeaseEvents(incremental, [a0, a, c, d]);
    importLeaseEvents(incremental, [a0, a, mid, c, d]);
    const oneShot = freshDb();
    importLeaseEvents(oneShot, [a0, a, mid, c, d]);
    const dump = (db: WarehouseDb) => db.prepare('SELECT property_id, suite, tenant, event_kind, event_date, source_file, abstract_date FROM lease_events ORDER BY event_kind, event_date').all();
    expect(dump(incremental)).toEqual(dump(oneShot));
    expect(incremental.prepare("SELECT event_date FROM lease_events WHERE event_kind = 'vacate'").all()).toEqual([{ event_date: '2026-09-01' }]);
  });
});

describe('refute round 2 (wf_d7dfc6cb-dc6) triggers', () => {
  const A: L = { tenantName: 'Alpha', leaseStart: '2022-01-01', leaseEnd: '2027-12-31' };

  it('S6: late-entered successor plus a renewal blip no longer yields a 351-day slow pair', () => {
    const B1: L = { tenantName: 'Bravo', leaseStart: '2025-03-01', leaseEnd: '2026-02-28' };
    const B2: L = { tenantName: 'Bravo', leaseStart: '2026-03-01', leaseEnd: '2029-02-28' };
    const v = velocityOf([
      cap('2025-01-15', [A, STAY]), cap('2025-02-15', [A, STAY]), cap('2025-03-15', [STAY]), cap('2025-04-15', [B1, STAY]),
      cap('2026-02-15', [B1, STAY]), cap('2026-03-15', [STAY]), cap('2026-04-15', [B2, STAY]), cap('2026-05-15', [B2, STAY]),
    ])!;
    expect(v.leasingEventsN).toBe(1);
    expect(v.medianDaysToLease).toBe(0); // Alpha left between 02-15 and 03-15; Bravo started 03-01
    expect(v.slowLeasing).toBe(false);
  });

  it('S4: a renewal row that reappears after a missing capture emits no commence', () => {
    const renewed: L = { ...A, leaseStart: '2026-03-01' };
    const { rows } = deriveLeaseEvents([cap('2026-01-15', [A, STAY]), cap('2026-02-15', [A, STAY]), cap('2026-03-15', [STAY]), cap('2026-04-15', [renewed, STAY]), cap('2026-05-15', [renewed, STAY])]);
    expect(commences(rows).filter((r) => r.suite === 'A').map((r) => r.eventDate)).toEqual(['2022-01-01']);
    expect(vacates(rows)).toEqual([]);
  });

  it('S1: a successor first entered two captures later still pairs (the vacate never sorts after it)', () => {
    const v = velocityOf([
      cap('2025-01-15', [A, STAY]), cap('2025-02-15', [A, STAY]), cap('2025-03-15', [STAY]),
      cap('2025-04-15', [{ tenantName: 'Bravo', leaseStart: '2025-03-01' }, STAY]), cap('2025-05-15', [{ tenantName: 'Bravo', leaseStart: '2025-03-01' }, STAY]),
    ])!;
    expect(v).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0 });
  });

  it('S2/T2: a stale line beside a started successor dates the vacate at the successor start, never the expired lease end (round 5)', () => {
    const old: L = { tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2025-03-31' };
    const next: L = { tenantName: 'Bravo', leaseStart: '2025-04-01', leaseEnd: '2030-03-31' };
    const v = velocityOf([cap('2025-02-15', [old, next, STAY]), cap('2025-04-15', [old, next, STAY]), cap('2025-05-15', [next, STAY]), cap('2025-06-15', [next, STAY])])!;
    // The lease_end backdate (1 day) is gone: every vacate date is an upper bound, so this reads 0 (understates).
    expect(v).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0 });
  });

  it('T4: a turnover inside one wide capture window no longer depends on where a capture lands (round 6)', () => {
    const old: L = { tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2024-06-30' };
    const next: L = { tenantName: 'Bravo', leaseStart: '2024-11-01' };
    const v = velocityOf([cap('2024-06-10', [old, STAY]), cap('2024-06-25', [old, STAY]), cap('2024-12-10', [next, STAY]), cap('2025-01-10', [next, STAY])])!;
    // The 06-25 -> 12-10 window is too wide to trust the 06-30 lease end (an unseen holdover fits in it).
    expect(v).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0, slowLeasing: false });
    // With weekly captures around the lease end the dark period is measured.
    const tight = velocityOf([cap('2024-06-18', [old, STAY]), cap('2024-06-25', [old, STAY]), cap('2024-07-02', [STAY]), cap('2024-11-05', [next, STAY]), cap('2024-11-12', [next, STAY])])!;
    expect(tight).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 124, slowLeasing: true }); // 06-30 -> 11-01
    // Listed again 07-10, past its lease end, it is a holdover (round 3 H2): the 06-30 end is no longer
    // evidence of the vacate date, so the gap is bounded by the successor's start, never backdated.
    const held = velocityOf([cap('2024-06-10', [old, STAY]), cap('2024-07-10', [old, STAY]), cap('2024-12-10', [next, STAY]), cap('2025-01-10', [next, STAY])])!;
    expect(held).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0, slowLeasing: false });
  });

  it('T3: a capture missing one property neither drops its vacates nor turns a renewal into a commence', () => {
    const C1: L = { unit: 'C', tenantName: 'Charlie', leaseStart: '2023-01-01' };
    const C2: L = { ...C1, leaseStart: '2025-03-01' };
    const gone: L = { tenantName: 'Alpha', leaseStart: '2022-01-01', leaseEnd: '2025-01-31' };
    const other: L = { propertyId: 'prop-b', tenantName: 'Other' };
    const { rows } = deriveLeaseEvents([
      cap('2024-12-01', [gone, C1, other]), cap('2025-01-01', [gone, C1, other]), cap('2025-02-01', [other]),
      cap('2025-04-01', [C2, other]), cap('2025-05-01', [C2, other]),
    ]);
    // prop-a is absent from the 02-01 capture, so the first capture holding it (hi) is 04-01.
    expect(vacates(rows)).toEqual([expect.objectContaining({ suite: 'A', eventDate: '2025-04-01', basis: 'first_absent' })]);
    expect(commences(rows).filter((r) => r.suite === 'C').map((r) => r.eventDate)).toEqual(['2023-01-01']);
  });

  it('a one-capture phantom tenancy cannot pair with a real vacate', () => {
    const v = velocityOf([
      cap('2025-01-31', [A, STAY]), cap('2025-02-15', [A, STAY]), cap('2025-02-28', [STAY]),
      cap('2025-08-31', [STAY]), cap('2025-09-30', [{ tenantName: 'Typo Tenant', leaseStart: '2025-03-01' }, STAY]), cap('2025-10-31', [STAY]),
    ])!;
    expect(v.leasingEventsN).toBe(0);
  });

  it('known limit: a renewal under a new entity name and new start reads as an instant re-let, never as slow', () => {
    const renamed: L = { tenantName: 'Acme Widget Holdings', leaseStart: '2028-01-01', leaseEnd: '2032-12-31' };
    const v = velocityOf([
      cap('2027-11-01', [{}, STAY]), cap('2027-12-01', [{}, STAY]), cap('2028-01-15', [renamed, STAY]), cap('2028-02-15', [renamed, STAY]),
    ])!;
    expect(v.medianDaysToLease).toBeLessThanOrEqual(1);
    expect(v.slowLeasing).toBe(false);
  });
});

describe('refute round 3 (wf_12470799-a63) triggers', () => {
  const twoSuites = (lines: Array<'A' | 'B'>): L[] => lines.map((unit) => ({ unit, tenantName: 'Multi Co', leaseStart: '2023-01-01', leaseEnd: '2028-12-31' }));

  it('H1: a multi-suite tenant missing one line for a capture links by match strength, so nothing vacates', () => {
    const caps = [
      cap('2025-01-15', [...twoSuites(['A', 'B']), STAY]), cap('2025-02-15', [...twoSuites(['B']), STAY]),
      cap('2025-03-15', [...twoSuites(['A', 'B']), STAY]), cap('2025-04-15', [...twoSuites(['A', 'B']), STAY]),
    ];
    const { rows } = deriveLeaseEvents(caps);
    expect(vacates(rows)).toEqual([]);
    expect(commences(rows).map((r) => r.suite).sort()).toEqual(['A', 'B', 'Z']);
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 0, slowLeasing: false });
  });

  it('H1: giving back one suite vacates that suite, whatever the suite labels sort to', () => {
    const { rows } = deriveLeaseEvents([
      cap('2025-01-15', [...twoSuites(['A', 'B']), STAY]), cap('2025-02-15', [...twoSuites(['A', 'B']), STAY]),
      cap('2025-03-15', [...twoSuites(['B']), STAY]), cap('2025-04-15', [...twoSuites(['B']), STAY]),
    ]);
    expect(vacates(rows)).toEqual([expect.objectContaining({ suite: 'A', eventDate: '2025-03-15', basis: 'first_absent' })]);
  });

  it('H2: a month-to-month holdover listed past its lease end is not backdated to the expired end', () => {
    const old: L = { tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2025-03-31' };
    const next: L = { tenantName: 'Bravo', leaseStart: '2025-08-01' };
    const caps = [
      cap('2025-03-15', [old, STAY]), cap('2025-04-15', [old, STAY]), cap('2025-05-15', [old, STAY]), cap('2025-06-15', [old, STAY]),
      cap('2025-07-15', [STAY]), cap('2025-08-15', [next, STAY]), cap('2025-09-15', [next, STAY]),
    ];
    expect(vacates(deriveLeaseEvents(caps).rows)).toEqual([expect.objectContaining({ eventDate: '2025-07-15', basis: 'first_absent' })]);
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 17, slowLeasing: false });
  });

  it('H3: a "Vacant" placeholder line with status Unknown (blank Status) is not a tenancy; other statuses keep it, as in parse.ts', () => {
    const c = cap('2026-10-01', [
      { unit: 'C', tenantName: 'VACANT', status: 'Unknown' },
      { unit: 'D', tenantName: 'Vacant - former Delta', status: 'Expired' },
      { unit: 'E', tenantName: 'Vacant Lot Storage LLC', status: 'Active' },
    ]);
    expect(c.leases.map((l) => l.suiteKey)).toEqual(['D', 'E']);
    expect(c.presentProperties).toEqual(['prop-a']); // placeholders still count as the property being on the rent roll
  });
});

describe('refute round 4 (wf_4d9846fe-f7c) triggers', () => {
  it('P1: a holdover beside a successor listed before its start is not backdated to the expired lease end', () => {
    const alpha: L = { tenantName: 'Alpha', leaseStart: '2019-01-01', leaseEnd: '2024-01-31', status: 'Expired' };
    const bravo: L = { tenantName: 'Bravo', leaseStart: '2024-05-01' };
    const caps = [
      cap('2024-01-15', [alpha, STAY]), cap('2024-02-15', [alpha, STAY]), cap('2024-03-15', [alpha, bravo, STAY]),
      cap('2024-04-15', [alpha, bravo, STAY]), cap('2024-05-15', [bravo, STAY]), cap('2024-06-15', [bravo, STAY]),
    ];
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0, slowLeasing: false });
  });

  it('a renewal row listed beside the current row is a renewal: no vacate, no second commence', () => {
    const cur: L = { tenantName: 'Alpha', leaseStart: '2019-01-01', leaseEnd: '2024-06-30' };
    const ren: L = { tenantName: 'Alpha', leaseStart: '2024-07-01', leaseEnd: '2029-06-30' };
    const ren2: L = { tenantName: 'Alpha', leaseStart: '2029-07-01' };
    const caps = [
      cap('2024-02-15', [cur, STAY]), cap('2024-03-15', [cur, ren, STAY]), cap('2024-04-15', [cur, ren, STAY]),
      cap('2024-08-15', [ren, STAY]), cap('2024-09-15', [ren, STAY]), cap('2029-03-15', [ren, ren2, STAY]),
      cap('2029-04-15', [ren, ren2, STAY]), cap('2029-08-15', [ren2, STAY]), cap('2029-09-15', [ren2, STAY]),
    ];
    const { rows } = deriveLeaseEvents(caps);
    expect(vacates(rows)).toEqual([]);
    expect(commences(rows).filter((r) => r.suite === 'A').map((r) => r.eventDate)).toEqual(['2019-01-01']);
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 0, slowLeasing: false });
  });

  it('a single-suite property that goes fully vacant (placeholder line) keeps its dark period', () => {
    const x: L = { propertyId: 'prop-a', tenantName: 'Xco', leaseStart: '2024-01-01', leaseEnd: '2025-12-31' };
    const ph: L = { propertyId: 'prop-a', tenantName: 'VACANT', status: 'Unknown', leaseStart: null, leaseEnd: null };
    const y: L = { propertyId: 'prop-a', tenantName: 'Yco', leaseStart: '2026-06-01' };
    const q: L = { propertyId: 'prop-q', tenantName: 'Filler' };
    const caps = [
      cap('2026-01-05', [x, q]), cap('2026-01-12', [x, q]), cap('2026-01-19', [ph, q]), cap('2026-03-16', [ph, q]),
      cap('2026-05-11', [ph, q]), cap('2026-06-08', [y, q]), cap('2026-06-15', [y, q]),
    ];
    expect(vacates(deriveLeaseEvents(caps).rows)).toEqual([expect.objectContaining({ propertyId: 'prop-a', eventDate: '2026-01-19', basis: 'first_absent' })]);
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 133, slowLeasing: true });
  });

  it('a stale-line backdate never dates a vacate after an earlier successor start', () => {
    const t: L = { tenantName: 'Tango', leaseStart: '2019-01-01', leaseEnd: '2024-03-31' };
    const u: L = { tenantName: 'Uniform', leaseStart: '2024-04-01' };
    const v: L = { tenantName: 'Victor', leaseStart: '2024-02-01' };
    const { rows } = deriveLeaseEvents([
      cap('2024-01-01', [t, STAY]), cap('2024-03-01', [t, u, STAY]), cap('2024-05-01', [t, u, STAY]),
      cap('2024-07-01', [u, v, STAY]), cap('2024-09-01', [u, v, STAY]),
    ]);
    const tv = vacates(rows).find((r) => r.tenant === 'Tango')!;
    const firstSuccessor = commences(rows).filter((r) => r.suite === 'A' && r.tenant !== 'Tango').map((r) => r.eventDate).sort()[0]!;
    expect(tv.eventDate <= firstSuccessor).toBe(true);
  });

  it('derivation sorts leases inside a hand-built capture, so array order never decides', () => {
    const a = cap('2026-09-01', [{ tenantName: 'P Co', leaseStart: '2024-05-01' }, { tenantName: 'Q Co', leaseStart: '2024-05-01' }]);
    const b = cap('2026-10-01', [{ tenantName: 'P Co', leaseStart: '2024-05-01' }, { tenantName: 'Q Co', leaseStart: '2024-05-01' }]);
    const rev = (c: Capture): Capture => ({ ...c, leases: [...c.leases].reverse() });
    expect(deriveLeaseEvents([rev(a), rev(b)]).rows).toEqual(deriveLeaseEvents([a, b]).rows);
  });
});

describe('refute round 5 (wf_2a1ff182-4c1) triggers', () => {
  it('a multi-capture holdover whose started successor is listed one capture before it drops is never backdated', () => {
    const xray: L = { tenantName: 'Xray', leaseStart: '2017-01-01', leaseEnd: '2021-12-31', status: 'Expired' };
    const yankee: L = { tenantName: 'Yankee', leaseStart: '2022-12-15' };
    const caps = [
      cap('2022-09-01', [xray, STAY]), cap('2022-10-01', [xray, STAY]), cap('2022-11-01', [xray, STAY]),
      cap('2022-12-01', [xray, STAY]), cap('2023-01-01', [xray, yankee, STAY]), cap('2023-02-01', [yankee, STAY]),
      cap('2023-03-01', [yankee, STAY]),
    ];
    const xv = vacates(deriveLeaseEvents(caps).rows).find((r) => r.tenant === 'Xray')!;
    expect(xv).toMatchObject({ eventDate: '2022-12-15', basis: 'successor_start' });
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0, slowLeasing: false });
  });

  it('no vacate is ever dated before the last sighting except by a successor start', () => {
    const t: L = { tenantName: 'Tango', leaseStart: '2019-01-01', leaseEnd: '2023-06-30' };
    const u: L = { tenantName: 'Uniform', leaseStart: '2024-01-01' };
    const caps = [
      cap('2023-05-01', [t, STAY]), cap('2023-09-01', [t, STAY]), cap('2023-11-01', [t, STAY]),
      cap('2024-02-01', [u, STAY]), cap('2024-03-01', [u, STAY]),
    ];
    for (const v of vacates(deriveLeaseEvents(caps).rows)) {
      if (v.basis !== 'successor_start') expect(v.eventDate > '2023-11-01').toBe(true);
    }
  });
});

describe('refute round 6 (wf_24523df2-4fd) triggers', () => {
  it('HIGH: a successor listed with a blank start commences no later than its first sighting', () => {
    const alpha: L = { unit: '100', tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2025-12-31' };
    const gamma: L = { unit: '200', tenantName: 'Gamma' };
    const beta0: L = { unit: '100', tenantName: 'Beta', leaseStart: null, leaseEnd: null };
    const beta1: L = { unit: '100', tenantName: 'Beta', leaseStart: '2026-09-01', leaseEnd: '2031-08-31' };
    const caps = [
      cap('2025-11-01', [alpha, gamma]), cap('2025-12-15', [alpha, gamma]), cap('2026-01-15', [beta0, gamma]),
      cap('2026-03-01', [beta0, gamma]), cap('2026-06-01', [beta0, gamma]), cap('2026-09-15', [beta1, gamma]),
      cap('2026-10-15', [beta1, gamma]),
    ];
    const c = commences(deriveLeaseEvents(caps).rows).find((r) => r.tenant === 'Beta')!;
    expect(c).toMatchObject({ eventDate: '2026-01-15', basis: 'first_seen' });
    const v = velocityOf(caps)!;
    expect(v.slowLeasing).toBe(false);
    expect(v.medianDaysToLease!).toBeLessThanOrEqual(15);
  });

  it('MEDIUM: a lease end inside a wide capture window is not used; the vacate is bounded by the window and the successor', () => {
    const old: L = { tenantName: 'Old Tenant', leaseStart: '2020-01-01', leaseEnd: '2025-02-01' };
    const nu: L = { tenantName: 'New Tenant', leaseStart: '2025-04-28' };
    const caps = [cap('2025-01-18', [old, STAY]), cap('2025-01-25', [old, STAY]), cap('2025-05-03', [nu, STAY]), cap('2025-05-10', [nu, STAY])];
    const v = vacates(deriveLeaseEvents(caps).rows).find((r) => r.tenant === 'Old Tenant')!;
    expect(v.basis).not.toBe('lease_end');
    expect(velocityOf(caps)).toMatchObject({ leasingEventsN: 1, medianDaysToLease: 0, slowLeasing: false });
  });

  it('a lease end inside a tight (<= 14 day) window is still used', () => {
    const old: L = { tenantName: 'Old Tenant', leaseStart: '2020-01-01', leaseEnd: '2025-01-31' };
    const nu: L = { tenantName: 'New Tenant', leaseStart: '2025-04-01' };
    const caps = [cap('2025-01-25', [old, STAY]), cap('2025-02-01', [STAY]), cap('2025-04-15', [nu, STAY]), cap('2025-04-22', [nu, STAY])];
    expect(vacates(deriveLeaseEvents(caps).rows)).toEqual([expect.objectContaining({ eventDate: '2025-01-31', basis: 'lease_end' })]);
  });

  it('MEDIUM: a replacement listed beside the departing tenant clamps its vacate, so no orphan vacate pairs with a later commence', () => {
    const alpha: L = { tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2027-12-31' };
    const beta: L = { tenantName: 'Beta', leaseStart: '2026-03-15', leaseEnd: '2029-12-31' };
    const gamma: L = { tenantName: 'Gamma', leaseStart: '2026-10-01' };
    const caps = [
      cap('2026-01-01', [alpha, STAY]), cap('2026-03-01', [alpha, beta, STAY]), cap('2026-05-01', [beta, STAY]),
      cap('2026-07-01', [beta, STAY]), cap('2026-10-01', [beta, gamma, STAY]), cap('2026-11-01', [gamma, STAY]),
    ];
    const rows = deriveLeaseEvents(caps).rows;
    const av = vacates(rows).find((r) => r.tenant === 'Alpha')!;
    const bc = commences(rows).find((r) => r.tenant === 'Beta')!;
    expect(av.eventDate <= bc.eventDate).toBe(true);
    const v = velocityOf(caps)!;
    expect(v.slowLeasing).toBe(false);
    // Same with Beta staying through the newest capture and Gamma a second occupant.
    const caps2 = [
      cap('2026-01-01', [alpha, STAY]), cap('2026-03-01', [alpha, beta, STAY]), cap('2026-05-01', [beta, STAY]),
      cap('2026-07-01', [beta, STAY]), cap('2026-10-01', [beta, gamma, STAY]), cap('2026-11-01', [beta, gamma, STAY]),
    ];
    expect(velocityOf(caps2)!.slowLeasing).toBe(false);
  });
});

describe('refute round 7 (wf_02d58977-4bc) triggers', () => {
  const X: L = { unit: '200', tenantName: 'Xstay' };
  const Y: L = { unit: '300', tenantName: 'Ystay' };

  it("HIGH: a short-stay co-tenant that left earlier never backdates a long-tenured tenant's vacate", () => {
    const a: L = { unit: '100', tenantName: 'Alpha', leaseStart: '2020-01-01', leaseEnd: '2026-05-31' };
    const b: L = { unit: '100', tenantName: 'Bravo', leaseStart: '2022-01-15', leaseEnd: '2023-01-31' };
    const d: L = { unit: '100', tenantName: 'Delta', leaseStart: '2026-07-15' };
    const caps = [
      cap('2021-12-01', [a, X, Y]), cap('2022-02-01', [a, b, X, Y]), cap('2022-06-01', [a, b, X, Y]),
      cap('2023-03-01', [a, X, Y]), cap('2023-06-01', [a, X, Y]), cap('2026-07-01', [X, Y]),
      cap('2026-09-01', [d, X, Y]), cap('2026-10-01', [d, X, Y]),
    ];
    const av = vacates(deriveLeaseEvents(caps).rows).find((r) => r.tenant === 'Alpha')!;
    expect(av.eventDate >= '2023-06-01').toBe(true);
    expect(velocityOf(caps)!.slowLeasing).toBe(false);
  });

  it('MEDIUM: a tenancy that never emits a commence (future or blank start) listed beside the departing tenant does not clamp its vacate', () => {
    const xray: L = { tenantName: 'Xray Co', leaseStart: '2020-01-01', leaseEnd: '2030-12-31' };
    const wex: L = { tenantName: 'Wex Co', leaseStart: '2026-07-01' };
    for (const zedStart of ['2027-06-01', null]) {
      const zed: L = { tenantName: 'Zed Co', leaseStart: zedStart };
      const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
      const caps = months.map((m) => {
        const n = Number(m);
        const ls: L[] = [STAY];
        if (n <= 5) ls.push(xray);
        if (n >= 3) ls.push(zed);
        if (n >= 7) ls.push(wex);
        return cap(`2026-${m}-01`, ls);
      });
      const v = velocityOf(caps)!;
      expect(v.medianDaysToLease!).toBeLessThanOrEqual(61);
    }
  });

  it("a departing tenancy with no start (first seen in the earliest capture) is never backdated to an earlier co-tenant's start", () => {
    const old: L = { tenantName: 'Oldco', leaseStart: null, leaseEnd: null };
    const co: L = { tenantName: 'Coco', leaseStart: '2015-01-01' };
    const caps = [
      cap('2026-01-01', [old, co, STAY]), cap('2026-02-01', [old, co, STAY]), cap('2026-03-01', [co, STAY]), cap('2026-04-01', [co, STAY]),
    ];
    const ov = vacates(deriveLeaseEvents(caps).rows).find((r) => r.tenant === 'Oldco');
    if (ov) expect(ov.eventDate > '2026-02-01').toBe(true);
  });
});

describe('replaceDerivedLeaseEvents', () => {
  const history = () => [
    cap('2026-07-01', [{ leaseEnd: '2026-08-20' }, STAY]),
    cap('2026-08-01', [{ leaseEnd: '2026-08-20' }, STAY]),
    cap('2026-09-01', [STAY]),
    cap('2026-10-01', [STAY, { tenantName: 'New Tenant', leaseStart: '2026-09-29' }]),
    cap('2026-11-01', [STAY, { tenantName: 'New Tenant', leaseStart: '2026-09-29' }]),
  ];

  it('cutover: leasingVelocity reads the vacate->commence gap', () => {
    const db = freshDb();
    const res = importLeaseEvents(db, history());
    expect(res.added).toBe(res.derived);
    expect(velocity(db)).toMatchObject({ medianDaysToLease: 28, leasingEventsN: 1 }); // 09-01 (first absent) -> 09-29
  });

  it('a re-run adds and removes nothing; non-derived rows are never touched', () => {
    const db = freshDb();
    db.prepare("INSERT INTO lease_events (property_id, suite, tenant, event_kind, event_date, source_file) VALUES ('prop-a', 'Q', 'Hand', 'commence', '2020-01-01', 'abstract:lease.pdf')").run();
    const first = importLeaseEvents(db, history());
    expect(importLeaseEvents(db, history())).toMatchObject({ added: 0, removed: 0, unchanged: first.derived, rejected: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lease_events WHERE source_file = 'abstract:lease.pdf'").get()).toEqual({ n: 1 });
  });

  it('refuses a capture set that lacks days already derived from, unless allowShrink', () => {
    const db = freshDb();
    importLeaseEvents(db, history());
    const before = db.prepare('SELECT COUNT(*) AS n FROM lease_events').get();
    expect(() => importLeaseEvents(db, history().slice(2))).toThrow(CaptureSetShrankError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lease_events').get()).toEqual(before); // nothing written
    expect(importLeaseEvents(db, history().slice(2), { allowShrink: true }).removed).toBeGreaterThan(0);
  });

  it('skips a property missing from property_master and logs one DQ row, once across runs', () => {
    const db = freshDb([]);
    importLeaseEvents(db, history());
    const res = importLeaseEvents(db, history());
    expect(res.added).toBe(0);
    expect(res.rejected).toBe(res.derived);
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'lease-event-unknown-property'").get()).toEqual({ n: 1 });
  });

  it('isolates a DB constraint failure to its own row', () => {
    const db = freshDb();
    const good = deriveLeaseEvents(history()).rows;
    const bad = { ...good[0]!, eventKind: 'moved' as unknown as 'vacate' };
    const res = replaceDerivedLeaseEvents(db, [bad, ...good]);
    expect(res.rejected).toBe(1);
    expect(res.added).toBe(good.length);
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'lease-event-check-violation'").get()).toEqual({ n: 1 });
  });

  it('writes an ambiguous-suite DQ row once across runs', () => {
    const db = freshDb();
    const one: L = { unit: null, tenantName: 'One' };
    const two: L = { unit: null, tenantName: 'Two' };
    const caps = [cap('2026-09-01', [one, two]), cap('2026-10-01', [two])];
    importLeaseEvents(db, caps);
    importLeaseEvents(db, caps);
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'lease-event-ambiguous-suite'").get()).toEqual({ n: 1 });
  });
});

describe('parseArgs', () => {
  it('defaults to the live snapshot path; collects repeatable --snapshot', () => {
    expect(parseArgs([]).snapshots).toEqual([join('data', 'snapshots', 'portfolio.json')]);
    expect(parseArgs(['--snapshot', 'a.json', '--snapshot', 'b.json', '--db', 'w.sqlite', '--repo', '.', '--archive', 'h', '--allow-shrink']))
      .toMatchObject({ snapshots: ['a.json', 'b.json'], db: 'w.sqlite', repo: '.', archive: 'h', allowShrink: true });
  });

  it.each([
    [['--snapshot'], /missing value/],
    [['--archive'], /missing value/],
    [['--dry-run', '--db', 'x'], /mutually exclusive/],
    [['--dry-run', '--allow-shrink'], /mutually exclusive/],
    [['--git-history'], /unknown argument/],
  ])('rejects %j', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrow(msg);
  });
});
