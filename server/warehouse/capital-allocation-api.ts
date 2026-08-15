// server/warehouse/capital-allocation-api.ts
//
// Phase 5 Capital Allocation + Market Intelligence API sub-router.
// Routes:
//   GET /allocate — buildPortfolioAllocation(); wraps as CapitalAllocationResponse
//   GET /market   — buildMarketIntel() per cluster; wraps as MarketIntelResponse
//
// Registration: server/index.ts mounts at /api/warehouse/capital.
// Pattern: mirrors debt-api.ts (Hono factory + withDb 503 guard).
// No financial math lives here; math is in capital-allocation.ts and market-intel.ts.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildPortfolioAllocation } from './capital-allocation';
import { buildMarketIntel } from './market-intel';
import { loadCapitalConfig } from './capital-config';
import { getMacro } from '../macro/getMacro';
import {
  CapitalAllocationResponse,
  MarketIntelResponse,
  HurdleRateConfig,
} from '../../src/contracts/capital';
import { verdictsFromAllocations, logVerdicts, computeInputsVersion } from './calibration';
import { referenceDate } from '../config';
import type { AllocationVerdict } from '../../src/contracts/capital';

/**
 * Round 19g (adversarial refute, MEDIUM-HIGH — reproduced on a surface no prior round had
 * reviewed): calibration_verdict is a SECOND permanent, append-only history — later resolved
 * against realized outcomes by resolveDueOutcomes — that got neither of debt_scores' two
 * protections (a write gate, a provenance column). Migration 027's own doctrine: "a row written
 * before the gate existed is indistinguishable from a clean-book observation, forever."
 * Reproduced: a distrusted verdict's dedupKey (subjectKind|subjectId|verdictKind|verdictSubkind
 * |asOfPeriod|inputsVersion) contains no trust/action/confidence component, so `INSERT OR IGNORE`
 * on the SAME key after the book heals silently discards the corrected verdict — the firm's own
 * calibration statistics get permanently scored against a verdict that was never a real
 * prediction. Extracted as a standalone function (rather than inlined at the call site) so it is
 * directly unit-testable without needing a full ledger-seeded PropertyScore to reach it.
 */
// Round 8 fresh-sweep (adversarial refute, MEDIUM-HIGH -- reproduced): a naive bookTrust==='trusted'
// filter also silently dropped every 'buy' verdict, forever, even on a fully trusted book.
// buildBuyVerdict (capital-allocation.ts) hardcodes inputs.bookTrust:'unknown' for pipeline
// candidates BY DESIGN -- a buy verdict isn't tied to an owned property, so no debt book describes
// it (see that function's own docblock). That 'unknown' means "not applicable," not "distrusted,"
// but this filter read the same enum value as a trust failure and discarded the verdict before it
// ever reached logVerdicts -- silently killing the calibration flywheel's entire acquisition-
// prediction history with no log line, no dataQuality flag, nothing. Reproduced: a trusted book +
// a T1 pipeline candidate scoring 80 produced action:'buy', inputs.bookTrust:'unknown'; the old
// filter dropped it. 'buy' verdicts are exempted here rather than given a distinct trust value, to
// avoid widening AllocationVerdict.inputs.bookTrust's meaning per-action.
export function filterTrustedVerdicts(verdicts: AllocationVerdict[]): AllocationVerdict[] {
  return verdicts.filter((v) => v.action === 'buy' || v.inputs.bookTrust === 'trusted');
}

// ── Cluster enumeration ──────────────────────────────────────────────────────────────────────

interface ClusterRow { cluster: string }

/** All clusters known to the system: property_master markets ∪ market_series clusters. */
function listClusters(db: WarehouseDb): string[] {
  const fromProperties = (db.prepare(
    `SELECT DISTINCT market AS cluster FROM property_master WHERE market IS NOT NULL`,
  ).all() as ClusterRow[]).map((r) => r.cluster);

  const fromSeries = (db.prepare(
    `SELECT DISTINCT cluster FROM market_series`,
  ).all() as ClusterRow[]).map((r) => r.cluster);

  // Deduplicate
  return [...new Set([...fromProperties, ...fromSeries])];
}

// ── Router factory ───────────────────────────────────────────────────────────────────────────

export function capitalAllocationApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>) => {
    let db: WarehouseDb;
    try { db = getDb(); }
    catch {
      return Promise.resolve(new Response(
        JSON.stringify({ error: 'warehouse unavailable' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ));
    }
    return handler(db);
  };

  // GET /allocate
  app.get('/allocate', (c) => withDb(async (db) => {
    try {
      // referenceDate() (see server/config.ts) — NOT a raw UTC slice; this asOf anchors real
      // date math inside buildPortfolioAllocation -> scoreDebtPositions' fresh maturity recompute,
      // and REPORT_DATE-pins for deterministic tests like every other reference-date call site.
      const asOf = referenceDate();
      // Spine A snapshot is optional here (fail-open): a missing snapshot just means
      // expectedReturnPct stays null for every verdict, same as pre-v2 behavior.
      const { brain } = await import('../brain');
      const snapshot = await brain.getSnapshot();
      const portfolio = await buildPortfolioAllocation(db, asOf, undefined, snapshot ?? undefined);
      const cfg = loadCapitalConfig(db);
      const hurdleRate = HurdleRateConfig.parse({
        hurdleRatePct: cfg.hurdleRatePct,
        ratification: cfg.hurdleRateRatification,
        ratifiedBy: cfg.hurdleRateRatifiedBy,
        ratifiedDate: cfg.hurdleRateRatifiedDate,
        capitalConfigVersion: cfg.version,
      });
      const response = CapitalAllocationResponse.parse({
        asOf,
        hurdleRate,
        advisoryOnly: portfolio.advisoryOnly,
        portfolio,
      });
      // Log calibration verdicts — fail-open (never blocks the response). See
      // filterTrustedVerdicts' docblock above for why distrusted verdicts are excluded.
      try {
        const iv = computeInputsVersion(db);
        const trustedVerdicts = filterTrustedVerdicts(portfolio.verdicts);
        const calibVerdicts = verdictsFromAllocations(trustedVerdicts, iv, 'capital-allocation-api');
        logVerdicts(db, calibVerdicts);
      } catch {
        // calibration logging is observational; failure must not 500 the route
      }
      return c.json(response);
    } catch (err) {
      console.error('[capital-api] /allocate error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'capital allocation failed' }, 500);
    }
  }));

  // GET /market
  app.get('/market', (c) => withDb(async (db) => {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const clusters = listClusters(db);
      const macro = await getMacro().catch(() => undefined);
      const settled = await Promise.allSettled(
        clusters.map((cl) => buildMarketIntel(db, cl, asOf, macro)),
      );
      const signals = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof buildMarketIntel>>> => r.status === 'fulfilled')
        .map((r) => r.value);
      return c.json(MarketIntelResponse.parse({ asOf, signals }));
    } catch (err) {
      console.error('[capital-api] /market error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'market intel failed' }, 500);
    }
  }));

  return app;
}
