// @vitest-environment node
//
// tests/unit/lease-forecast-api.test.ts
//
// server/warehouse/lease-forecast-api.ts sub-router tests -- previously 0% coverage despite
// 4 routes with real aggregation logic (expiry-bucket totals, rent-forecast scenarios,
// narrative anonymization). Error policy mirrors debt-api.ts (see debt-api.test.ts).
//
// server/brain.ts is mocked wholesale (real fs/chokidar side effects at module scope), matching
// the pattern in insights-api.test.ts / tax-analysis.test.ts -- this exercises the exact same
// dynamic `await import('../brain')` acquisition pattern the route uses in production.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { leaseForecastApi } from '../../server/warehouse/lease-forecast-api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { LeaseForecastResponse, RentForecastResponse, LeaseNarrativeResponse } from '@contracts/lease-forecast';
import type { PortfolioSnapshot, Property, Lease } from '@contracts/index';

vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn() },
}));
import { brain } from '../../server/brain';

vi.mock('../../server/ai/narrative', () => ({
  composeLeaseNarrative: vi.fn(),
}));
import { composeLeaseNarrative } from '../../server/ai/narrative';
const mockComposeLeaseNarrative = vi.mocked(composeLeaseNarrative);
const mockGetSnapshot = vi.mocked(brain.getSnapshot);

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

const ASOF = '2026-06-21';

// The routes now derive expiry buckets / renewal signals / rent-forecast horizons off the RUN
// date (referenceDate(), portfolio-wide run-date basis). Pin REPORT_DATE to a fixed date
// DELIBERATELY ≠ the fixture's meta.asOf (ASOF, 2026-06-21) so these route-level tests LOCK the
// run-date wiring: with refDate === meta.asOf a silent revert of the route's refDate plumbing back
// to meta.asOf would still pass. 2026-08-21 is two months after the data date; the run-date lock
// test below relies on that gap. Fixed date → deterministic; production uses the true run date, and
// the response `asOf` label stays on meta.asOf (data-snapshot date) either way.
const RUN_DATE = '2026-08-21';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = RUN_DATE; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-21T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF,
    },
    properties: [] as Property[], leases: [] as Lease[], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {} as Record<string, string>, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    tenantArrears: {},
    marketRents: {} as Record<string, number>,
    acquisitionInputs: {},
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}

function mkLease(o: Partial<Lease> & { id: string }): Lease {
  return {
    propertyKey: 'Fixture Property One',
    propertyId: 'fixture-property-one',
    tenantName: 'Fixture Tenant',
    unit: null,
    company: 'Fixture Co',
    sf: 10000,
    monthlyRent: 1000,
    rentPerSf: 1.2,
    leaseStart: '2022-06-21',
    leaseEnd: '2027-06-21',
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 12000,
    monthsToExpiry: 12,
    flags: [],
    ...o,
  };
}

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'lease-forecast-api-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function makeApp(db: WarehouseDb) {
  return leaseForecastApi(() => db);
}

