// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { CapitalAllocationResponse, MarketIntelResponse } from '../../src/contracts/capital';

vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockResolvedValue({
    asOf: '2026-06-21',
    source: 'mock' as const,
    indicators: [
      { id: 'DGS5', label: '5Y Treasury', value: 4.2, unit: '%', change: null },
      { id: 'DGS10', label: '10Y Treasury', value: 4.5, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI', value: 3.2, unit: '%', change: null },
    ],
    tenYearHistory: [],
  }),
}));

const openedDbs: ReturnType<typeof openWarehouse>[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-api-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  seedPropertyMaster(db);
  openedDbs.push(db);
  return db;
}

describe('capitalAllocationApi', () => {
  // Root cause (2026-07-12, systematic-debugging): the /allocate route dynamically
  // `import('../brain')`s on the hot path (server/warehouse/capital-allocation-api.ts).
  // With per-file isolation (vitest.config.ts `isolate: true`), this file's module
  // registry is fresh, so R-1 pays that dynamic import's full module-resolution/
  // compile/eval cost INSIDE the timed test body on its first call -- measured at
  // 1278ms standalone (plain node, no vitest overhead) and up to 5000ms+ under
  // concurrent suite load, occasionally exceeding the 5s test timeout that was the
  // default when this was written (vitest.config.ts now sets 60s globally).
  // brain.ts pulls in chokidar + workbook parsing + quickbooks + contracts/index --
  // a real module-load cost, not a bug in the route's own logic (confirmed: imports,
  // openWarehouse migrations, and seedPropertyMaster together cost ~126ms; the dynamic
  // import + snapshot lookup is the other ~1.1s+).
  // Fix: pay that cost once here, in beforeAll (untimed setup), not inside a timed
  // `it(...)`. This does not touch the route handler -- the dynamic-import pattern is
  // used identically in 5 other files (api.ts x3, insights-api.ts, lease-forecast-api.ts,
  // tax-api.ts) with no documented reason it must be dynamic rather than static, so
  // changing the import style itself is a separate, wider decision than this test fix.
  // Round 8 fresh-sweep (adversarial refute, MEDIUM — corroborated by two independent lenses):
  // the then-default 10s hook timeout intermittently expired under full-suite parallel-fork load
  // (2 of 3 full runs), skipping ALL tests in this file -- including R-5, the calibration-history
  // regression gate for round 8's filterTrustedVerdicts fix. Explicit generous timeout so a loaded
  // CI runner doesn't silently drop CI's only coverage of that gate.
  beforeAll(async () => {
    await import('../../server/brain');
  }, 60_000);

  afterEach(() => {
    for (const db of openedDbs) db.close();
    openedDbs.length = 0;
    vi.clearAllMocks();
  });

  it('R-1: GET /allocate → 200 with valid CapitalAllocationResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = CapitalAllocationResponse.parse(await res.json());
    expect(typeof body.hurdleRate.hurdleRatePct).toBe('number');
  });

  it('R-2: GET /market → 200 with valid MarketIntelResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/market');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = MarketIntelResponse.parse(await res.json());
    expect(Array.isArray(body.signals)).toBe(true);
  });

  it('R-3: warehouse unavailable → 503', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const router = capitalAllocationApi(() => { throw new Error('no warehouse'); });
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(503);
  });

  it('R-4: ratified hurdle config → advisoryOnly=false', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    // Default compile-time fallback has hurdleRateRatification='ratified' (ratified 2026-06-22)
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    const obj = body as Record<string, unknown> | undefined;
    expect(obj?.['advisoryOnly']).toBe(false);
  });

  // Round 19g (adversarial refute, MEDIUM-HIGH — reproduced on a surface no prior round had
  // reviewed): calibration_verdict is a SECOND permanent, append-only history — later resolved
  // against realized outcomes — that got neither of debt_scores' two protections (a write gate, a
  // provenance column). A distrusted verdict's dedupKey has no trust component, so INSERT OR
  // IGNORE on the same key after the book heals silently discards the corrected verdict, and the
  // firm's calibration statistics get permanently scored against a verdict that was never real.
  //
  // filterTrustedVerdicts is tested directly (a real verdict from buildPortfolioAllocation
  // requires a full ledger-seeded PropertyScore, which is out of scope for this route-level
  // suite) — this pins the actual gate the route calls, not a re-implementation of it.
  it('R-5: filterTrustedVerdicts excludes every non-trusted verdict, keeps trusted ones', async () => {
    const { filterTrustedVerdicts } = await import('../../server/warehouse/capital-allocation-api');
    const base = {
      propertyName: null, period: '2026', expectedReturnPct: null, returnAboveHurdle: null,
      riskBand: 'moderate' as const, timelineMonths: 12, horizonPeriods: 0, confidence01: 0.5,
      confidenceTier: 'estimated' as const, advisoryOnly: false, reasons: [], dataQuality: [],
      inputs: {
        healthBand: 'good' as const, attentionBand: 'green' as const, capitalAction: 'hold' as const,
        debtSignal: 'hold' as const, debtScoreBand: 'adequate' as const, dscr: null, dscrHeadroom: null,
        ltv: null, noiPerSf: null, forecastPresent: false, bookTrust: 'trusted' as const,
      },
    };
    const trusted = { ...base, propertyId: 'p-trusted', action: 'hold' as const };
    const degraded = {
      ...base, propertyId: 'p-degraded', action: 'refinance' as const,
      inputs: { ...base.inputs, bookTrust: 'degraded' as const, debtSignal: 'refi' as const },
    };
    const unknown = {
      ...base, propertyId: 'p-unknown', action: 'hold' as const,
      inputs: { ...base.inputs, bookTrust: 'unknown' as const },
    };
    const refused = {
      ...base, propertyId: 'p-refused', action: 'hold' as const,
      inputs: { ...base.inputs, bookTrust: 'refused' as const },
    };
    // Round 8 fresh-sweep (adversarial refute, MEDIUM-HIGH -- reproduced): buildBuyVerdict
    // hardcodes bookTrust:'unknown' for pipeline candidates BY DESIGN -- "not applicable" (no
    // owned debt book describes an unowned pipeline candidate), not a real trust failure. A naive
    // filter dropped this verdict forever, even on a fully trusted book -- silently killing the
    // calibration flywheel's entire acquisition-prediction history.
    const buyPipeline = {
      ...base, propertyId: 'pipeline:cand-1', action: 'buy' as const,
      inputs: { ...base.inputs, bookTrust: 'unknown' as const },
    };

    const kept = filterTrustedVerdicts([trusted, degraded, unknown, refused, buyPipeline]);
    expect(kept.map((v) => v.propertyId)).toEqual(['p-trusted', 'pipeline:cand-1']);
  });
});
