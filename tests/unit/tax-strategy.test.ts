// @vitest-environment node
//
// tests/unit/tax-strategy.test.ts
//
// P4c / C2 — Tax STRATEGY engine: buildTaxStrategyReport(db, asOf).
// The engine is NOT pure (its signature takes a WarehouseDb): it calls Task 2's
// resolveDepreciableBasis(db) / resolveFiledReturns() (which read the real
// server/warehouse/placeholders/*.placeholder.json fixtures) and getPropertyMaster(db).
// So each test builds an in-memory better-sqlite3 DB, runs migrations, and seeds
// property_master so the fixture rows survive the resolver's known-property filter.
//
// Every expected number below is hand-computed against the REAL fixture
// (server/warehouse/placeholders/depreciable-basis.placeholder.json):
//   bonusPctByYear = { "2025": 0.4, "2026": 0.4 }
//   3540-e-5th-ave-columbus-oh : basis 1,200,000 · reclassifiablePct 0.25 · land 0.2
//   3034-westerville-rd-columbus-oh : basis 900,000 · reclassifiablePct 0.25
//   29000-information-lane-easton-md : basis 2,000,000 · reclassifiablePct 0.30
//   9620-e-state-route-350-raytown-mo : basis 800,000 · reclassifiablePct 0.20
//   9050-red-branch-rd-columbia-md : basis 1,500,000 · reclassifiablePct 0.25
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildTaxStrategyReport } from '../../server/warehouse/tax-strategy';
import { TaxStrategyReport } from '../../src/contracts/tax-strategy';

function freshDb(seed?: (db: Database.Database) => void): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seed?.(db);
  return db;
}

/** Insert one property_master row with an explicit ownership_pct (default is 1.0). */
function insertProperty(db: Database.Database, id: string, name: string, ownershipPct: number): void {
  db.prepare('INSERT INTO property_master (id, name, ownership_pct) VALUES (?, ?, ?)').run(id, name, ownershipPct);
}

/** costSeg is ordered; look rows up by propertyId so assertions are order-independent. */
function byProp(report: ReturnType<typeof buildTaxStrategyReport>) {
  return new Map(report.costSeg.map((c) => [c.propertyId, c]));
}