function makeAppUnavailableDb() {
  return leaseForecastApi(() => {
    throw new Error('warehouse unavailable in test');
  });
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

// ── GET /forecast ─────────────────────────────────────────────────────────────────────────

describe('GET /forecast', () => {
  it('503s when the warehouse is unavailable', async () => {
    const app = makeAppUnavailableDb();
    const res = await app.request('/forecast');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('503s when there is no parsed snapshot yet', async () => {
    mockGetSnapshot.mockReturnValue(null);
    const app = makeApp(freshDb());
    const res = await app.request('/forecast');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'snapshot unavailable' });
  });

  it('200s with signals/velocity/marketGaps/bucketTotals validating the response contract', async () => {
    mockGetSnapshot.mockReturnValue(
      snap({ leases: [mkLease({ id: 'l1' }), mkLease({ id: 'l2', leaseEnd: null, monthsToExpiry: null, status: 'Expired' })] }),
    );
    const app = makeApp(freshDb());
    const res = await app.request('/forecast');
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = LeaseForecastResponse.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.signals).toHaveLength(2);
      // Every declared bucket is present even when its count is zero.
      const buckets = parsed.data.bucketTotals.map((b) => b.bucket);
      expect(buckets).toEqual(['0-6m', '6-12m', '12-24m', '24m+', 'expired', 'unknown']);
      const total = parsed.data.bucketTotals.reduce((s, b) => s + b.count, 0);
      expect(total).toBe(2);
    }
  });

  it('500s and reports a stable error shape when an unexpected error is thrown', async () => {
    mockGetSnapshot.mockImplementation(() => {
      throw new Error('boom');
    });
    const app = makeApp(freshDb());
    const res = await app.request('/forecast');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'lease forecast failed' });
  });

  it('RUN-DATE WIRING LOCK: buckets a lease that ended AFTER meta.asOf but BEFORE the run date as expired (run-date basis), while the response asOf label stays on meta.asOf', async () => {
    // leaseEnd 2026-07-15 sits between meta.asOf (ASOF 2026-06-21) and the pinned run date
    // (RUN_DATE 2026-08-21). monthsToExpiry 0 is the workbook calendar-truncation value; only the
    // date comparison distinguishes the two bases:
    //   • run-date basis (2026-08-21): leaseEnd < run date → 'expired'
    //   • meta.asOf basis (2026-06-21): leaseEnd > asOf, mte 0 → '0-6m'
    // So a revert of the route's refDate plumbing to meta.asOf would move this lease from
    // 'expired' → '0-6m' and fail the assertions below.
    mockGetSnapshot.mockReturnValue(
      snap({ leases: [mkLease({ id: 'lapsed', leaseEnd: '2026-07-15', monthsToExpiry: 0, annualRent: 24_000, status: 'Active' })] }),
    );
    const app = makeApp(freshDb());
    const res = await app.request('/forecast');
    expect(res.status).toBe(200);
    const parsed = LeaseForecastResponse.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      const byBucket = Object.fromEntries(parsed.data.bucketTotals.map((b) => [b.bucket, b]));
      // Run-date classification: the lapsed lease lands in 'expired', NOT '0-6m'.
      expect(byBucket.expired!.count).toBe(1);
      expect(byBucket.expired!.expiringRent).toBe(24_000);
      expect(byBucket['0-6m']!.count).toBe(0);
      // The renewal signal agrees (run-date basis): lease end passed → lapsing, expiryBucket expired.
      expect(parsed.data.signals[0]!.expiryBucket).toBe('expired');
      expect(parsed.data.signals[0]!.likelihood).toBe('lapsing');
      // Label/day-count SPLIT: the response asOf label remains the workbook data date (meta.asOf),
      // even though the buckets above were classified against the run date.
      expect(parsed.data.asOf).toBe(ASOF);
    }
  });

  it('C: does not 500 when the lease-market feed read fails on an otherwise-available warehouse -- degrades to marketGaps without derived-asking rows', async () => {
    const db = freshDb();
    // lm_market_rent_feed exists (migration ran) but drop it so loadMarketRentFeed's query throws --
    // simulating a feed-read error distinct from "warehouse unavailable" (getDb() itself still succeeds).
    db.exec('DROP TABLE lm_market_rent_feed');
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp(db);
    const res = await app.request('/forecast');
    expect(res.status).toBe(200);
    const parsed = LeaseForecastResponse.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.marketGaps.every((g) => g.provenance !== 'derived-asking')).toBe(true);
    }
    expect(warnSpy).toHaveBeenCalledWith('[lease-forecast-api] lease-market feed unavailable:', expect.stringContaining('lm_market_rent_feed'));
    warnSpy.mockRestore();
  });
});

// ── GET /velocity ─────────────────────────────────────────────────────────────────────────

describe('GET /velocity', () => {
  it('503s when the warehouse is unavailable', async () => {
    const app = makeAppUnavailableDb();
    const res = await app.request('/velocity');
    expect(res.status).toBe(503);
  });

  it('tolerates a null snapshot (unlike /forecast) and returns an empty velocity array', async () => {
    mockGetSnapshot.mockReturnValue(null);
    const app = makeApp(freshDb());
    const res = await app.request('/velocity');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ velocity: [] });
  });

  it('200s with a velocity entry per property, reading real lease_events rows', async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`,
    ).run('fixture-property-one', 'Suite A', 'vacate', '2026-01-01');
    db.prepare(
      `INSERT INTO lease_events (property_id, suite, event_kind, event_date) VALUES (?, ?, ?, ?)`,
    ).run('fixture-property-one', 'Suite A', 'commence', '2026-02-01');
    mockGetSnapshot.mockReturnValue(
      snap({ properties: [{ id: 'fixture-property-one', name: 'Fixture Property One' } as Property] }),
    );
    const app = makeApp(db);
    const res = await app.request('/velocity');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { velocity: unknown[] };
    expect(body.velocity).toHaveLength(1);
  });
});

// ── POST /rent-forecast ───────────────────────────────────────────────────────────────────

describe('POST /rent-forecast', () => {
  it('503s when there is no parsed snapshot yet', async () => {
    mockGetSnapshot.mockReturnValue(null);
    const app = makeApp(freshDb());
    const res = await app.request('/rent-forecast', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('defaults to all three scenarios when the body omits `scenarios`', async () => {
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const app = makeApp(freshDb());
    const res = await app.request('/rent-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const parsed = RentForecastResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results.map((r) => r.scenario).sort()).toEqual(
        ['renew_at_current', 'renew_at_market', 'vacancy_haircut'].sort(),
      );
    }
  });

  it('tolerates an unparseable JSON body by falling back to defaults (not a 400)', async () => {
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const app = makeApp(freshDb());
    const res = await app.request('/rent-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(res.status).toBe(200);
  });

  it('400s on an invalid scenario name (Zod parse failure), short-circuiting the request', async () => {
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const app = makeApp(freshDb());
    const res = await app.request('/rent-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarios: ['not_a_real_scenario'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid input/);
  });

  it('CRITICAL (fix round 1 ruling A): never uses the lease-market asking-rent feed for the renew_at_market NOI projection — manual overlay marketRents only', async () => {
    const db = freshDb();
    // A feed row for the fixture lease's property, well above its in-place rentPerSf (1.2), so if
    // it leaked into rentForecast's market lookup the delta/NOI impact would be large and nonzero.
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES (?, 50, 'similarity', 'MEDIUM', 'k', 12, '2026-03-01')`,
    ).run('Fixture Property One');
    // No overlay.marketRents entry for this lease/property — only the feed has a figure.
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1', monthsToExpiry: 3, annualRent: 12000, sf: 10000 })] }));
    const app = makeApp(db);
    const res = await app.request('/rent-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarios: ['renew_at_market'] }),
    });
    expect(res.status).toBe(200);
    const parsed = RentForecastResponse.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      const result = parsed.data.results[0]!;
      // The asking rent never gets in -- the lease is held at current, not reset to the $50/SF feed figure.
      expect(result.deltaUsd).toBe(0);
      expect(result.noiImpactAnnualUsd).toBe(0);
      expect(result.assumptions.join(' | ')).toContain('no market rent in overlay');
    }
  });

  it('honors an explicit single-scenario request', async () => {
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const app = makeApp(freshDb());
    const res = await app.request('/rent-forecast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarios: ['renew_at_current'], horizonMonths: 24 }),
    });
    expect(res.status).toBe(200);
    const parsed = RentForecastResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(1);
      expect(parsed.data.results[0]!.scenario).toBe('renew_at_current');
      expect(parsed.data.results[0]!.horizonMonths).toBe(24);
    }
  });
});

