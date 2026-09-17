// server/warehouse/lease-market-api.ts
//
// Lease Market Intelligence — Hono sub-router mounted at /api/warehouse/lease-market (sub-routers.ts).
// Routes: GET /summary · /positioning · /radar · /signals · /changes · /history/:listingId · POST /radar/decision.
// Pure route plumbing (math in src/analytics/lease-market/* and server/warehouse/lease-market/*); listed in
// DELIVERY_ONLY_PATHS. CoStar-derived rows are internal-only; redaction (address/ownerName/brokerName
// stripped) applies whenever the effective row-level flag is false — LeaseMarketApiDeps.rowLevel
// when set, else config.mirrorRowLevel (see effectiveRowLevel() below and its deps.rowLevel doc comment).
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { referenceDate } from '../config';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarDecisionInput, RadarDecisionResponse,
  RadarResponse, SignalsResponse,
  type CellBenchmark, type ConfidenceLabel, type CurvePoint, type EvidenceValue, type LeaseMarketConfig, type ListingEventKind,
  type RadarCandidate, type RadarDecisionKind, type SignalRow,
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
  /**
   * Fix round 1 (bake-scoped redaction): overrides `config.mirrorRowLevel` for every route on this
   * router instance when set. `config/lease-market.json` ships `mirrorRowLevel: true` (ratified for
   * the PRIVATE, Access-gated mirror) and stays that way — this override exists so the redacted/
   * public-safe Fat-Mirror bake (scripts/bake-warehouse.ts's inProcessResolver) can force `false` on
   * an in-process router instance without touching the shipped config. Omitted ⇒ falls through to
   * `config.mirrorRowLevel` exactly as before this override existed.
   */
  rowLevel?: boolean;
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
  // Fix round 1, item 1: the single point every route reads redaction policy through — deps.rowLevel
  // overrides config.mirrorRowLevel when set (see LeaseMarketApiDeps.rowLevel doc comment).
  const effectiveRowLevel = (config: LeaseMarketConfig): boolean => deps.rowLevel ?? config.mirrorRowLevel;

  async function guarded(handler: (db: WarehouseDb, config: LeaseMarketConfig) => Response | Promise<Response>): Promise<Response> {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch (e) {
      // Fix round 1, item 4: log the real cause server-side; the body stays the generic sentinel.
      console.error('[lease-market-api] warehouse unavailable:', e instanceof Error ? e.message : String(e));
      return json(503, { error: 'warehouse unavailable' });
    }
    let config: LeaseMarketConfig;
    try {
      config = loadConfig();
    } catch (e) {
      // Fix round 1, item 3: log the real cause server-side; the body never echoes e.message.
      console.error('[lease-market-api] config load failed:', e instanceof Error ? e.message : String(e));
      return json(500, { error: 'invalid lease-market config' });
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

  // Fix round 2, item 2: `evidence_json` is a TEXT column populated by the compute engine, not a
  // guaranteed-valid-JSON invariant enforced by the DB — a corrupt/truncated row must not 500 the
  // whole /radar or /signals response. Returns null (and logs) instead of throwing; both call sites
  // drop the null via flatMap.
  function toSignalRow(r: SignalDbRow, rowLevel: boolean): SignalRow | null {
    let evidence: Record<string, EvidenceValue>;
    try {
      evidence = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
    } catch (e) {
      console.warn(`[lease-market-api] signal ${r.id} (property ${r.property_id}) skipped: unparseable evidence_json (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
    if (!rowLevel) for (const k of REDACTED_EVIDENCE_KEYS) delete evidence[k];
    const address = r.suite_norm ? `${r.address_display} Ste ${r.suite_norm}` : r.address_display;
    return {
      id: r.id, propertyId: r.property_id, listingId: r.listing_id, marketId: r.market_id, address: rowLevel ? address : null, kind: r.kind,
      severity: r.severity, score: r.score, confidence: r.confidence, compBasis: r.comp_basis, cellKey: r.cell_key, computedAt: r.computed_at, evidence,
    };
  }

  /** flatMap-friendly wrapper: [] on a corrupt row, [row] otherwise. */
  function toSignalRows(rows: SignalDbRow[], rowLevel: boolean): SignalRow[] {
    return rows.flatMap((r) => {
      const s = toSignalRow(r, rowLevel);
      return s ? [s] : [];
    });
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
            askingNnnEq: latest.askingNnnEq, solid: s.latestEligible, isOra: s.isOraOwned, address: effectiveRowLevel(config) ? s.addressDisplay : null,
          });
        }
      }
      return json(200, LeaseMarketSummaryResponse.parse({
        asOf,
        rowLevel: effectiveRowLevel(config),
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
      return json(200, PositioningResponse.parse({ asOf, ...computePositioning(units, config, state, effectiveRowLevel(config)) }));
    }),
  );

  const RADAR_SCORE_PARTS = ['part_dom', 'part_reductions', 'part_belowMarket', 'part_vacancy', 'part_buyBoxFit', 'part_owner'] as const;
  const isConfidenceLabel = (v: unknown): v is ConfidenceLabel => v === 'HIGH' || v === 'MEDIUM' || v === 'LOW';

  app.get('/radar', () =>
    guarded((db, config) => {
      const rowLevel = effectiveRowLevel(config);
      const decisions = new Map<number, { decision: RadarDecisionKind; decidedAt: string; note: string | null }>();
      const decisionRows = db
        .prepare('SELECT property_id, decision, decided_at, note FROM lm_radar_decision ORDER BY decided_at ASC, id ASC')
        .all() as Array<{ property_id: number; decision: RadarDecisionKind; decided_at: string; note: string | null }>;
      for (const d of decisionRows) decisions.set(d.property_id, { decision: d.decision, decidedAt: d.decided_at, note: d.note });

      const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);
      const str = (v: EvidenceValue | undefined): string | null => (typeof v === 'string' ? v : null);
      // Fix round 1, item 5: a radar_candidate row missing a finite score, a valid confidence label,
      // or any of the 6 part_* score components is a corrupt/incomplete compute row — it is SKIPPED
      // (logged) rather than silently defaulted to 0/LOW, which would misrepresent it as a real,
      // low-scoring lead instead of surfacing the data-quality problem.
      const candidates: RadarCandidate[] = readSignals(db, "s.kind = 'radar_candidate'")
        .flatMap((r): RadarCandidate[] => {
          const score = r.score;
          if (score === null || !Number.isFinite(score)) {
            console.warn(`[lease-market-api] radar candidate property ${r.property_id} skipped: non-finite score (${JSON.stringify(score)})`);
            return [];
          }
          if (!isConfidenceLabel(r.confidence)) {
            console.warn(`[lease-market-api] radar candidate property ${r.property_id} skipped: invalid/missing confidence (${JSON.stringify(r.confidence)})`);
            return [];
          }
          // Fix round 2, item 2: same corrupt-row guard as toSignalRow, applied here since the radar
          // candidate mapping reads evidence_json directly (it needs the raw part_* keys, not a
          // SignalRow) rather than going through toSignalRow.
          let e: Record<string, EvidenceValue>;
          try {
            e = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
          } catch (err) {
            console.warn(`[lease-market-api] radar candidate property ${r.property_id} skipped: unparseable evidence_json (${err instanceof Error ? err.message : String(err)})`);
            return [];
          }
          const parts: Record<string, number> = {};
          for (const key of RADAR_SCORE_PARTS) {
            const v = num(e[key]);
            if (v === null) {
              console.warn(`[lease-market-api] radar candidate property ${r.property_id} skipped: missing/invalid evidence.${key}`);
              return [];
            }
            parts[key] = v;
          }
          return [{
            propertyId: r.property_id,
            marketId: r.market_id,
            address: rowLevel ? r.address_display : null,
            subtype: e.subtype === 'flex' ? 'flex' : 'warehouse',
            buildingSf: num(e.buildingSf),
            score,
            parts: {
              dom: parts.part_dom!, reductions: parts.part_reductions!, belowMarket: parts.part_belowMarket!,
              vacancy: parts.part_vacancy!, buyBoxFit: parts.part_buyBoxFit!, owner: parts.part_owner!,
            },
            confidence: r.confidence,
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
          } satisfies RadarCandidate];
        })
        .sort((a, b) => b.score - a.score || a.propertyId - b.propertyId);
      const monitor = toSignalRows(readSignals(db, "s.kind = 'withdrawn_after_stale'"), rowLevel);
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
        signals: toSignalRows(readSignals(db, "s.kind <> 'radar_candidate' AND s.kind <> 'withdrawn_after_stale'"), effectiveRowLevel(config)),
      })),
    ),
  );

  app.get('/changes', () =>
    guarded((db, config) =>
      json(200, ChangesResponse.parse({
        asOf: referenceDate(),
        events: latestExportEvents(db, config).map((e) => (effectiveRowLevel(config) ? e : { ...e, address: null })),
      })),
    ),
  );

  app.get('/history/:listingId', (c) =>
    guarded((db, config) => {
      const listingId = Number(c.req.param('listingId'));
      const listing = db
        .prepare('SELECT l.id, l.suite_norm, p.id AS property_id, p.market_id, p.address_display FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE l.id = ?')
        .get(Number.isInteger(listingId) ? listingId : -1) as { id: number; suite_norm: string | null; property_id: number; market_id: string; address_display: string } | undefined;
      if (!listing) return json(404, { error: 'unknown listing' });
      const address = effectiveRowLevel(config) ? (listing.suite_norm ? `${listing.address_display} Ste ${listing.suite_norm}` : listing.address_display) : null;
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
