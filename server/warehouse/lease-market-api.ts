// server/warehouse/lease-market-api.ts
//
// Lease Market Intelligence — Hono sub-router mounted at /api/warehouse/lease-market (sub-routers.ts).
// Routes: GET /summary · /positioning · /radar · /signals · /changes · /history/:listingId · POST /radar/decision.
// Pure route plumbing (math in src/analytics/lease-market/* and server/warehouse/lease-market/*); listed in
// DELIVERY_ONLY_PATHS. CoStar-derived rows are internal-only; config.mirrorRowLevel=false redacts identifiers.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { referenceDate } from '../config';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarDecisionInput, RadarDecisionResponse,
  RadarResponse, SignalsResponse,
  type CellBenchmark, type CurvePoint, type EvidenceValue, type LeaseMarketConfig, type ListingEventKind, type RadarCandidate,
  type RadarDecisionKind, type SignalRow,
} from '../../src/contracts/lease-market';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { toCellBenchmark } from '../../src/analytics/lease-market/benchmarks';
import { loadLeaseMarketConfig } from './lease-market/config';
import {
  domBins, isActive, latestExportEvents, leaseMarketKpis, loadMarketState, marketDataQuality, marketFreshness, withheldCandidateMarkets,
} from './lease-market/compute';
import { computePositioning } from './lease-market/positioning';

export interface LeaseMarketApiDeps {
  loadConfig?: () => LeaseMarketConfig;
  getSnapshot?: () => Promise<PortfolioSnapshot | null>;
  now?: () => string;
}

