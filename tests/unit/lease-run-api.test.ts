// tests/unit/lease-run-api.test.ts
//
// DB round-trip (migration 006 + seed + read helpers) and route tests for the read-only
// /analytics/lease-run[/:propertyId] sub-routes via Hono app.request() (no network).
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Routes + Test plan).
//
// Proves: the seed round-trips through SQLite JSON and reconciles to the dollar after the trip;
// the Zod envelope parses (H6 read boundary); the rollup aggregates; an unknown property → typed
// empty projection (no crash); the 503 guard; and the Fishel below-market chip fires off the real
// cohort benchmark.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { setLeaseRunAssumptions } from '../../server/overlay';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { getLeaseTerms, listLeaseTermPropertyIds, seedLeaseTerms } from '../../server/warehouse/lease-terms';
import { SYNTHETIC_LEASE_TERM_SEEDS } from './lease-run-fixtures';
import { projectLeaseRun, DEFAULT_LEASE_RUN_ASSUMPTIONS } from '../../server/warehouse/lease-run';
import {
  LeaseRunProjectionEnvelope,
  LeaseRunRollupResponse,
} from '../../src/contracts/lease-run';

const SUNBURST = '401-sunburst-hwy-cambridge-md';
const FISHEL = '7658-fishel-dr-n-dublin-oh';

// The lease-run route reads the overlay via process.env.OVERLAY_PATH (loadOverlay). That path is
// process-global state — a test that does not control it would read whatever a prior test (or the
// real data/overlay.json) left there. Point EVERY test at a fresh, empty overlay so the whole file
// is hermetic; tests that exercise overrides write into their own isolated file. (Adversarial #6:
// the overlay path is global; without this, override state leaks between tests.)
const OVERLAY_PRIOR = process.env.OVERLAY_PATH;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-run-overlay-'));
  process.env.OVERLAY_PATH = join(dir, 'overlay.json');
  writeFileSync(process.env.OVERLAY_PATH, JSON.stringify({}));
});
afterAll(() => {
  if (OVERLAY_PRIOR === undefined) delete process.env.OVERLAY_PATH;
  else process.env.OVERLAY_PATH = OVERLAY_PRIOR;
});

function seededDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'lease-run-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedLeaseTerms(db, SYNTHETIC_LEASE_TERM_SEEDS);
  return db;
}

/** Insert ONE committed full-year revenue ledger row for a real property — a deterministic
 *  cohort seed for the benchmarks engine (decoupled from the fuzzy ingest-detection path, which
 *  is exercised by the ingest tests, not this one). propertyPeriodMetrics reads is_active ledger
 *  rows joined to property_master.rentable_sf, so this yields a real revenuePerSf cohort point. */
function insertRevenueLedgerRow(db: WarehouseDb, propertyId: string, year: string, revenue: number): void {
  const batch = db.prepare(
    `INSERT INTO import_batches
       (file_name, file_hash, raw_path, imported_at, property_id, period_start, period_end,
        period_grain, basis, source_system, version, status, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'year', 'cash', 'test', 1, 'committed', 0.99)`,
  ).run(
    `cohort-${propertyId}-${year}.xlsx`,
    `hash-${propertyId}-${year}`,
    `raw/${propertyId}-${year}`,
    '2026-06-12T00:00:00Z',
    propertyId,
    `${year}-01-01`,
    `${year}-12-31`,
  );
  db.prepare(
    `INSERT INTO ledger_entries
       (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
     VALUES (?, ?, ?, 'Rent', '5064', ?, 'Rental Revenue', 'revenue', 1)`,
  ).run(batch.lastInsertRowid, propertyId, year, revenue);
}

/** A real revenue-per-SF cohort ABOVE Fishel's in-place $4.27/SF, so the mark-to-market chip
 *  fires off the genuine benchmarks engine. Rarig (21,000 SF) @ 120,000 → $5.71/SF;
 *  Westerville (18,000 SF) @ 110,000 → $6.11/SF; median ≈ $5.91/SF. */
function seededDbWithCohort(): WarehouseDb {
  const db = seededDb();
  insertRevenueLedgerRow(db, '1100-rarig-ave-columbus-oh', '2025', 120000);
  insertRevenueLedgerRow(db, '3034-westerville-rd-columbus-oh', '2025', 110000);
  return db;
}

