// src/contracts/edge.ts
//
// Oxford Edge — Phase 1 display contracts (docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md §6).
// The OUTPUT shape of GET/POST /api/warehouse/edge/* only. The raw markets.json schema
// (RawEdgeMeta / rawEdgeMarketSchema) is an ingest concern and lives in server/edge/loader.ts, so an
// upstream file-shape change never needs an Architect contract change.
//
// NOT in FINANCIAL_CONTRACT_PATHS (scripts/check-refute-required.ts) and must not be added in
// Phase 1: nothing here feeds scoring. Phase 2 re-evaluates that (spec §13).
import { z } from 'zod';

/** The 18 Edge series, in display order. */
export const EDGE_SERIES = [
  'pop', 'job', 'inc', 'incLevel', 'trades', 'biz', 'hvacPermits', 'per', 'loss',
  'truck', 'storage', 'rent', 'vac', 'carriers', 'mfgInvest', 'ios', 'migration', 'eGrocery',
] as const;
export const EdgeSeriesKey = z.enum(EDGE_SERIES);
export type EdgeSeriesKey = z.infer<typeof EdgeSeriesKey>;

/** markets.json statusEnum. `'null'` is a STRING member, distinct from a JSON null value. */
export const EdgeStatus = z.enum(['actual', 'estimated', 'nowcast', 'guide_only', 'null']);
export type EdgeStatus = z.infer<typeof EdgeStatus>;

/** Statuses whose non-null value counts as observed data (coverage "filled", board "latest"). */
export const EDGE_OBSERVED_STATUSES: readonly EdgeStatus[] = ['actual', 'estimated', 'nowcast'];

export const EdgeUnit = z.enum(['pct_yoy', 'pct_level', 'ksf', 'per_10k', 'usd', 'persons', 'signal']);
export type EdgeUnit = z.infer<typeof EdgeUnit>;

/** Units are declared once, here: fieldMeta carries none, and the data dictionary's "all % YoY
 *  except incLevel and migration" is wrong for vac/per/loss/carriers/mfgInvest (spec §3).
 *  server/edge/series.ts re-exports this table; tests pin it against fieldMeta's key set. */
export const SERIES_UNITS: Readonly<Record<EdgeSeriesKey, EdgeUnit>> = {
  pop: 'pct_yoy',
  job: 'pct_yoy',
  inc: 'pct_yoy',
  trades: 'pct_yoy',
  biz: 'pct_yoy',
  hvacPermits: 'pct_yoy',
  truck: 'pct_yoy',
  storage: 'pct_yoy',
  rent: 'pct_yoy',
  eGrocery: 'pct_yoy',
  vac: 'pct_level',
  loss: 'pct_level',
  per: 'ksf',
  carriers: 'per_10k',
  incLevel: 'usd',
  mfgInvest: 'usd',
  migration: 'persons',
  ios: 'signal',
};

/** One series for one market: parallel values/status arrays, reshaped server-side so the client
 *  never zips two arrays by index. */
export const EdgeSeriesCell = z
  .object({ values: z.array(z.number().nullable()), status: z.array(EdgeStatus) })
  .refine((c) => c.values.length === c.status.length, { message: 'values and status must be the same length' });
export type EdgeSeriesCell = z.infer<typeof EdgeSeriesCell>;

export const EdgeSeriesMap = z.object({
  pop: EdgeSeriesCell,
  job: EdgeSeriesCell,
  inc: EdgeSeriesCell,
  incLevel: EdgeSeriesCell,
  trades: EdgeSeriesCell,
  biz: EdgeSeriesCell,
  hvacPermits: EdgeSeriesCell,
  per: EdgeSeriesCell,
  loss: EdgeSeriesCell,
  truck: EdgeSeriesCell,
  storage: EdgeSeriesCell,
  rent: EdgeSeriesCell,
  vac: EdgeSeriesCell,
  carriers: EdgeSeriesCell,
  mfgInvest: EdgeSeriesCell,
  ios: EdgeSeriesCell,
  migration: EdgeSeriesCell,
  eGrocery: EdgeSeriesCell,
});
export type EdgeSeriesMap = z.infer<typeof EdgeSeriesMap>;

