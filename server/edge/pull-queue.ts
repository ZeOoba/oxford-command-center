// server/edge/pull-queue.ts
//
// Oxford Edge manual-pull queue (spec §5.3). Scope lists and cadences are CODE (versioned,
// reviewable); the DB holds only the append-only edge_pull_log (migration 034). The storage/IOS
// scopes are the UNION of the frozen copy of the retired Morning Guide's 21-market list and any loaded
// markets.json market typed buy-box, so a buy-box market quarantined at load never drops out of the
// queue (its recorded state stays visible and it stays recordable). VA and MI truck coverage is
// automated (derived from markets.json), never a queue row. Labels, slugs, press feeds and truck
// blockers are carried from the retired artifact (morning_guide.html, 2026-07-14).
import type { WarehouseDb } from '../warehouse/db';
import type {
  EdgeMarket, EdgeOutsidePullScope, EdgePullItem, EdgePullKind, EdgePullLink, EdgePullQueueResponse,
  EdgePullScopeState, EdgePullState, RecordPullRequest,
} from '../../src/contracts/edge';
import { isRealIsoDate } from './freshness';
import { BUY_BOX_TYPES } from './series';

export interface EdgeBuyBoxScope {
  id: string;
  label: string;
  slug: string;
}

/** Frozen copy of the artifact's 21-market storage/IOS list (ids from markets.json, labels/slugs
 *  from the artifact). indianapolis_south uses the artifact's "Indianapolis, IN" storage slug. */
export const EDGE_BUY_BOX_FALLBACK: readonly EdgeBuyBoxScope[] = [
  { id: 'harrisburg', label: 'Harrisburg, PA', slug: 'harrisburg-pa' },
  { id: 'lancaster', label: 'Lancaster, PA', slug: 'lancaster-pa' },
  { id: 'york', label: 'York, PA', slug: 'york-pa' },
  { id: 'allentown', label: 'Allentown, PA', slug: 'allentown-pa' },
  { id: 'hagerstown', label: 'Hagerstown, MD', slug: 'hagerstown-md' },
  { id: 'winchester', label: 'Winchester, VA', slug: 'winchester-va' },
  { id: 'richmond', label: 'Richmond, VA', slug: 'richmond-va' },
  { id: 'roanoke', label: 'Roanoke, VA', slug: 'roanoke-va' },
  { id: 'columbus', label: 'Columbus, OH', slug: 'columbus-oh' },
  { id: 'cincinnati', label: 'Cincinnati, OH', slug: 'cincinnati-oh' },
  { id: 'dayton', label: 'Dayton, OH', slug: 'dayton-oh' },
  { id: 'toledo', label: 'Toledo, OH', slug: 'toledo-oh' },
  { id: 'fort_wayne', label: 'Fort Wayne, IN', slug: 'fort-wayne-in' },
  { id: 'grand_rapids', label: 'Grand Rapids, MI', slug: 'grand-rapids-mi' },
  { id: 'louisville', label: 'Louisville, KY', slug: 'louisville-ky' },
  { id: 'kansas_city', label: 'Kansas City, MO', slug: 'kansas-city-mo' },
  { id: 'madison', label: 'Madison, WI', slug: 'madison-wi' },
  { id: 'des_moines', label: 'Des Moines, IA', slug: 'des-moines-ia' },
  { id: 'lincoln', label: 'Lincoln, NE', slug: 'lincoln-ne' },
  { id: 'omaha', label: 'Omaha, NE', slug: 'omaha-ne' },
  { id: 'indianapolis_south', label: 'Indianapolis, IN', slug: 'indianapolis-in' },
];

export const MFG_INVEST_STATES = ['PA', 'MD', 'VA', 'WV', 'OH', 'IN', 'MI', 'KY', 'MO', 'KS', 'WI', 'IA', 'NE', 'IL', 'MN'] as const;
export const TRUCK_STATES = ['OH', 'IN', 'WI', 'PA', 'MD', 'KY', 'MO', 'KS', 'IA', 'NE', 'WV', 'IL', 'MN'] as const;