describe('buildTaxStrategyReport — cost-seg acceleration', () => {
  it('(a) hand-computed acceleration for one property @ ownershipPct 0.5, asOf 2026', () => {
    // Only 3540 is seeded → the resolver keeps its 1 fixture row and DROPS the other 4.
    // reclassifiableBasis        = 1,200,000 × 0.25            = 300,000
    // bonusYearPct (2026)        = 0.4
    // firstYearAccelerationUsd   = 300,000 × 0.4              = 120,000
    // firstYearAccelerationOxfd  = 120,000 × 0.5 (ownership)  = 60,000
    const db = freshDb((d) => insertProperty(d, '3540-e-5th-ave-columbus-oh', '3540 E 5th Ave', 0.5));
    const report = buildTaxStrategyReport(db, '2026-07-09');

    expect(report.costSeg).toHaveLength(1);
    const c = report.costSeg[0]!;
    expect(c).toMatchObject({
      propertyId: '3540-e-5th-ave-columbus-oh',
      propertyName: '3540 E 5th Ave',
      depreciableBasis: 1_200_000,
      landAllocationPct: 0.2,
      reclassifiablePct: 0.25,
      reclassifiableBasis: 300_000,
      bonusYearPct: 0.4,
      firstYearAccelerationUsd: 120_000,
      firstYearAccelerationOxfordShare: 60_000,
      indeterminate: false,
    });
    // savings are HARD-NULL by contract (rule 2) — never computed
    expect(c.savingsFullAsset).toBeNull();
    expect(c.savingsOxfordShare).toBeNull();
    // provenance
    expect(c.prov.source).toBe('depreciable-basis.placeholder.json');
    expect(c.prov.confidence).toBe('estimated');
    expect(typeof c.prov.formula).toBe('string');
    expect(c.prov.formula!.length).toBeGreaterThan(0);
    // 4 fixture rows dropped for the 4 unseeded properties
    expect(report.droppedFixtureRows).toBe(4);
    expect(report.basisDataSource).toBe('placeholder');
    expect(report.asOf).toBe('2026-07-09');
  });

  it('(b) missing-year schedule → bonus/acceleration null + indeterminate true (basis still computed)', () => {
    // asOf 2099 → bonusPctByYear['2099'] is undefined → null.
    // reclassifiableBasis is still 1,200,000 × 0.25 = 300,000 (independent of the year).
    const db = freshDb((d) => insertProperty(d, '3540-e-5th-ave-columbus-oh', '3540 E 5th Ave', 0.5));
    const report = buildTaxStrategyReport(db, '2099-01-01');

    const c = report.costSeg[0]!;
    expect(c.reclassifiableBasis).toBe(300_000);
    expect(c.bonusYearPct).toBeNull();
    expect(c.firstYearAccelerationUsd).toBeNull();
    expect(c.firstYearAccelerationOxfordShare).toBeNull();
    expect(c.indeterminate).toBe(true);
    // savings STILL null in the indeterminate case
    expect(c.savingsFullAsset).toBeNull();
    expect(c.savingsOxfordShare).toBeNull();
  });

  it('(c) real-roster ownershipPct is applied (not a hardcoded share) — full fixture via seedPropertyMaster', () => {
    // seedPropertyMaster seeds ALL 14 canon properties, so all 5 fixture rows survive (0 dropped).
    // asOf 2026 → bonusYearPct 0.4 for every row. ownershipPct is the REAL canon value.
    //   3540  own 1.0 : 1,200,000×0.25=300,000 ×0.4=120,000 ×1.0 = 120,000
    //   3034  own 1.0 :   900,000×0.25=225,000 ×0.4= 90,000 ×1.0 =  90,000
    //   29000 own 1.0 : 2,000,000×0.30=600,000 ×0.4=240,000 ×1.0 = 240,000
    //   9620  own 1.0 :   800,000×0.20=160,000 ×0.4= 64,000 ×1.0 =  64,000
    //   9050  own 0.5 : 1,500,000×0.25=375,000 ×0.4=150,000 ×0.5 =  75,000  ← real 0.5 roster value
    const db = freshDb((d) => seedPropertyMaster(d));
    const report = buildTaxStrategyReport(db, '2026-07-09');

    expect(report.costSeg).toHaveLength(5);
    expect(report.droppedFixtureRows).toBe(0);
    const m = byProp(report);

    expect(m.get('3540-e-5th-ave-columbus-oh')).toMatchObject({ reclassifiableBasis: 300_000, firstYearAccelerationUsd: 120_000, firstYearAccelerationOxfordShare: 120_000 });
    expect(m.get('3034-westerville-rd-columbus-oh')).toMatchObject({ reclassifiableBasis: 225_000, firstYearAccelerationUsd: 90_000, firstYearAccelerationOxfordShare: 90_000 });
    expect(m.get('29000-information-lane-easton-md')).toMatchObject({ reclassifiableBasis: 600_000, firstYearAccelerationUsd: 240_000, firstYearAccelerationOxfordShare: 240_000 });
    expect(m.get('9620-e-state-route-350-raytown-mo')).toMatchObject({ reclassifiableBasis: 160_000, firstYearAccelerationUsd: 64_000, firstYearAccelerationOxfordShare: 64_000 });
    // 9050 is the discriminating case: Oxford share 75,000 = 150,000 × 0.5 proves the real
    // roster ownership (0.5) is read, not a hardcoded factor.
    expect(m.get('9050-red-branch-rd-columbia-md')).toMatchObject({ firstYearAccelerationUsd: 150_000, firstYearAccelerationOxfordShare: 75_000 });
  });

  it('(d) savingsFullAsset / savingsOxfordShare are ALWAYS null across every row & every case', () => {
    // determinate (2026) full roster
    const det = buildTaxStrategyReport(freshDb((d) => seedPropertyMaster(d)), '2026-07-09');
    for (const c of det.costSeg) {
      expect(c.savingsFullAsset).toBeNull();
      expect(c.savingsOxfordShare).toBeNull();
    }
    // indeterminate (2099) full roster
    const ind = buildTaxStrategyReport(freshDb((d) => seedPropertyMaster(d)), '2099-07-09');
    for (const c of ind.costSeg) {
      expect(c.savingsFullAsset).toBeNull();
      expect(c.savingsOxfordShare).toBeNull();
    }
    expect(det.costSeg.length).toBeGreaterThan(0);
    expect(ind.costSeg.length).toBeGreaterThan(0);
  });
});