export const EdgeSub = z.object({
  name: z.string(),
  vac: z.number(),
  rentGrowth: z.number(),
  invKsf: z.number(),
});
export type EdgeSub = z.infer<typeof EdgeSub>;

/** named + named_custom = the 21-market buy-box set; auto = the 34 auto-included CBSAs. */
export const EdgeMarketType = z.enum(['named', 'named_custom', 'auto']);
export type EdgeMarketType = z.infer<typeof EdgeMarketType>;

export const EdgeTrajectory = z.enum(['a_growing', 'b_stable', 'c_reversing']);
export type EdgeTrajectory = z.infer<typeof EdgeTrajectory>;

export const EdgeMarket = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Primary state only (a multi-state CBSA lists one state, e.g. washington_arlington_alexandria = DC). */
  state: z.string().length(2),
  cbsa: z.string(),
  lat: z.number(),
  lon: z.number(),
  type: EdgeMarketType,
  trajectory: EdgeTrajectory.nullable(),
  subs: z.array(EdgeSub),
  series: EdgeSeriesMap,
});
export type EdgeMarket = z.infer<typeof EdgeMarket>;

export const EdgeFieldMeta = z.object({
  trueLabel: z.string(),
  isProxy: z.boolean(),
  unit: EdgeUnit,
});
export type EdgeFieldMeta = z.infer<typeof EdgeFieldMeta>;

export const EdgeFreshness = z.object({
  metaPulled: z.string(),
  fileMtime: z.string(),
  /** The EARLIER of metaPulled and the file mtime date — an OneDrive re-sync that bumps mtime can
   *  never make old data read as fresh. */
  asOf: z.string(),
  ageDays: z.number().int().nonnegative(),
  staleAfterDays: z.number().int().positive(),
  stale: z.boolean(),
});
export type EdgeFreshness = z.infer<typeof EdgeFreshness>;

export const EdgeStatusCounts = z.object({
  actual: z.number().int().nonnegative(),
  estimated: z.number().int().nonnegative(),
  nowcast: z.number().int().nonnegative(),
  guide_only: z.number().int().nonnegative(),
  null: z.number().int().nonnegative(),
});
export type EdgeStatusCounts = z.infer<typeof EdgeStatusCounts>;

export const EdgeCoverageRow = z.object({
  field: EdgeSeriesKey,
  filled: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  pct: z.number().min(0).max(1),
  byYear: z.array(z.number().int().nonnegative()),
  allPlaceholder: z.boolean(),
  statusCounts: EdgeStatusCounts,
  /** Cells where value and status disagree (a value with status 'null'/guide_only, or null with an
   *  observed status). Counted as NOT filled. */
  inconsistent: z.array(z.object({ marketId: z.string(), year: z.number().int() })),
});
export type EdgeCoverageRow = z.infer<typeof EdgeCoverageRow>;

export const EdgeRejectedMarket = z.object({ id: z.string().nullable(), reason: z.string() });
export type EdgeRejectedMarket = z.infer<typeof EdgeRejectedMarket>;

/** Data states, returned as HTTP 200 (a 503 would be mis-rendered as "warehouse offline"). */
export const EdgeAvailability = z.enum(['ok', 'missing', 'unreadable', 'invalid']);
export type EdgeAvailability = z.infer<typeof EdgeAvailability>;

export const EdgeOutsidePullScope = z.object({
  truck: z.array(z.string()),
  mfgInvest: z.array(z.string()),
});
export type EdgeOutsidePullScope = z.infer<typeof EdgeOutsidePullScope>;

export const EdgeMarketsResponse = z.object({
  availability: EdgeAvailability,
  /** Returned only because the API is localhost-only. */
  dir: z.string(),
  freshness: EdgeFreshness.nullable(),
  /** Set when last-good is being served after a failed re-read. */
  readError: z.string().nullable(),
  lastGoodLoadedAt: z.string().nullable(),
  years: z.array(z.number().int()),
  fieldMeta: z.record(EdgeSeriesKey, EdgeFieldMeta),
  sources: z.record(z.string(), z.array(z.string())),
  coverage: z.array(EdgeCoverageRow),
  markets: z.array(EdgeMarket),
  rejectedMarkets: z.array(EdgeRejectedMarket),
  marketCount: z.number().int().nonnegative(),
  /** unreadable: [the I/O error]; invalid: the first 5 schema issues; otherwise []. */
  issues: z.array(z.string()),
  outsidePullScope: EdgeOutsidePullScope,
});
export type EdgeMarketsResponse = z.infer<typeof EdgeMarketsResponse>;