/** State economic-development press feeds (from the artifact). */
export const MFG_INVEST_FEEDS: Readonly<Record<string, string>> = {
  PA: 'https://dced.pa.gov/newsroom/',
  MD: 'https://commerce.maryland.gov/media',
  VA: 'https://www.vedp.org/news',
  WV: 'https://westvirginia.gov/category/news/',
  OH: 'https://www.jobsohio.com/newsroom',
  IN: 'https://iedc.in.gov/media',
  MI: 'https://www.michiganbusiness.org/press-releases/',
  KY: 'https://ced.ky.gov/News',
  MO: 'https://missouripartnership.com/news/',
  KS: 'https://www.kansascommerce.gov/newsroom/',
  WI: 'https://wedc.org/category/news/',
  IA: 'https://www.iowaeda.com/newsroom/',
  NE: 'https://opportunity.nebraska.gov/newsroom/',
  IL: 'https://dceo.illinois.gov/aboutdceo/newsroom.html',
  MN: 'https://mn.gov/deed/newscenter/',
};

const NOT_ATTEMPTED = 'Not attempted — out of scope for the 2026-07-14 pass (time-boxed to VA/MI/OH/IN/WI).';

/** Per-state truck AADT blockers, carried in intent from the artifact. */
export const TRUCK_BLOCKERS: Readonly<Record<string, string>> = {
  OH: 'Dead endpoint — the gis.dot.state.oh.us TIMS ArcGIS server is decommissioned (every known path 404s). Needs a fresh search for where ODOT now publishes its traffic-count GIS layer.',
  IN: "JS app only — INDOT's TCDS (tcds.indot.in.gov) is an interactive map, not a queryable REST endpoint. Check INDOT's open-data portal for a downloadable AADT shapefile/CSV.",
  WI: "Usable but risky — live ArcGIS endpoints carry no truck-class breakdown and count segments on an irregular multi-year rotation; a naive year-over-year join would fabricate deltas. Verify each segment's count years first.",
  PA: `${NOT_ATTEMPTED} PennDOT publishes open GIS traffic layers via PASDA — good first check.`,
  MO: `${NOT_ATTEMPTED} MoDOT publishes open GIS traffic layers via MSDIS — good first check.`,
  MD: NOT_ATTEMPTED,
  KY: NOT_ATTEMPTED,
  KS: NOT_ATTEMPTED,
  IA: NOT_ATTEMPTED,
  NE: NOT_ATTEMPTED,
  WV: NOT_ATTEMPTED,
  IL: NOT_ATTEMPTED,
  MN: NOT_ATTEMPTED,
};

export interface EdgePullItemDef {
  kind: EdgePullKind;
  label: string;
  cadenceDays: number;
  cadenceLabel: string;
  scopeType: 'market' | 'state';
  why: string;
  caveat: string;
}

export const PULL_ITEMS: Readonly<Record<EdgePullKind, EdgePullItemDef>> = {
  storage: {
    kind: 'storage',
    label: 'Self-storage asking rates',
    cadenceDays: 90,
    cadenceLabel: 'Quarterly',
    scopeType: 'market',
    why: 'Storage rates are the space-scarcity proxy almost nobody in industrial underwriting tracks.',
    caveat: "Today's rate only — record a baseline; growth accumulates from future pulls. StorageCafe/RentCafe keep no history, so 2021–2024 cannot be backfilled.",
  },
  ios: {
    kind: 'ios',
    label: 'IOS & contractor-yard listings',
    cadenceDays: 90,
    cadenceLabel: 'Quarterly',
    scopeType: 'market',
    why: 'Oxford buys IOS and almost nobody datasets it — a real edge if kept current.',
    caveat: 'Crexi and LoopNet block scripted pulls (JS shell, no listing data); a manual per-market scan is the realistic cadence.',
  },
  mfgInvest: {
    kind: 'mfgInvest',
    label: 'Manufacturing investment announcements',
    cadenceDays: 30,
    cadenceLabel: 'Monthly',
    scopeType: 'state',
    why: 'Every plant drags 20–40 small suppliers behind it — the earliest, biggest-magnitude signal in the dataset.',
    caveat: 'Unstructured press releases across 15 state economic-development sites; a QCEW manufacturing-employment proxy will not catch a plant until it reaches payroll data.',
  },
  truck: {
    kind: 'truck',
    label: 'Truck AADT',
    cadenceDays: 365,
    cadenceLabel: 'Annual',
    scopeType: 'state',
    why: 'Freight moving before jobs show up is the earliest demand signal there is.',
    caveat: 'VA and MI are complete through the automated state-DOT pull; each remaining state has a specific blocker below.',
  },
};