describe('buildTaxStrategyReport — entity strategies (static qualitative)', () => {
  it('(e) exactly three items with the exact ids, kinds, and the required phrase; no dollars', () => {
    const report = buildTaxStrategyReport(freshDb((d) => seedPropertyMaster(d)), '2026-07-09');
    expect(report.entityStrategies).toHaveLength(3);
    expect(report.entityStrategies.map((s) => s.id)).toEqual(['es-entity-review', 'es-sec469-grouping', 'es-pipeline-1031']);
    expect(Object.fromEntries(report.entityStrategies.map((s) => [s.id, s.kind]))).toEqual({
      'es-entity-review': 'entity-structure',
      'es-sec469-grouping': 'sec469',
      'es-pipeline-1031': 'pipeline',
    });
    const PHRASE = 'Qualitative placeholder — review with accountant; no dollar impact is computed by design.';
    for (const s of report.entityStrategies) {
      expect(s.applicabilityNote).toContain(PHRASE);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('buildTaxStrategyReport — filed returns & envelope', () => {
  it('(f) filed returns mapped 1:1 (metadata-only placeholder)', () => {
    const report = buildTaxStrategyReport(freshDb((d) => seedPropertyMaster(d)), '2026-07-09');
    expect(report.filedReturnsDataSource).toBe('placeholder');
    expect(report.filedReturns).toHaveLength(3);
    expect(report.filedReturns.every((r) => r.entity.includes('PLACEHOLDER'))).toBe(true);
    // spot-check the first fixture row maps every field 1:1
    const first = report.filedReturns.find((r) => r.id === 'PLR-2024-A')!;
    expect(first).toMatchObject({ id: 'PLR-2024-A', taxYear: 2024, entity: 'PLACEHOLDER — Entity A LLC', preparer: 'PLACEHOLDER CPA', status: 'filed' });
    expect(first.storageNote.length).toBeGreaterThan(0);
  });

  it('(g) output Zod-parses, advisoryOnly literal true, scheduleNote + basisNote wiring', () => {
    const report = buildTaxStrategyReport(freshDb((d) => seedPropertyMaster(d)), '2026-07-09');
    // a re-parse of the returned value must succeed (engine parses internally too)
    expect(() => TaxStrategyReport.parse(report)).not.toThrow();
    expect(report.advisoryOnly).toBe(true);
    // top-level scheduleNote is the resolver's raw note
    expect(report.scheduleNote).toMatch(/PLACEHOLDER/);
    // per-row basisNote combines the schedule note with the deduction-timing reminder
    const c = report.costSeg[0]!;
    expect(c.basisNote).toMatch(/PLACEHOLDER/);
    expect(c.basisNote.toLowerCase()).toContain('not tax');
  });

  it('(h) empty property_master → every fixture row dropped, empty costSeg, still parses', () => {
    // No seed at all → knownPropertyIds empty → all 5 fixture rows dropped.
    const report = buildTaxStrategyReport(freshDb(), '2026-07-09');
    expect(report.costSeg).toHaveLength(0);
    expect(report.droppedFixtureRows).toBe(5);
    expect(report.basisDataSource).toBe('placeholder'); // fixture present, just no matching properties
    expect(report.entityStrategies).toHaveLength(3);     // static — independent of basis rows
    expect(() => TaxStrategyReport.parse(report)).not.toThrow();
  });
});