// ── Manual-pull queue ─────────────────────────────────────────────────────────────────────────

export const EdgePullKind = z.enum(['storage', 'ios', 'mfgInvest', 'truck']);
export type EdgePullKind = z.infer<typeof EdgePullKind>;

export const EdgePullState = z.enum(['open', 'current', 'due']);
export type EdgePullState = z.infer<typeof EdgePullState>;

export const EdgePullLink = z.object({ label: z.string(), url: z.string().url() });
export type EdgePullLink = z.infer<typeof EdgePullLink>;

export const EdgePullScopeState = z.object({
  scopeKey: z.string(),
  scopeLabel: z.string(),
  state: EdgePullState,
  lastDoneOn: z.string().nullable(),
  lastNote: z.string().nullable(),
  lastLogId: z.number().int().positive().nullable(),
  ageDays: z.number().int().nonnegative().nullable(),
  links: z.array(EdgePullLink),
  /** Truck only: the per-state blocker carried from the retired Morning Guide. */
  blocker: z.string().nullable(),
});
export type EdgePullScopeState = z.infer<typeof EdgePullScopeState>;

export const EdgePullItem = z.object({
  kind: EdgePullKind,
  label: z.string(),
  cadenceDays: z.number().int().positive(),
  cadenceLabel: z.string(),
  scopeType: z.enum(['market', 'state']),
  why: z.string(),
  caveat: z.string(),
  scopes: z.array(EdgePullScopeState),
  counts: z.object({
    open: z.number().int().nonnegative(),
    due: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  }),
});
export type EdgePullItem = z.infer<typeof EdgePullItem>;

export const EdgePullQueueResponse = z.object({
  items: z.array(EdgePullItem),
  /** States complete through the automated pull, derived from markets.json (never from the log). */
  automatedCoverage: z.object({ truck: z.array(z.string()) }),
  /** Server local date used for state derivation. */
  today: z.string(),
});
export type EdgePullQueueResponse = z.infer<typeof EdgePullQueueResponse>;

/** POST /api/warehouse/edge/pull-queue body. scopeKey membership, real-date and not-future checks
 *  are enforced by the route (they depend on code-declared scope lists and the server clock). */
export const RecordPullRequest = z
  .object({
    kind: EdgePullKind,
    scopeKey: z.string().min(2).max(64),
    doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type RecordPullRequest = z.infer<typeof RecordPullRequest>;

// ── News overlay ──────────────────────────────────────────────────────────────────────────────
// A dated, hand-reviewed annotation layer read from news_overlay.json beside markets.json. It
// annotates markets; it never changes a series value, a rank or a score (spec §2 non-goals).

export const EdgeNewsSignal = z.enum(['up', 'down', 'mixed', 'none']);
export type EdgeNewsSignal = z.infer<typeof EdgeNewsSignal>;

export const EdgeNewsEntry = z.object({
  marketId: z.string().min(1),
  signal: EdgeNewsSignal,
  /** BLS payroll jobs, % change over the year to the overlay's reference month; null where BLS does not report the metro. */
  jobsYoy: z.number().finite().nullable(),
  note: z.string(),
});
export type EdgeNewsEntry = z.infer<typeof EdgeNewsEntry>;

export const EdgeNewsResponse = z.object({
  availability: EdgeAvailability,
  asOf: z.string().nullable(),
  /** Whole days since asOf, clamped to >= 0; null when no overlay loaded. */
  ageDays: z.number().int().nonnegative().nullable(),
  staleAfterDays: z.number().int().positive(),
  /** True when the overlay is older than staleAfterDays, has a future or invalid asOf, or is not loaded. */
  stale: z.boolean(),
  headline: z.string().nullable(),
  entries: z.array(EdgeNewsEntry),
  /** missing: []; unreadable/invalid: sanitized reasons (errno code, Zod path + code). */
  issues: z.array(z.string()),
});
export type EdgeNewsResponse = z.infer<typeof EdgeNewsResponse>;