describe('lease_terms migration + seed round-trip', () => {
  it('seeds two properties, each reading back to the dollar after the SQLite JSON round-trip', () => {
    const db = seededDb();
    expect(listLeaseTermPropertyIds(db).sort()).toEqual([SUNBURST, FISHEL].sort());

    const fishel = getLeaseTerms(db, FISHEL);
    expect(fishel).toHaveLength(1);
    const proj = projectLeaseRun(fishel[0]!, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(proj.stabilizedNoi).toBeCloseTo(85446, 2);
    expect(proj.indicativeValue).toBeCloseTo(1068075, 2);

    const sun = getLeaseTerms(db, SUNBURST)[0]!;
    const sp = projectLeaseRun(sun, DEFAULT_LEASE_RUN_ASSUMPTIONS);
    expect(sp.rentableSf).toBe(5130);
    expect(sp.stabilizedNoi).toBeCloseTo(67130.5, 2);
    expect(sp.indicativeValue).toBeCloseTo(839131.25, 2);
  });

  it('re-seeding is idempotent (UPSERT, not duplicate rows)', () => {
    const db = seededDb();
    seedLeaseTerms(db, SYNTHETIC_LEASE_TERM_SEEDS);
    seedLeaseTerms(db, SYNTHETIC_LEASE_TERM_SEEDS);
    expect(getLeaseTerms(db, FISHEL)).toHaveLength(1);
    expect(listLeaseTermPropertyIds(db)).toHaveLength(2);
  });

  it('a property with no lease terms reads back empty (no crash)', () => {
    const db = seededDb();
    expect(getLeaseTerms(db, '1100-rarig-ave-columbus-oh')).toEqual([]);
  });
});

describe('GET /analytics/lease-run/:propertyId', () => {
  it('returns a Zod-valid envelope reconciling to the dollar (Fishel)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run/${FISHEL}`);
    expect(res.status).toBe(200);
    const body = LeaseRunProjectionEnvelope.parse(await res.json());
    expect(body.propertyId).toBe(FISHEL);
    expect(body.stabilizedNoi).toBeCloseTo(85446, 2);
    expect(body.indicativeValue).toBeCloseTo(1068075, 2);
    // Opt-2 rows are flagged as data, not assumptions.
    expect(body.periods.some((p) => p.isAssumption)).toBe(false);
  });

  it('flags Sunburst option_assumed rows as assumptions in the envelope', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run/${SUNBURST}`);
    const body = LeaseRunProjectionEnvelope.parse(await res.json());
    const ly34 = body.periods.find((p) => p.leaseYearLabel === "LY '34")!;
    expect(ly34.isAssumption).toBe(true);
    expect(ly34.status).toBe('option_assumed');
  });

  it('an unknown / no-terms property → typed empty projection, 200 (no crash)', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run/no-such-property`);
    expect(res.status).toBe(200);
    const body = LeaseRunProjectionEnvelope.parse(await res.json());
    expect(body.isEmpty).toBe(true);
    expect(body.periods).toEqual([]);
    expect(body.stabilizedNoi).toBeNull();
  });

  it('503 when the warehouse is unavailable', async () => {
    const app = warehouseRoutes(() => {
      throw new Error('cold');
    });
    const res = await app.request(`/analytics/lease-run/${FISHEL}`);
    expect(res.status).toBe(503);
  });
});

describe('GET /analytics/lease-run (ownership rollup)', () => {
  it('aggregates forward NOI + indicative value across all properties with lease terms', async () => {
    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run`);
    expect(res.status).toBe(200);
    const body = LeaseRunRollupResponse.parse(await res.json());
    expect(body.summaries).toHaveLength(2);
    // total stabilized NOI = 67,130.50 + 85,446 = 152,576.50 (synthetic roster).
    expect(body.totalStabilizedNoi).toBeCloseTo(67130.5 + 85446, 1);
    // total indicative value = 839,131.25 + 1,068,075.
    expect(body.totalIndicativeValue).toBeCloseTo(839131.25 + 1068075, 1);
    const fishel = body.summaries.find((s) => s.propertyId === FISHEL)!;
    expect(fishel.rolloverLabels.length).toBeGreaterThan(0);
  });
});

describe('overlay assumptions flow through to the engine via the route (adversarial #6)', () => {
  // OVERLAY_PATH is set to a fresh empty file per test by the top-level beforeEach.
  it('a persisted cap-rate override changes the indicative value (NOT the stale default)', async () => {
    // Persist a 6% cap (vs the 8% default) for Fishel. setLeaseRunAssumptions is async
    // (awaits the overlay write); without await the route's synchronous loadOverlay races
    // the pending write and reads the empty overlay → stale 8% default (flaky pre-await).
    await setLeaseRunAssumptions(FISHEL, { indicativeCapRate: 0.06 });

    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run/${FISHEL}`);
    const body = LeaseRunProjectionEnvelope.parse(await res.json());
    expect(body.assumptions.indicativeCapRate).toBeCloseTo(0.06, 6);
    expect(body.assumptionsAreDefault).toBe(false);
    // Stabilized NOI is unchanged (85,446); only the cap divisor moves:
    // 85,446 / 0.06 = 1,424,100 (NOT the 8%-default 1,068,075).
    expect(body.stabilizedNoi).toBeCloseTo(85446, 2);
    expect(body.indicativeValue).toBeCloseTo(85446 / 0.06, 1);
  });

  it('a persisted vacancy override flows into per-period EGR', async () => {
    await setLeaseRunAssumptions(FISHEL, { vacancyCreditLossPct: 0.05 });

    const db = seededDb();
    const app = warehouseRoutes(() => db);
    const body = LeaseRunProjectionEnvelope.parse(await (await app.request(`/analytics/lease-run/${FISHEL}`)).json());
    const ly26 = body.periods.find((p) => p.leaseYearLabel === "LY '26")!;
    expect(ly26.egr).toBeCloseTo(90000 * 0.95, 2);
  });
});

describe('mark-to-market chip fires through the real route off the benchmarks cohort', () => {
  it("Fishel's $3.75/SF in-place rent is flagged below-market against the ingested cohort", async () => {
    const db = seededDbWithCohort();
    const app = warehouseRoutes(() => db);
    const res = await app.request(`/analytics/lease-run/${FISHEL}`);
    expect(res.status).toBe(200);
    const body = LeaseRunProjectionEnvelope.parse(await res.json());
    expect(body.markToMarket).not.toBeNull();
    expect(body.markToMarket!.cohortN).toBeGreaterThan(0);
    expect(body.markToMarket!.belowMarket).toBe(true);
    expect(body.markToMarket!.upsidePct!).toBeGreaterThan(0);
    // The rollup summary mirrors the chip.
    const rollup = LeaseRunRollupResponse.parse(await (await app.request(`/analytics/lease-run`)).json());
    expect(rollup.summaries.find((s) => s.propertyId === FISHEL)!.belowMarket).toBe(true);
  });
});