export const PULL_KIND_ORDER: readonly EdgePullKind[] = ['storage', 'ios', 'mfgInvest', 'truck'];

const DAY_MS = 86_400_000;

const NO_LOGGED_KEYS: ReadonlySet<string> = new Set();

/** Storage/IOS scope ids, in order: (1) frozen ids, EXCEPT one the dataset loaded OK and explicitly types
 *  non-buy-box with no pull-log history (a frozen id that is absent or quarantined stays, so an unavailable
 *  dataset yields the full frozen set); (2) loaded markets typed buy-box; (3) `logged` = scope keys already
 *  in edge_pull_log for this kind, so a market with history stays visible and recordable even after the
 *  dataset quarantines or retypes it (log-derived keys are safe: they were accepted from this allowlist
 *  and the DB CHECK bounds them). Callers pass the set for ONE kind (readEdgePullLoggedKeys). */
export function deriveBuyBoxIds(markets: readonly EdgeMarket[], logged: ReadonlySet<string> = NO_LOGGED_KEYS): string[] {
  const loaded = new Map(markets.map((m) => [m.id, m]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const s of EDGE_BUY_BOX_FALLBACK) {
    const m = loaded.get(s.id);
    if (m !== undefined && !BUY_BOX_TYPES.has(m.type) && !logged.has(s.id)) continue;
    add(s.id);
  }
  for (const m of markets) if (BUY_BOX_TYPES.has(m.type)) add(m.id);
  for (const k of [...logged].sort()) add(k);
  return ids;
}

/** The scope set is the single source for both the GET queue rows and the POST membership check.
 *  Storage/IOS: see deriveBuyBoxIds (`logged` applies to these kinds only). mfgInvest: the fixed list.
 *  Truck: the fixed TRUCK_STATES list MINUS any state markets.json already automates (spec §5.3): an
 *  automated state is neither queued nor recordable. If a state that already has truck log rows later
 *  becomes automated, its rows are kept (append-only) but simply stop appearing in the queue. */
export function pullScopeKeys(
  kind: EdgePullKind,
  markets: readonly EdgeMarket[],
  logged: ReadonlySet<string> = NO_LOGGED_KEYS,
): string[] {
  if (kind === 'storage' || kind === 'ios') return deriveBuyBoxIds(markets, logged);
  if (kind === 'mfgInvest') return [...MFG_INVEST_STATES];
  const automated = new Set(automatedTruckStates(markets));
  return TRUCK_STATES.filter((s) => !automated.has(s));
}

/** States with any non-null truck value in markets.json (VA + MI today). */
export function automatedTruckStates(markets: readonly EdgeMarket[]): string[] {
  const states = new Set<string>();
  for (const m of markets) if (m.series.truck.values.some((v) => v !== null)) states.add(m.state);
  return [...states].sort();
}

/** In-dataset states outside the artifact's pull scope (TN, ND, SD, DC today), listed in Data health. */
export function computeOutsidePullScope(markets: readonly EdgeMarket[]): EdgeOutsidePullScope {
  const datasetStates = [...new Set(markets.map((m) => m.state))].sort();
  const automated = new Set(automatedTruckStates(markets));
  const truckScope = new Set<string>(TRUCK_STATES);
  const mfgScope = new Set<string>(MFG_INVEST_STATES);
  return {
    truck: datasetStates.filter((s) => !truckScope.has(s) && !automated.has(s)),
    mfgInvest: datasetStates.filter((s) => !mfgScope.has(s)),
  };
}

/** Server LOCAL calendar date (the "not in the future" rule is relative to server local date). */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { isRealIsoDate };

export function scopeStateFor(
  lastDoneOn: string | null,
  cadenceDays: number,
  today: string,
): { state: EdgePullState; ageDays: number | null } {
  if (lastDoneOn === null) return { state: 'open', ageDays: null };
  const raw = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDoneOn}T00:00:00Z`)) / DAY_MS);
  const ageDays = Math.max(0, raw);
  return { state: ageDays <= cadenceDays ? 'current' : 'due', ageDays };
}

export interface EdgePullLogRow {
  id: number;
  kind: EdgePullKind;
  scopeKey: string;
  doneOn: string;
  note: string | null;
}

/** Latest non-voided row per (kind, scope), keyed `${kind}|${scopeKey}`. */
export function readEdgePullLatest(db: WarehouseDb): Map<string, EdgePullLogRow> {
  const rows = db
    .prepare(
      `SELECT id, pull_kind AS kind, scope_key AS scopeKey, done_on AS doneOn, note
         FROM edge_pull_log
        WHERE voided_at IS NULL
        ORDER BY pull_kind, scope_key, done_on DESC, id DESC`,
    )
    .all() as EdgePullLogRow[];
  const latest = new Map<string, EdgePullLogRow>();
  for (const r of rows) {
    const key = `${r.kind}|${r.scopeKey}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  return latest;
}

