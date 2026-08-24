// tests/unit/insurance-conditions.test.ts
//
// TDD tests for server/warehouse/insurance-conditions.ts.
// Uses an in-memory SQLite (opened via openWarehouse in a tmpdir) to mirror
// the warehouse-db.test.ts pattern. No mocking — real schema, real reads.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { insuranceConditions, insuranceWarehouseDriftConditions, isMoreCurrentRow } from '../../server/warehouse/insurance-conditions';
import type { CollapsibleInsuranceRow } from '../../server/warehouse/insurance-analysis';
import type { PortfolioSnapshot } from '../../src/contracts/index';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tmpDb(): { db: WarehouseDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ins-cond-'));
  const db = openWarehouse(join(dir, 'finance.sqlite'));
  return { db, dir };
}

/** Add days to an ISO date string and return ISO date string. */
function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const AS_OF = '2026-06-20';

/** Minimal PortfolioSnapshot for insurance-conditions tests. */
function makeSnap(propertyIds: string[]): PortfolioSnapshot {
  return {
    meta: {
      schemaVersion: '1.0.0',
      asOf: AS_OF,
      generatedAt: `${AS_OF}T00:00:00Z`,
      source: 'test',
      scenario: 'Base',
    },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: AS_OF,
    },
    properties: propertyIds.map((id) => ({
      id,
      name: `Property ${id}`,
      // Minimum required Property fields — others are omitted via `as unknown`
    })),
    leases: [],
    loans: [],
    deals: [],
    insurance: [],
    tasks: [],
    counterparties: [],
    dataQuality: [],
    cash: {
      asOf: AS_OF,
      totalCash: 0,
      activeEntities: 0,
      largestEntity: null,
      concentrationTopPct: null,
      cagr: null,
      entities: [],
      history: [],
    },
  } as unknown as PortfolioSnapshot;
}