// ── GET /narrative ────────────────────────────────────────────────────────────────────────

describe('GET /narrative', () => {
  it('503s when there is no parsed snapshot yet', async () => {
    mockGetSnapshot.mockReturnValue(null);
    const app = makeApp(freshDb());
    const res = await app.request('/narrative');
    expect(res.status).toBe(503);
  });

  it('200s with degraded:true and no narrative when ANTHROPIC_API_KEY is unset (no live AI call)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    mockComposeLeaseNarrative.mockResolvedValue({ narrative: null, degraded: true });
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1' })] }));
    const app = makeApp(freshDb());
    const res = await app.request('/narrative');
    expect(res.status).toBe(200);
    const parsed = LeaseNarrativeResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.degraded).toBe(true);
      expect(parsed.data.narrative).toBeNull();
    }
  });

  it('anonymizes propertyKey to ordinal gap-N labels in the payload sent to the AI composer (invariant 7)', async () => {
    // Inspects the ACTUAL object passed to composeLeaseNarrative -- not just the route's own
    // response body -- since a response-body-only check cannot distinguish "anonymized before
    // send" from "never sent at all" (both look identical from the outside when degraded).
    process.env.ANTHROPIC_API_KEY = 'fixture-key-not-real';
    mockComposeLeaseNarrative.mockResolvedValue({ narrative: null, degraded: true });
    mockGetSnapshot.mockReturnValue(
      snap({
        leases: [mkLease({ id: 'l1', propertyKey: 'Real Sounding Property Name', rentPerSf: 10 })],
        marketRents: { 'Real Sounding Property Name': 15 },
      }),
    );
    const app = makeApp(freshDb());
    const res = await app.request('/narrative');
    expect(res.status).toBe(200);

    expect(mockComposeLeaseNarrative).toHaveBeenCalledTimes(1);
    const sentInput = mockComposeLeaseNarrative.mock.calls[0]![0] as { topGaps: { propertyKey: string }[] };
    expect(sentInput.topGaps.length).toBeGreaterThan(0);
    for (const gap of sentInput.topGaps) {
      expect(gap.propertyKey).toMatch(/^gap-\d+$/);
    }
    expect(JSON.stringify(sentInput)).not.toContain('Real Sounding Property Name');
  });

  it('IMPORTANT (fix round 1 ruling B): excludes derived-asking (lease-market feed) gaps from topGaps sent to the AI composer', async () => {
    process.env.ANTHROPIC_API_KEY = 'fixture-key-not-real';
    mockComposeLeaseNarrative.mockResolvedValue({ narrative: null, degraded: true });
    const db = freshDb();
    // Only a feed row exists for this property -- no overlay.marketRents entry -- so the ONLY gap
    // marketRentGaps can produce for this lease is provenance 'derived-asking'.
    db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, comp_basis, confidence, cell_key, n, computed_at) VALUES (?, 15, 'similarity', 'MEDIUM', 'k', 12, '2026-03-01')`,
    ).run('Fixture Property One');
    mockGetSnapshot.mockReturnValue(snap({ leases: [mkLease({ id: 'l1', rentPerSf: 10 })] }));
    const app = makeApp(db);
    const res = await app.request('/narrative');
    expect(res.status).toBe(200);

    expect(mockComposeLeaseNarrative).toHaveBeenCalledTimes(1);
    const sentInput = mockComposeLeaseNarrative.mock.calls[0]![0] as { topGaps: unknown[] };
    // The AI must never describe an asking-rent-derived gap as a market gap.
    expect(sentInput.topGaps).toHaveLength(0);
  });
});