/** Every scope key with ANY edge_pull_log row for `kind` — voided rows included (deliberate: a scope whose
 *  only history was voided keeps its history reachable instead of orphaning it; it renders as open). */
export function readEdgePullLoggedKeys(db: WarehouseDb, kind: EdgePullKind): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT scope_key AS scopeKey FROM edge_pull_log WHERE pull_kind = ?')
    .all(kind) as { scopeKey: string }[];
  return new Set(rows.map((r) => r.scopeKey));
}

/** Thrown by recordEdgePull for a bad (non-calendar / future) doneOn. Subclass of RangeError so
 *  existing handlers still match; the route maps ONLY this class to HTTP 400. */
export class PullValidationError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'PullValidationError';
  }
}

/** Append one log row. Binds exactly kind/scopeKey/doneOn/note → pull_kind/scope_key/done_on/note
 *  (check:schema-drift cross-references these against RecordPullRequest).
 *  `today` defaults to the server local date; the parameter exists for tests only — the route
 *  always passes its injected clock, never a request-derived value. */
export function recordEdgePull(db: WarehouseDb, input: RecordPullRequest, today: string = localIsoDate(new Date())): number {
  if (!isRealIsoDate(input.doneOn)) throw new PullValidationError(`doneOn is not a real calendar date: ${input.doneOn}`);
  if (input.doneOn > today) throw new PullValidationError(`doneOn ${input.doneOn} is in the future (server local date ${today})`);
  const result = db
    .prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on, note) VALUES (?, ?, ?, ?)')
    .run(input.kind, input.scopeKey, input.doneOn, input.note ?? null);
  return Number(result.lastInsertRowid);
}

export type VoidEdgePullResult =
  | { status: 'voided'; kind: EdgePullKind }
  | { status: 'already_voided'; kind: EdgePullKind }
  | { status: 'superseded'; kind: EdgePullKind }
  | { status: 'not_found' };

/** Undo = set voided_at. Rows are never removed (append-only; archive-not-remove rule). Only the row that is
 *  currently the scope's state (latest non-voided by done_on DESC, id DESC) is voidable: voiding an older,
 *  superseded row from a stale tab would be permanent (the trigger forbids un-voiding) yet change nothing visible. */
export function voidEdgePull(db: WarehouseDb, id: number): VoidEdgePullResult {
  // BEGIN IMMEDIATE: the latest-row check and the UPDATE hold the write lock together, so another
  // connection cannot record a newer row between them (a void is permanent: the trigger forbids un-voiding).
  const run = db.transaction((): VoidEdgePullResult => {
    const row = db
      .prepare('SELECT pull_kind AS kind, scope_key AS scopeKey, voided_at AS voidedAt FROM edge_pull_log WHERE id = ?')
      .get(id) as { kind: EdgePullKind; scopeKey: string; voidedAt: string | null } | undefined;
    if (!row) return { status: 'not_found' };
    if (row.voidedAt !== null) return { status: 'already_voided', kind: row.kind };
    const current = db
      .prepare(
        `SELECT id FROM edge_pull_log
          WHERE pull_kind = ? AND scope_key = ? AND voided_at IS NULL
          ORDER BY done_on DESC, id DESC LIMIT 1`,
      )
      .get(row.kind, row.scopeKey) as { id: number } | undefined;
    if (current !== undefined && current.id !== id) return { status: 'superseded', kind: row.kind };
    // result.changes stays as a guard: it must be exactly 1 for the void to count.
    const res = db
      .prepare("UPDATE edge_pull_log SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND voided_at IS NULL")
      .run(id);
    return res.changes === 1 ? { status: 'voided', kind: row.kind } : { status: 'already_voided', kind: row.kind };
  });
  return run.immediate();
}