async function liveSnapshot(): Promise<PortfolioSnapshot | null> {
  const { brain } = await import('../brain'); // dynamic import avoids a load-time cycle (same as lease-forecast-api.ts)
  return brain.getSnapshot();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REDACTED_EVIDENCE_KEYS = ['address', 'ownerName', 'brokerName'] as const;

interface SignalDbRow {
  id: number; property_id: number; listing_id: number | null; kind: SignalRow['kind']; severity: SignalRow['severity']; score: number | null;
  confidence: SignalRow['confidence']; comp_basis: SignalRow['compBasis']; cell_key: string | null; computed_at: string; evidence_json: string;
  market_id: string; address_display: string; suite_norm: string | null;
}

export function leaseMarketApi(getDb: () => WarehouseDb, deps: LeaseMarketApiDeps = {}): Hono {
  const app = new Hono();
  const loadConfig = deps.loadConfig ?? (() => loadLeaseMarketConfig());
  const getSnapshot = deps.getSnapshot ?? liveSnapshot;
  const now = deps.now ?? (() => new Date().toISOString());

  async function guarded(handler: (db: WarehouseDb, config: LeaseMarketConfig) => Response | Promise<Response>): Promise<Response> {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return json(503, { error: 'warehouse unavailable' });
    }
    let config: LeaseMarketConfig;
    try {
      config = loadConfig();
    } catch (e) {
      return json(500, { error: `lease-market config invalid: ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      return await handler(db, config);
    } catch (e) {
      console.error('[lease-market-api]', e instanceof Error ? e.message : String(e));
      return json(500, { error: 'lease market request failed' });
    }
  }

  function readSignals(db: WarehouseDb, where: string): SignalDbRow[] {
    return db
      .prepare(
        `SELECT s.id, s.property_id, s.listing_id, s.kind, s.severity, s.score, s.confidence, s.comp_basis, s.cell_key, s.computed_at, s.evidence_json,
                p.market_id, p.address_display, l.suite_norm
         FROM lm_signal s JOIN lm_property p ON p.id = s.property_id LEFT JOIN lm_listing l ON l.id = s.listing_id
         WHERE ${where}
         ORDER BY CASE s.severity WHEN 'high' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, s.kind, s.id`,
      )
      .all() as SignalDbRow[];
  }

  function toSignalRow(r: SignalDbRow, rowLevel: boolean): SignalRow {
    const evidence = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
    if (!rowLevel) for (const k of REDACTED_EVIDENCE_KEYS) delete evidence[k];
    const address = r.suite_norm ? `${r.address_display} Ste ${r.suite_norm}` : r.address_display;
    return {
      id: r.id, propertyId: r.property_id, listingId: r.listing_id, marketId: r.market_id, address: rowLevel ? address : null, kind: r.kind,
      severity: r.severity, score: r.score, confidence: r.confidence, compBasis: r.comp_basis, cellKey: r.cell_key, computedAt: r.computed_at, evidence,
    };
  }

  app.get('/summary', () =>
    guarded((db, config) => {
      const asOf = referenceDate();
      const state = loadMarketState(db, config, asOf);
      const benchmarks = new Map<string, CellBenchmark>();
      const curve: CurvePoint[] = [];
      for (const s of state.spaces) {
        if (!isActive(s)) continue;
        const latest = s.observations[s.observations.length - 1]!;
        if (!s.isOraOwned && s.sizeBand !== null) {
          const cell = toCellBenchmark(state.cellFor({ marketId: s.marketId, submarket: s.property.submarket, subtype: s.property.subtype, sizeBand: s.sizeBand, officeStratum: s.officeStratum }));
          benchmarks.set(cell.cellKey, cell);
        }
        if (latest.askingNnnEq !== null) {
          curve.push({
            listingId: s.listingId, propertyId: s.propertyId, marketId: s.marketId, subtype: s.property.subtype, availableSf: latest.availableSf,
            askingNnnEq: latest.askingNnnEq, solid: s.latestEligible, isOra: s.isOraOwned, address: config.mirrorRowLevel ? s.addressDisplay : null,
          });
        }
      }
      return json(200, LeaseMarketSummaryResponse.parse({
        asOf,
        rowLevel: config.mirrorRowLevel,
        kpis: leaseMarketKpis(db, config, state, asOf),
        freshness: marketFreshness(db, config, asOf),
        dataQuality: marketDataQuality(db, config, state),
        benchmarks: [...benchmarks.values()].sort((a, b) => a.cellKey.localeCompare(b.cellKey)),
        curve,
        domByMarket: domBins(state, asOf),
      }));
    }),
  );

  app.get('/positioning', () =>
    guarded(async (db, config) => {
      const snapshot = await getSnapshot();
      if (!snapshot) return json(503, { error: 'snapshot unavailable' });
      const asOf = referenceDate();
      const state = loadMarketState(db, config, asOf);
      const units = snapshot.leases.filter((l) => l.status === 'Vacant').map((l) => ({ propertyKey: l.propertyKey, unit: l.unit, sf: l.sf }));
      return json(200, PositioningResponse.parse({ asOf, ...computePositioning(units, config, state, config.mirrorRowLevel) }));
    }),
  );

  app.get('/radar', () =>
    guarded((db, config) => {
      const rowLevel = config.mirrorRowLevel;
      const decisions = new Map<number, { decision: RadarDecisionKind; decidedAt: string; note: string | null }>();
      const decisionRows = db
        .prepare('SELECT property_id, decision, decided_at, note FROM lm_radar_decision ORDER BY decided_at ASC, id ASC')
        .all() as Array<{ property_id: number; decision: RadarDecisionKind; decided_at: string; note: string | null }>;
      for (const d of decisionRows) decisions.set(d.property_id, { decision: d.decision, decidedAt: d.decided_at, note: d.note });

      const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);
      const str = (v: EvidenceValue | undefined): string | null => (typeof v === 'string' ? v : null);
      const candidates: RadarCandidate[] = readSignals(db, "s.kind = 'radar_candidate'")
        .map((r) => {
          const e = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
          return {
            propertyId: r.property_id,
            marketId: r.market_id,
            address: rowLevel ? r.address_display : null,
            subtype: e.subtype === 'flex' ? 'flex' : 'warehouse',
            buildingSf: num(e.buildingSf),
            score: r.score ?? 0,
            parts: {
              dom: num(e.part_dom) ?? 0, reductions: num(e.part_reductions) ?? 0, belowMarket: num(e.part_belowMarket) ?? 0,
              vacancy: num(e.part_vacancy) ?? 0, buyBoxFit: num(e.part_buyBoxFit) ?? 0, owner: num(e.part_owner) ?? 0,
            },
            confidence: r.confidence ?? 'LOW',
            vacancyShare: num(e.vacancyShare),
            maxEffectiveDom: num(e.maxEffectiveDom) ?? 0,
            reductionCount: num(e.reductionCount) ?? 0,
            cumulativeReductionPct: num(e.cumulativeReductionPct),
            bestGapPct: num(e.bestGapPct),
            comparableMedian: num(e.comparableMedian),
            indicativeRentGapUsd: num(e.indicativeRentGapUsd),
            ownerName: rowLevel ? str(e.ownerName) : null,
            ownerType: (str(e.ownerType) ?? 'unknown') as RadarCandidate['ownerType'],
            ownerListingCount: num(e.ownerListingCount) ?? 0,
            brokerName: rowLevel ? str(e.brokerName) : null,
            latestDecision: decisions.get(r.property_id) ?? null,
          } satisfies RadarCandidate;
        })
        .sort((a, b) => b.score - a.score || a.propertyId - b.propertyId);
      const monitor = readSignals(db, "s.kind = 'withdrawn_after_stale'").map((r) => toSignalRow(r, rowLevel));
      return json(200, RadarResponse.parse({ asOf: referenceDate(), candidatesWithheld: withheldCandidateMarkets(db, config), candidates, monitor }));
    }),
  );

  app.post('/radar/decision', (c) =>
    guarded(async (db) => {
      const parsed = RadarDecisionInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return json(400, { error: 'invalid radar decision', issues: parsed.error.issues });
      // NOTE: `parsed.data.<field>` is referenced with the dotted chain (not destructured into bare
      // locals) so scripts/check-write-schema-drift.ts's static field<->column resolver — which
      // only recognizes a direct `identifier.field` passthrough or a one-level-wrapped call, per its
      // extractBoundFieldName()/resolveLocalAlias() — can actually see that property_id/decision/note
      // trace back to RadarDecisionInput's own fields. A `const { propertyId, decision, note } =
      // parsed.data` destructure (the plan's illustrative snippet) produces bare identifiers with no
      // declaration the checker's regex matches, which it cannot resolve back to the schema and so
      // would mis-flag as FIELD_NOT_PERSISTED — divergence recorded per the task brief's step 4.5.
      if (!db.prepare('SELECT id FROM lm_property WHERE id = ?').get(parsed.data.propertyId)) return json(404, { error: 'unknown property' });
      const info = db
        .prepare('INSERT INTO lm_radar_decision (property_id, decided_at, decision, note) VALUES (?, ?, ?, ?)')
        .run(parsed.data.propertyId, now(), parsed.data.decision, parsed.data.note);
      return json(200, RadarDecisionResponse.parse({ ok: true, id: Number(info.lastInsertRowid) }));
    }),
  );

  app.get('/signals', () =>
    guarded((db, config) =>
      json(200, SignalsResponse.parse({
        asOf: referenceDate(),
        candidatesWithheld: withheldCandidateMarkets(db, config),
        signals: readSignals(db, "s.kind <> 'radar_candidate' AND s.kind <> 'withdrawn_after_stale'").map((r) => toSignalRow(r, config.mirrorRowLevel)),
      })),
    ),
  );

  app.get('/changes', () =>
    guarded((db, config) =>
      json(200, ChangesResponse.parse({
        asOf: referenceDate(),
        events: latestExportEvents(db, config).map((e) => (config.mirrorRowLevel ? e : { ...e, address: null })),
      })),
    ),
  );

  app.get('/history/:listingId', (c) =>
    guarded((db, config) => {
      const listingId = Number(c.req.param('listingId'));
      const listing = db
        .prepare('SELECT l.id, l.suite_norm, p.id AS property_id, p.market_id, p.address_display FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE l.id = ?')
        .get(Number.isInteger(listingId) ? listingId : -1) as { id: number; suite_norm: string; property_id: number; market_id: string; address_display: string } | undefined;
      if (!listing) return json(404, { error: 'unknown listing' });
      const address = config.mirrorRowLevel ? (listing.suite_norm ? `${listing.address_display} Ste ${listing.suite_norm}` : listing.address_display) : null;
      const observations = (db
        .prepare('SELECT observed_at, available_sf, asking_nnn_eq, rent_basis, confidence, costar_dom FROM lm_observation WHERE listing_id = ? ORDER BY observed_at, id')
        .all(listing.id) as Array<{ observed_at: string; available_sf: number; asking_nnn_eq: number | null; rent_basis: HistoryResponse['observations'][number]['rentBasis']; confidence: 'high' | 'low'; costar_dom: number | null }>)
        .map((o) => ({ observedAt: o.observed_at, availableSf: o.available_sf, askingNnnEq: o.asking_nnn_eq, rentBasis: o.rent_basis, confidence: o.confidence, costarDom: o.costar_dom }));
      const events = (db
        .prepare('SELECT id, kind, event_date, prev_value, new_value FROM lm_listing_event WHERE listing_id = ? ORDER BY event_date, id')
        .all(listing.id) as Array<{ id: number; kind: ListingEventKind; event_date: string; prev_value: number | null; new_value: number | null }>)
        .map((e) => ({ id: e.id, listingId: listing.id, propertyId: listing.property_id, marketId: listing.market_id, address, kind: e.kind, eventDate: e.event_date, prevValue: e.prev_value, newValue: e.new_value }));
      return json(200, HistoryResponse.parse({ listingId: listing.id, address, observations, events }));
    }),
  );

  return app;
}
