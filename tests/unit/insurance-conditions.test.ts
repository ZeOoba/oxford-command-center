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
import { insuranceConditions } from '../../server/warehouse/insurance-conditions';
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
    `POL-${opts.propertyId}`,
    addDays(AS_OF, -365),
    opts.expirationDate,
    opts.premiumAnnual,
    null,
    opts.policyType ?? 'general-liability',
    'test',
    AS_OF,
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