function insertPolicy(
  db: WarehouseDb,
  opts: {
    propertyId: string;
    expirationDate: string | null;
    premiumAnnual: number | null;
    insurer?: string;
    policyType?: string;
    policyNumber?: string;
    effectiveDate?: string | null;
    sourceDate?: string;
  },
): void {
  db.prepare(`
    INSERT INTO property_insurance_policies
      (property_id, insurer, policy_number, effective_date, expiration_date,
       premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.propertyId,
    opts.insurer ?? 'Test Insurer',
    opts.policyNumber ?? `POL-${opts.propertyId}`,
    opts.effectiveDate === undefined ? addDays(AS_OF, -365) : opts.effectiveDate,
    opts.expirationDate,
    opts.premiumAnnual,
    null,
    opts.policyType ?? 'general-liability',
    'test',
    opts.sourceDate ?? AS_OF,
    'test',
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('insuranceConditions', () => {
  let db: WarehouseDb;
  let dbDir: string;

  beforeEach(() => {
    const tmp = tmpDb();
    db = tmp.db;
    dbDir = tmp.dir;
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── (a) expiry-soon basic ────────────────────────────────────────────────

  it('(a) emits a critical expiry insight for a policy expiring in 45 days', () => {
    const snap = makeSnap(['prop-alpha']);
    insertPolicy(db, {
      propertyId: 'prop-alpha',
      expirationDate: addDays(AS_OF, 45),
      premiumAnnual: 8000,
    });

    const insights = insuranceConditions(db, snap);

    expect(insights).toHaveLength(1);
    const ins = insights[0]!;
    expect(ins.id).toMatch(/^ins-expiry-prop-alpha/);
    expect(ins.severity).toBe('critical');
    expect(ins.category).toBe('insurance');
    expect(ins.impactAnnualUsd).toBe(8000);
    expect(ins.spine).toBe('B');
    expect(ins.provenance).toBe('real');
    expect(ins.entityType).toBe('insurance');
    expect(ins.entityId).toBe('prop-alpha');
  });

  // ── (b) boundary: 75d → no fire; 60d → fires ────────────────────────────

  it('(b) does NOT fire for a policy expiring in 75 days (>60d)', () => {
    const snap = makeSnap(['prop-beta']);
    insertPolicy(db, {
      propertyId: 'prop-beta',
      expirationDate: addDays(AS_OF, 75),
      premiumAnnual: 5000,
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(0);
  });

  it('(b) DOES fire for a policy expiring in exactly 60 days (<=60d inclusive)', () => {
    // BOUNDARY DECISION: the threshold is daysToExpiry <= 60 (inclusive on 60).
    // A policy with exactly 60 days remaining triggers a critical alert.
    const snap = makeSnap(['prop-gamma']);
    insertPolicy(db, {
      propertyId: 'prop-gamma',
      expirationDate: addDays(AS_OF, 60),
      premiumAnnual: 12000,
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.severity).toBe('critical');
  });

  // ── (c) premium unknown → insight fires, impactAnnualUsd null ────────────

  it('(c) fires with impactAnnualUsd null when premium_annual is NULL', () => {
    // PROVENANCE CHOICE: provenance='real' even when premium is unknown.
    // The expiry DATE itself is a hard fact from the table (real source data).
    // The premium being absent does not demote the date provenance — it is
    // expressed instead as impactAnnualUsd: null.
    const snap = makeSnap(['prop-delta']);
    insertPolicy(db, {
      propertyId: 'prop-delta',
      expirationDate: addDays(AS_OF, 30),
      premiumAnnual: null,
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.impactAnnualUsd).toBeNull();
    expect(expiry[0]!.provenance).toBe('real');
  });

  // ── (d) gap: property with no policy row ────────────────────────────────

  it('(d) emits a warning gap insight for a property with no matching policy row', () => {
    const snap = makeSnap(['prop-has-policy', 'prop-no-policy']);
    insertPolicy(db, {
      propertyId: 'prop-has-policy',
      expirationDate: addDays(AS_OF, 90), // >60d — no expiry alert
      premiumAnnual: 5000,
    });
    // prop-no-policy has no row at all

    const insights = insuranceConditions(db, snap);

    const gaps = insights.filter((i) => i.id.startsWith('ins-gap-'));
    expect(gaps).toHaveLength(1);
    const gap = gaps[0]!;
    expect(gap.id).toMatch(/^ins-gap-prop-no-policy/);
    expect(gap.severity).toBe('warning');
    expect(gap.category).toBe('insurance');
    expect(gap.impactAnnualUsd).toBeNull();
    expect(gap.spine).toBe('B');
    expect(gap.provenance).toBe('absent');
    expect(gap.entityType).toBe('property');
    expect(gap.entityId).toBe('prop-no-policy');
  });

  it('(d) does NOT emit a gap insight for a property that has a policy row', () => {
    const snap = makeSnap(['prop-covered']);
    insertPolicy(db, {
      propertyId: 'prop-covered',
      expirationDate: addDays(AS_OF, 90), // >60d — no expiry alert either
      premiumAnnual: 3000,
    });

    const insights = insuranceConditions(db, snap);
    const gaps = insights.filter((i) => i.id.startsWith('ins-gap-'));
    expect(gaps).toHaveLength(0);
  });

  // ── (d.5) gapped rollover — Finding 4 of the 2026-08-24 integrity sweep ────

  it('(d.5) flags a warning when two same-property/same-type policies sit within the gap window with no shared policy number', () => {
    const snap = makeSnap(['prop-gapped']);
    // Old term ends 2026-08-26; new term (different policy_number) starts 2026-08-27 — 1 day
    // apart, NOT exact adjacency, so sameLineage would treat these as two distinct policies.
    insertPolicy(db, {
      propertyId: 'prop-gapped',
      policyNumber: 'OLD-TERM-1',
      effectiveDate: '2025-08-27',
      expirationDate: '2026-08-26',
      premiumAnnual: 5000,
    });
    insertPolicy(db, {
      propertyId: 'prop-gapped',
      policyNumber: 'NEW-TERM-1',
      effectiveDate: '2026-08-27',
      expirationDate: '2027-08-27',
      premiumAnnual: 5200,
    });

    const insights = insuranceConditions(db, snap);
    const rollovers = insights.filter((i) => i.id.startsWith('ins-gapped-rollover-'));
    expect(rollovers).toHaveLength(1);
    expect(rollovers[0]!.severity).toBe('warning');
    expect(rollovers[0]!.category).toBe('insurance');
    expect(rollovers[0]!.entityId).toBe('prop-gapped');
  });

  it('(d.5) does NOT flag an exact-adjacency rollover (already merged by sameLineage)', () => {
    const snap = makeSnap(['prop-exact']);
    insertPolicy(db, {
      propertyId: 'prop-exact',
      policyNumber: 'OLD-TERM-2',
      effectiveDate: '2025-08-27',
      expirationDate: '2026-08-26',
      premiumAnnual: 5000,
    });
    insertPolicy(db, {
      propertyId: 'prop-exact',
      policyNumber: 'NEW-TERM-2',
      effectiveDate: '2026-08-26', // exactly equals the old term's expiration_date
      expirationDate: '2027-08-26',
      premiumAnnual: 5200,
    });

    const insights = insuranceConditions(db, snap);
    expect(insights.filter((i) => i.id.startsWith('ins-gapped-rollover-'))).toHaveLength(0);
  });

  it('(d.5) does NOT flag two policies sharing a policy_number (same lineage by definition)', () => {
    const snap = makeSnap(['prop-same-number']);
    insertPolicy(db, {
      propertyId: 'prop-same-number',
      policyNumber: 'SHARED-1',
      effectiveDate: '2025-08-27',
      expirationDate: '2026-08-26',
      premiumAnnual: 5000,
    });
    insertPolicy(db, {
      propertyId: 'prop-same-number',
      policyNumber: 'SHARED-1',
      effectiveDate: '2026-08-27',
      expirationDate: '2027-08-27',
      premiumAnnual: 5200,
    });

    const insights = insuranceConditions(db, snap);
    expect(insights.filter((i) => i.id.startsWith('ins-gapped-rollover-'))).toHaveLength(0);
  });

  it('(d.5) does NOT flag a gap beyond the 30-day window', () => {
    const snap = makeSnap(['prop-far-gap']);
    insertPolicy(db, {
      propertyId: 'prop-far-gap',
      policyNumber: 'OLD-TERM-3',
      effectiveDate: '2025-08-27',
      expirationDate: '2026-08-26',
      premiumAnnual: 5000,
    });
    insertPolicy(db, {
      propertyId: 'prop-far-gap',
      policyNumber: 'NEW-TERM-3',
      effectiveDate: '2026-12-01', // >30 days after the old term's expiration
      expirationDate: '2027-12-01',
      premiumAnnual: 5200,
    });

    const insights = insuranceConditions(db, snap);
    expect(insights.filter((i) => i.id.startsWith('ins-gapped-rollover-'))).toHaveLength(0);
  });

  // ── (e) determinism ──────────────────────────────────────────────────────

  it('(e) is deterministic: two calls on the same db+snapshot produce deeply-equal output', () => {
    const snap = makeSnap(['prop-x', 'prop-y', 'prop-z']);
    insertPolicy(db, { propertyId: 'prop-x', expirationDate: addDays(AS_OF, 10), premiumAnnual: 7000 });
    insertPolicy(db, { propertyId: 'prop-y', expirationDate: addDays(AS_OF, 120), premiumAnnual: 4000 });
    // prop-z has no policy → gap

    const first = insuranceConditions(db, snap);
    const second = insuranceConditions(db, snap);
    expect(first).toEqual(second);
  });

  // ── additional edge cases ─────────────────────────────────────────────────

  it('returns [] when the table is empty and snapshot has no properties', () => {
    const snap = makeSnap([]);
    expect(insuranceConditions(db, snap)).toEqual([]);
  });

  it('returns only gap insights when table is empty but snapshot has properties', () => {
    const snap = makeSnap(['p1', 'p2']);
    const insights = insuranceConditions(db, snap);
    expect(insights.every((i) => i.id.startsWith('ins-gap-'))).toBe(true);
    expect(insights).toHaveLength(2);
  });

  it('does not emit expiry insight for already-expired policy (daysToExpiry < 0)', () => {
    // Expired policies (past the date) are not surfaced as expiry-soon.
    // The alert is for *upcoming* renewals only (0 <= days <= 60).
    const snap = makeSnap(['prop-expired']);
    insertPolicy(db, {
      propertyId: 'prop-expired',
      expirationDate: addDays(AS_OF, -5), // 5 days ago
      premiumAnnual: 6000,
    });

    const insights = insuranceConditions(db, snap);
    // Should have a gap insight (the expired policy's property_id IS in the table,
    // so no gap) and no expiry insight.
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(0);
  });

  it('coerces non-finite premium to null (defensive)', () => {
    // SQLite won't store NaN/Infinity, but the coercion must handle JS-layer values
    // if they somehow arrive. We test the null-coercion path via a null DB value.
    const snap = makeSnap(['prop-nullprem']);
    insertPolicy(db, {
      propertyId: 'prop-nullprem',
      expirationDate: addDays(AS_OF, 20),
      premiumAnnual: null, // DB stores NULL
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry[0]!.impactAnnualUsd).toBeNull();
  });

  // ── multi-policy deduplication (CR fix) ──────────────────────────────────

  it('emits exactly ONE expiry insight per property even when multiple policy rows exist', () => {
    // property_insurance_policies UNIQUE is on (property_id, policy_number, effective_date),
    // so a property can have multiple rows. Without deduplication, each row would
    // generate a duplicate id `ins-expiry-<propertyId>`, which violates the id-uniqueness
    // invariant. The function must deduplicate to one insight per property_id.
    const snap = makeSnap(['prop-multi']);
    // Two policies for the same property, both within the alert window.
    db.prepare(`
      INSERT INTO property_insurance_policies
        (property_id, insurer, policy_number, effective_date, expiration_date,
         premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prop-multi', 'Insurer A', 'POL-001', addDays(AS_OF, -365), addDays(AS_OF, 15), 4000, null, 'general-liability', 'test', AS_OF, 'test');
    db.prepare(`
      INSERT INTO property_insurance_policies
        (property_id, insurer, policy_number, effective_date, expiration_date,
         premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('prop-multi', 'Insurer B', 'POL-002', addDays(AS_OF, -180), addDays(AS_OF, 45), 8000, null, 'property', 'test', AS_OF, 'test');

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));
    // Exactly one insight per property, not one per row.
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.id).toBe('ins-expiry-prop-multi');
    // The soonest-expiring policy (15 days) wins.
    expect(expiry[0]!.detail).toContain('15 day');
    expect(expiry[0]!.impactAnnualUsd).toBe(4000);
  });

  // ── Rollover false-critical regression (2026-08-17, adversarial refute sweep finding) ────

  it('a ROLLED-OVER policy does not fire a false expiry-soon critical for its superseded prior term', () => {
    // Live production bug: the OLD term (already renewed, superseded by a new term filed a year
    // later) still has an expiration_date inside the 60-day window as of its own capture. Before
    // the 2026-08-17 fix, insuranceConditions read raw rows and the stale term's near-term expiry
    // won the per-property "soonest" pick, firing a false CRITICAL for a policy that was already
    // renewed — verified against production data (1900 Broadway BCL + UFX). The rolled term
    // (expiring ~1 year out) is what should actually govern.
    const snap = makeSnap(['prop-rolled']);
    // Old term: expires in 10 days — inside the alert window, but already superseded.
    insertPolicy(db, {
      propertyId: 'prop-rolled',
      policyType: 'Property',
      policyNumber: 'ROLL-OLD',
      effectiveDate: addDays(AS_OF, -365),
      expirationDate: addDays(AS_OF, 10),
      premiumAnnual: 11_166,
      sourceDate: addDays(AS_OF, -1),
    });
    // Rolled-over current term: same property/coverage, new policy_number, expiring ~1 year out
    // — outside the alert window, captured more recently.
    insertPolicy(db, {
      propertyId: 'prop-rolled',
      policyType: 'Property',
      policyNumber: 'ROLL-NEW',
      effectiveDate: addDays(AS_OF, 10),
      expirationDate: addDays(AS_OF, 375),
      premiumAnnual: 11_554,
      sourceDate: AS_OF,
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));

    // No false critical for the already-renewed term; the real current term isn't in the window.
    expect(expiry).toHaveLength(0);
  });

  it('a genuinely CURRENT term still fires expiry-soon on its own (rollover collapse does not suppress real alerts)', () => {
    const snap = makeSnap(['prop-rolled2']);
    insertPolicy(db, {
      propertyId: 'prop-rolled2',
      policyType: 'Property',
      policyNumber: 'ROLL-OLD2',
      effectiveDate: addDays(AS_OF, -730),
      expirationDate: addDays(AS_OF, -365),
      premiumAnnual: 10_000,
      sourceDate: addDays(AS_OF, -366),
    });
    // Current term itself is the one expiring soon — must still alert.
    insertPolicy(db, {
      propertyId: 'prop-rolled2',
      policyType: 'Property',
      policyNumber: 'ROLL-NEW2',
      effectiveDate: addDays(AS_OF, -365),
      expirationDate: addDays(AS_OF, 20),
      premiumAnnual: 10_500,
      sourceDate: AS_OF,
    });

    const insights = insuranceConditions(db, snap);
    const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-'));

    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.impactAnnualUsd).toBe(10_500);
  });
});

// ── Policy-slug → subject-label resolution (2026-08-11) ─────────────────────
// Production reality: property_insurance_policies.property_id holds POLICY-level slugs
// ("ins-fvc-pckg"), not property ids — 25 rows, 25 distinct values, 0 matching a property id.
// Consequence that reached Gabriel: raw slugs in the email subject line
// ("Insurance expiring soon — ins-1900broadway-bcl", sent 2026-07-12).
//
// The fixtures below use the REAL production strings, deliberately. An earlier version of
// these tests used idealized fixtures where insurance[].property === properties[].name, which
// made a broken join look fixed — the two fields disagree on abbreviation and ZIP in every
// one of the 25 real rows. Anything asserted here must hold for data that actually exists.
describe('insuranceConditions — policy-slug subject labelling', () => {
  let db: WarehouseDb;
  let dbDir: string;

  beforeEach(() => { const t = tmpDb(); db = t.db; dbDir = t.dir; });
  afterEach(() => { db.close(); rmSync(dbDir, { recursive: true, force: true }); });

  /** Real property names and real policy `.property` strings — note they never match. */
  function realisticSnap(): PortfolioSnapshot {
    const base = makeSnap([]) as unknown as Record<string, unknown>;
    return {
      ...base,
      properties: [
        { id: '55-new-plant-ct-owings-mills-md', name: '55 New Plant Ct, Owings Mills MD' },
        { id: 'sepich-portfolio-columbus-oh-8-props', name: 'Sepich Portfolio, Columbus OH (8 props)' },
      ],
      insurance: [
        { id: 'ins-55newplant-pckg', property: '55 New Plant Court, Owings Mills MD 21117', coverage: 'Package (PCKG)', status: 'Current', premium: 0, flags: [] },
        { id: 'ins-55newplant-bcl', property: '55 New Plant Court, Owings Mills MD 21117', coverage: 'Business Crime Liability (BCL)', status: 'Current', premium: 0, flags: [] },
      ],
    } as unknown as PortfolioSnapshot;
  }

  it('a raw policy slug never survives into the alert title', () => {
    insertPolicy(db, { propertyId: 'ins-55newplant-pckg', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    const expiry = insuranceConditions(db, realisticSnap(), AS_OF).filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.title).not.toContain('ins-55newplant-pckg');
    expect(expiry[0]!.title).toContain('55 New Plant Court');
    expect(expiry[0]!.title).toContain('Package (PCKG)');
  });

  it('the insight id is UNCHANGED, so existing alert-state entries keep matching', () => {
    // Guards against a one-time re-alert of every open policy on first run after deploy.
    insertPolicy(db, { propertyId: 'ins-55newplant-pckg', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    const expiry = insuranceConditions(db, realisticSnap(), AS_OF).filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry[0]!.id).toBe('ins-expiry-ins-55newplant-pckg');
  });

  it('two policies at one property produce two DISTINCT, non-slug titles', () => {
    insertPolicy(db, { propertyId: 'ins-55newplant-pckg', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    insertPolicy(db, { propertyId: 'ins-55newplant-bcl', expirationDate: addDays(AS_OF, 12), premiumAnnual: 50 });
    const titles = insuranceConditions(db, realisticSnap(), AS_OF)
      .filter((i) => i.id.startsWith('ins-expiry-')).map((i) => i.title);
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
    expect(titles.every((t) => !t.includes('ins-55newplant'))).toBe(true);
    expect(titles.some((t) => t.includes('Package (PCKG)'))).toBe(true);
    expect(titles.some((t) => t.includes('Business Crime Liability (BCL)'))).toBe(true);
  });

  it('a warehouse property_id that IS a real property id resolves to the property name', () => {
    insertPolicy(db, { propertyId: '55-new-plant-ct-owings-mills-md', expirationDate: addDays(AS_OF, 5), premiumAnnual: 10 });
    const expiry = insuranceConditions(db, realisticSnap(), AS_OF).filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry[0]!.title).toContain('55 New Plant Ct, Owings Mills MD');
  });

  it('an unresolvable slug fails OPEN and still names something', () => {
    insertPolicy(db, { propertyId: 'ins-orphan-pckg', expirationDate: addDays(AS_OF, 5), premiumAnnual: 1000 });
    const expiry = insuranceConditions(db, realisticSnap(), AS_OF).filter((i) => i.id.startsWith('ins-expiry-'));
    expect(expiry).toHaveLength(1); // never silently dropped
    expect(expiry[0]!.title).toContain('ins-orphan-pckg'); // raw value is the last resort
  });

  it('a snapshot with no insurance array does not throw (mirror / fresh worktree)', () => {
    // insuranceConditions runs inside run.ts's catch-all: a throw here silently drops EVERY
    // insurance critical, so this must degrade to slug labelling rather than fail.
    const base = makeSnap([]) as unknown as Record<string, unknown>;
    const noIns = { ...base, properties: [], insurance: undefined } as unknown as PortfolioSnapshot;
    insertPolicy(db, { propertyId: 'ins-55newplant-pckg', expirationDate: addDays(AS_OF, 5), premiumAnnual: 1 });
    expect(() => insuranceConditions(db, noIns, AS_OF)).not.toThrow();
    expect(insuranceConditions(db, noIns, AS_OF).filter((i) => i.id.startsWith('ins-expiry-'))).toHaveLength(1);
  });
});

// ── insuranceWarehouseDriftConditions — warehouse vs live-workbook cross-check ─────────────
// Cross-checks property_insurance_policies (the warehouse's periodic ingest snapshot — Source A
// / "warehouse rows") against the live PortfolioSnapshot.insurance[] read straight off the
// workbook's Insurance Renewals tab (Source B / "workbook"). The two are joined on `property_id`
// / `insurance[].id`, both of which are `slug(RowID)` (server/workbook/parse.ts:827,
// server/warehouse/insurance.ts:46) — the same key, so a direct equality join is correct, unlike
// the property-name join that fails elsewhere in this file.
//
//   INGEST DRIFT   — the two sides carry a DIFFERENT `expires`/`expiration_date` for the same
//                    RowID. This is the expected, legitimate shape of the warehouse being a
//                    periodic batch snapshot (Gabriel's 2026-08-15 finding: FVC and 3883
//                    Livingston drifted this way after a 2026-08-13 hand-correction to the
//                    workbook that the warehouse hadn't re-ingested yet). The insight states
//                    BOTH dates plainly and does NOT assert which side is stale — an earlier
//                    warehouse date is consistent with the warehouse lagging a workbook
//                    correction, but a workbook correction that pulls a date EARLIER (as in the
//                    FVC case) would leave the warehouse holding the LATER of the two, so "earlier
//                    date = stale" is not a safe inference in general.
//
//   LOGIC DISAGREEMENT — the two sides agree on the expiration DATE but compute a different
//                    lapsed/expired VERDICT from it: the warehouse side is date-based
//                    (expiration_date < asOf), the workbook side is its own live Status column
//                    (Expired/Cancelled, driven by a `=TODAY()` formula — column K). A boundary
//                    case (policy expiring exactly on asOf) is the natural place these two
//                    verdict computations can disagree even from identical input.
//
// Both conditions are severity 'warning' / category 'data' (not 'insurance'): this is a
// data-reconciliation finding about the two SYSTEMS disagreeing, not a claim that a property is
// actually uncovered — that claim already belongs to insurance-expiry-soon / insurance-gap above
// and to src/analytics/conditions.ts's ins-lapsed-* conditions. Keeping it 'warning' also keeps
// it out of the immediate per-critical alert email (server/brief/run.ts's criticalIds filter) —
// it still rides the existing brief digest / Notion Ops Hub path via the shared `insights` array,
// per Gabriel's instruction not to build a new notification channel.
describe('insuranceWarehouseDriftConditions', () => {
  let db: WarehouseDb;
  let dbDir: string;

  beforeEach(() => { const t = tmpDb(); db = t.db; dbDir = t.dir; });
  afterEach(() => { db.close(); rmSync(dbDir, { recursive: true, force: true }); });

  /** Minimal live-workbook insurance row, keyed the same way as the warehouse's property_id. */
  function liveRow(o: {
    id: string;
    property?: string;
    coverage?: string | null;
    expires?: string | null;
    status?: string;
  }) {
    return {
      id: o.id,
      property: o.property ?? `Property for ${o.id}`,
      entity: null,
      coverage: o.coverage ?? 'Package',
      effective: null,
      expires: o.expires ?? null,
      policyNo: null,
      carrier: 'Test Carrier',
      premium: 1000,
      daysToExpiry: null,
      status: o.status ?? 'Current',
      notes: null,
      flags: [],
      tiv: null,
      deductible: null,
      coverageLimit: null,
    };
  }

  function snapWithInsurance(propertyIds: string[], insurance: ReturnType<typeof liveRow>[]): PortfolioSnapshot {
    const base = makeSnap(propertyIds) as unknown as Record<string, unknown>;
    return { ...base, insurance } as unknown as PortfolioSnapshot;
  }

  // ── (a) INGEST DRIFT — dates differ ─────────────────────────────────────

  it('(a) flags INGEST DRIFT when warehouse and live workbook expiration dates differ', () => {
    // Mirrors the confirmed 2026-08-15 finding: workbook hand-corrected, warehouse not yet
    // re-ingested — the two sides disagree on the same policy's expiration date.
    insertPolicy(db, { propertyId: 'ins-fvc-pckg', expirationDate: addDays(AS_OF, 10), premiumAnnual: 5000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-fvc-pckg', property: 'FVC', coverage: 'Package', expires: addDays(AS_OF, -20), status: 'Expired' }),
    ]);

    const out = insuranceWarehouseDriftConditions(db, snap, AS_OF);

    expect(out).toHaveLength(1);
    const ins = out[0]!;
    expect(ins.id).toBe('insurance-warehouse-drift-ins-fvc-pckg');
    expect(ins.severity).toBe('warning');
    expect(ins.category).toBe('data');
    expect(ins.entityType).toBe('insurance');
    expect(ins.entityId).toBe('ins-fvc-pckg');
    // Both dates must be stated plainly, not just one.
    expect(ins.detail).toContain(addDays(AS_OF, 10));
    expect(ins.detail).toContain(addDays(AS_OF, -20));
    // Must NOT assert which side is stale.
    expect(ins.detail.toLowerCase()).not.toMatch(/warehouse is stale|workbook is stale|warehouse is wrong|workbook is wrong/);
    expect(ins.spine).toBe('B');
    expect(ins.provenance).toBe('derived');
  });

  it('(a) INGEST DRIFT fires regardless of which side has the later date', () => {
    // The reverse direction of the fixture above: warehouse holds the LATER date this time
    // (the workbook correction pulled the live date EARLIER, as in the real FVC case) — the
    // insight must still fire and still avoid asserting a stale side.
    insertPolicy(db, { propertyId: 'ins-livingston-pckg', expirationDate: addDays(AS_OF, 30), premiumAnnual: 4000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-livingston-pckg', property: '3883 Livingston', expires: addDays(AS_OF, -5), status: 'Expired' }),
    ]);

    const out = insuranceWarehouseDriftConditions(db, snap, AS_OF);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('insurance-warehouse-drift-ins-livingston-pckg');
  });

  it('(a) does NOT also fire LOGIC DISAGREEMENT for a row already flagged as INGEST DRIFT', () => {
    // Date drift is the root-cause explanation for any verdict difference on the same row —
    // firing both would be redundant noise about the same underlying fact.
    insertPolicy(db, { propertyId: 'ins-dual', expirationDate: addDays(AS_OF, -10), premiumAnnual: 1000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-dual', expires: addDays(AS_OF, 10), status: 'Current' }),
    ]);

    const out = insuranceWarehouseDriftConditions(db, snap, AS_OF);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('insurance-warehouse-drift-ins-dual');
  });

  // ── (a.5) determinism under row-order — Finding 7 of the 2026-08-24 integrity sweep ────

  it('(a.5) isMoreCurrentRow gives a total order: the reduce picks the SAME winner regardless of array permutation on a source_date tie', () => {
    // Two rows sharing source_date (the common case -- one capture batch stamps a uniform
    // source_date on every row) and effective_date, differing only by id and expiration_date --
    // exactly the shape that let physical row order silently decide the winner before this fix
    // (demonstrated live: order [101,102] fired a drift alert, order [102,101] did not, same
    // underlying data). isMoreCurrentRow's total order (source_date, then effective_date, then id)
    // must pick the higher-id row NO MATTER which order the two rows appear in the input array.
    const rowLowId: CollapsibleInsuranceRow = {
      id: 101,
      property_id: 'p',
      policy_number: 'A',
      effective_date: '2025-08-21',
      expiration_date: '2026-09-01',
      policy_type: 'general-liability',
      source_date: '2026-08-21',
    };
    const rowHighId: CollapsibleInsuranceRow = {
      id: 102,
      property_id: 'p',
      policy_number: 'B',
      effective_date: '2025-08-21',
      expiration_date: '2027-08-01',
      policy_type: 'general-liability',
      source_date: '2026-08-21',
    };
    const reduceWinner = (rows: CollapsibleInsuranceRow[]) => rows.reduce((best, r) => (isMoreCurrentRow(r, best) ? r : best));

    expect(reduceWinner([rowLowId, rowHighId]).id).toBe(102);
    expect(reduceWinner([rowHighId, rowLowId]).id).toBe(102);
  });

  // ── (b) LOGIC DISAGREEMENT — same date, different verdict ────────────────

  it('(b) flags LOGIC DISAGREEMENT when dates match but computed lapse verdicts differ', () => {
    // Boundary case: the policy expires exactly ON asOf. The warehouse's date-based check
    // (expiration_date < asOf) reads "not yet lapsed" for day 0, while the workbook's own
    // Status column (its live =TODAY()-driven formula) already reads "Expired" for the same day.
    insertPolicy(db, { propertyId: 'ins-boundary', expirationDate: AS_OF, premiumAnnual: 2000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-boundary', property: 'Boundary Property', expires: AS_OF, status: 'Expired' }),
    ]);

    const out = insuranceWarehouseDriftConditions(db, snap, AS_OF);

    expect(out).toHaveLength(1);
    const ins = out[0]!;
    expect(ins.id).toBe('insurance-warehouse-drift-logic-ins-boundary');
    expect(ins.severity).toBe('warning');
    expect(ins.category).toBe('data');
    expect(ins.detail).toContain(AS_OF);
    expect(ins.spine).toBe('B');
    expect(ins.provenance).toBe('derived');
  });

  it('(b) does NOT fire when dates match and both sides agree the policy is current', () => {
    insertPolicy(db, { propertyId: 'ins-agree-current', expirationDate: addDays(AS_OF, 90), premiumAnnual: 3000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-agree-current', expires: addDays(AS_OF, 90), status: 'Current' }),
    ]);

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  it('(b) does NOT fire when dates match and both sides agree the policy has lapsed', () => {
    insertPolicy(db, { propertyId: 'ins-agree-lapsed', expirationDate: addDays(AS_OF, -30), premiumAnnual: 3000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-agree-lapsed', expires: addDays(AS_OF, -30), status: 'Cancelled' }),
    ]);

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  // ── (c) no matching row on one side → skip silently, never throw ─────────

  it('(c) skips a warehouse row with no matching live-workbook insurance id', () => {
    insertPolicy(db, { propertyId: 'ins-warehouse-only', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    const snap = snapWithInsurance([], []); // no live insurance rows at all

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  it('(c) skips a live-workbook row with no matching warehouse property_id', () => {
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-live-only', expires: addDays(AS_OF, 10), status: 'Current' }),
    ]);

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  it('(c) never throws on a snapshot with no insurance array (mirror / fresh worktree)', () => {
    const base = makeSnap([]) as unknown as Record<string, unknown>;
    const noIns = { ...base, insurance: undefined } as unknown as PortfolioSnapshot;
    insertPolicy(db, { propertyId: 'ins-whatever', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    expect(() => insuranceWarehouseDriftConditions(db, noIns, AS_OF)).not.toThrow();
    expect(insuranceWarehouseDriftConditions(db, noIns, AS_OF)).toEqual([]);
  });

  it('(c) skips a row where either side has no expiration date on file', () => {
    insertPolicy(db, { propertyId: 'ins-no-date', expirationDate: null, premiumAnnual: 1000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-no-date', expires: null, status: 'Unknown' }),
    ]);

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  // ── (d) multiple warehouse rows for one property_id → compare against the current term ──

  it('(d) compares against the warehouse row with the latest effective_date when several exist', () => {
    // property_insurance_policies allows multiple rows per property_id (UNIQUE spans
    // policy_number + effective_date too) — e.g. a prior term's row left in place alongside
    // the current term's. The comparison must use the CURRENT term, not an arbitrary row.
    // Old row's expiration is EXACTLY adjacent to the new row's effective_date (2026-08-21 fix:
    // sameLineage now requires exact adjacency, matching the only verified real rollover shape —
    // an arbitrary gap no longer collapses two rows, see insurance-analysis.test.ts's "does NOT
    // merge two genuinely DISTINCT... policies" test for that case).
    db.prepare(`
      INSERT INTO property_insurance_policies
        (property_id, insurer, policy_number, effective_date, expiration_date,
         premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ins-multi', 'Old Insurer', 'POL-OLD', addDays(AS_OF, -400), addDays(AS_OF, -20), 1000, null, 'general-liability', 'test', AS_OF, 'test');
    db.prepare(`
      INSERT INTO property_insurance_policies
        (property_id, insurer, policy_number, effective_date, expiration_date,
         premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ins-multi', 'Current Insurer', 'POL-NEW', addDays(AS_OF, -20), addDays(AS_OF, 40), 6000, null, 'general-liability', 'test', AS_OF, 'test');

    // Live workbook agrees with the CURRENT term (40d out), not the old row (-35d).
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-multi', expires: addDays(AS_OF, 40), status: 'Current' }),
    ]);

    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  it('FIXED 2026-08-21 (adversarial review finding): pickCurrentRow does not compare the wrong policy_type when one property_id/slug carries more than one coverage', () => {
    // Before this fix, pickCurrentRow picked purely by source_date across ALL policy_type
    // clusters sharing this property_id/slug — so a more-recently-captured General Liability row
    // could get diffed against the live workbook's Property coverage, producing a spurious drift
    // alert even though the actual Property coverage's dates agree exactly. Now it prefers the
    // cluster whose policy_type matches live.coverage.
    insertPolicy(db, {
      propertyId: 'ins-multi-type', policyType: 'Property', policyNumber: 'MULTI-PROP',
      expirationDate: addDays(AS_OF, 90), premiumAnnual: 5000, sourceDate: addDays(AS_OF, -30),
    });
    insertPolicy(db, {
      propertyId: 'ins-multi-type', policyType: 'General Liability', policyNumber: 'MULTI-GL',
      expirationDate: addDays(AS_OF, 200), premiumAnnual: 2000, sourceDate: AS_OF, // captured MORE recently than the Property row
    });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-multi-type', coverage: 'Property', expires: addDays(AS_OF, 90), status: 'Current' }),
    ]);

    // The Property coverage's dates genuinely agree — no drift, and no wrong-type comparison
    // against the GL row's very different (200d out) expiration.
    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF)).toHaveLength(0);
  });

  // ── (e) determinism ────────────────────────────────────────────────────

  it('(e) is deterministic: two calls on the same db+snapshot produce deeply-equal output', () => {
    insertPolicy(db, { propertyId: 'ins-a', expirationDate: addDays(AS_OF, 10), premiumAnnual: 1000 });
    insertPolicy(db, { propertyId: 'ins-b', expirationDate: AS_OF, premiumAnnual: 2000 });
    const snap = snapWithInsurance([], [
      liveRow({ id: 'ins-a', expires: addDays(AS_OF, -10), status: 'Expired' }), // drift
      liveRow({ id: 'ins-b', expires: AS_OF, status: 'Expired' }), // logic disagreement
    ]);

    const first = insuranceWarehouseDriftConditions(db, snap, AS_OF);
    const second = insuranceWarehouseDriftConditions(db, snap, AS_OF);
    expect(first).toEqual(second);
    expect(first.map((i) => i.id)).toEqual([
      'insurance-warehouse-drift-ins-a',
      'insurance-warehouse-drift-logic-ins-b',
    ]);
  });
});