function scopeLabelFor(kind: EdgePullKind, scopeKey: string, markets: readonly EdgeMarket[]): string {
  if (kind === 'mfgInvest' || kind === 'truck') return scopeKey;
  const frozen = EDGE_BUY_BOX_FALLBACK.find((s) => s.id === scopeKey);
  if (frozen) return frozen.label;
  const m = markets.find((x) => x.id === scopeKey);
  return m ? `${m.name}, ${m.state}` : scopeKey;
}

function scopeLinks(kind: EdgePullKind, scopeKey: string): EdgePullLink[] {
  if (kind === 'mfgInvest') {
    const url = MFG_INVEST_FEEDS[scopeKey];
    return url ? [{ label: 'Press feed', url }] : [];
  }
  if (kind === 'truck') return [];
  const frozen = EDGE_BUY_BOX_FALLBACK.find((s) => s.id === scopeKey);
  if (!frozen) return [];
  if (kind === 'storage') {
    return [
      { label: 'StorageCafe', url: `https://www.storagecafe.com/self-storage-rates/${frozen.slug}/` },
      { label: 'RentCafe', url: `https://www.rentcafe.com/self-storage/usa/${frozen.slug}/` },
    ];
  }
  return [
    {
      label: 'Crexi',
      url: `https://www.crexi.com/properties?filters=%7B%22types%22%3A%5B%22land%22%5D%7D&searchTerm=${encodeURIComponent(frozen.label)}`,
    },
    { label: 'LoopNet', url: `https://www.loopnet.com/search/land/${frozen.slug}/` },
  ];
}

export function buildEdgePullItem(
  kind: EdgePullKind,
  markets: readonly EdgeMarket[],
  latest: ReadonlyMap<string, EdgePullLogRow>,
  today: string,
  logged: ReadonlySet<string> = NO_LOGGED_KEYS,
): EdgePullItem {
  const def = PULL_ITEMS[kind];
  const scopes: EdgePullScopeState[] = pullScopeKeys(kind, markets, logged).map((scopeKey) => {
    const row = latest.get(`${kind}|${scopeKey}`) ?? null;
    const { state, ageDays } = scopeStateFor(row?.doneOn ?? null, def.cadenceDays, today);
    return {
      scopeKey,
      scopeLabel: scopeLabelFor(kind, scopeKey, markets),
      state,
      lastDoneOn: row?.doneOn ?? null,
      lastNote: row?.note ?? null,
      lastLogId: row?.id ?? null,
      ageDays,
      links: scopeLinks(kind, scopeKey),
      blocker: kind === 'truck' ? (TRUCK_BLOCKERS[scopeKey] ?? null) : null,
    };
  });
  return {
    kind,
    label: def.label,
    cadenceDays: def.cadenceDays,
    cadenceLabel: def.cadenceLabel,
    scopeType: def.scopeType,
    why: def.why,
    caveat: def.caveat,
    scopes,
    counts: {
      open: scopes.filter((s) => s.state === 'open').length,
      due: scopes.filter((s) => s.state === 'due').length,
      current: scopes.filter((s) => s.state === 'current').length,
    },
  };
}

export function buildEdgePullQueue(db: WarehouseDb, markets: readonly EdgeMarket[], today: string): EdgePullQueueResponse {
  const latest = readEdgePullLatest(db);
  return {
    items: PULL_KIND_ORDER.map((kind) => buildEdgePullItem(kind, markets, latest, today, readEdgePullLoggedKeys(db, kind))),
    automatedCoverage: { truck: automatedTruckStates(markets) },
    today,
  };
}
