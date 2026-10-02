// server/edge/loader.ts
//
// Read-only loader for the Oxford Edge dataset (spec §3–§4, §9 F5–F8). markets.json is written ONLY
// by the upstream oxford-edge pipeline. This module imports exactly two fs functions, readFileSync
// and statSync; tests/unit/edge-loader.test.ts fails if any other fs call ever appears here.
//
// Flow: stat → memo key (mtimeMs, size) → read with retry (EBUSY/EPERM/EACCES, 3 attempts, 250 ms
// backoff: OneDrive lock / mid-sync) → JSON.parse → strict RawEdgeMeta → per-market safeParse
// (bad markets quarantined, not fatal) → reshape to the EdgeMarket output contract. A read/parse
// failure after a good load serves the last-good copy with readError set; `unreadable` / `invalid`
// are returned only when no last-good exists. `missing` (ENOENT) never serves last-good.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EDGE_SERIES, EdgeMarketType, EdgeStatus, EdgeSub, EdgeTrajectory, SERIES_UNITS,
  type EdgeAvailability, type EdgeFieldMeta, type EdgeMarket, type EdgeMarketsResponse,
  type EdgeRejectedMarket, type EdgeSeriesKey,
} from '../../src/contracts/edge';
import { computeCoverage } from './coverage';
import { edgeFreshness } from './freshness';

export type EdgeLoadResult = Omit<EdgeMarketsResponse, 'outsidePullScope'>;

export interface EdgeFsDeps {
  readFile: (path: string) => string;
  stat: (path: string) => { mtimeMs: number; size: number };
  sleep: (ms: number) => Promise<void>;
}

export const NODE_EDGE_FS: EdgeFsDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  stat: (path) => {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RETRYABLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;

/** Strict on meta (spec F7): an upstream key rename or addition fails loudly as `invalid`. */
export const RawEdgeMeta = z
  .object({
    pulled: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    years: z.array(z.number().int()).min(1),
    sources: z.record(z.string(), z.array(z.string())),
    statusEnum: z.array(z.string()),
    fieldMeta: z.record(z.string(), z.object({ trueLabel: z.string(), isProxy: z.boolean() }).strict()),
  })
  .strict();
type RawEdgeMeta = z.infer<typeof RawEdgeMeta>;

const RawEdgeFile = z.object({ meta: z.unknown(), markets: z.array(z.unknown()) });

/** Raw market schema, parameterized by years.length so every series/status array must match it. */
export function rawEdgeMarketSchema(yearCount: number) {
  const values = z.array(z.number().nullable()).length(yearCount);
  const statuses = z.array(EdgeStatus).length(yearCount);
  const seriesShape = Object.fromEntries(EDGE_SERIES.map((k) => [k, values])) as Record<EdgeSeriesKey, typeof values>;
  const statusShape = Object.fromEntries(EDGE_SERIES.map((k) => [k, statuses])) as Record<EdgeSeriesKey, typeof statuses>;
  return z.object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().length(2),
    cbsa: z.string(),
    lat: z.number(),
    lon: z.number(),
    type: EdgeMarketType,
    trajectory: EdgeTrajectory.nullable(),
    subs: z.array(EdgeSub),
    status: z.object(statusShape),
    ...seriesShape,
  });
}
type RawEdgeMarket = z.infer<ReturnType<typeof rawEdgeMarketSchema>>;

interface ParsedDataset {
  meta: RawEdgeMeta;
  markets: EdgeMarket[];
  rejectedMarkets: EdgeRejectedMarket[];
  mtimeMs: number;
  size: number;
  loadedAt: string;
}

/** Last good parse per directory: doubles as the memo (keyed by mtimeMs + size) and the last-good cache. */
const cache = new Map<string, ParsedDataset>();

export function resetEdgeLoaderCache(): void {
  cache.clear();
}

function errCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withRetry<T>(fn: () => T, deps: EdgeFsDeps): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const code = errCode(e);
      if (code === null || !RETRYABLE_CODES.has(code) || attempt >= MAX_ATTEMPTS) throw e;
      await deps.sleep(BACKOFF_MS);
    }
  }
}

function formatIssues(issues: readonly z.ZodIssue[], max: number): string[] {
  return issues.slice(0, max).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

function idOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
    return (raw as { id: string }).id;
  }
  return null;
}

function toEdgeMarket(raw: RawEdgeMarket): EdgeMarket {
  const series = Object.fromEntries(
    EDGE_SERIES.map((k) => [k, { values: raw[k], status: raw.status[k] }]),
  ) as EdgeMarket['series'];
  return {
    id: raw.id,
    name: raw.name,
    state: raw.state,
    cbsa: raw.cbsa,
    lat: raw.lat,
    lon: raw.lon,
    type: raw.type,
    trajectory: raw.trajectory,
    subs: raw.subs,
    series,
  };
}

function emptyResult(availability: EdgeAvailability, dir: string, issues: string[]): EdgeLoadResult {
  return {
    availability,
    dir,
    freshness: null,
    readError: null,
    lastGoodLoadedAt: null,
    years: [],
    fieldMeta: {},
    sources: {},
    coverage: [],
    markets: [],
    rejectedMarkets: [],
    marketCount: 0,
    issues,
  };
}

function fromParsed(dir: string, p: ParsedDataset, now: Date, readError: string | null): EdgeLoadResult {
  const fieldMeta: Partial<Record<EdgeSeriesKey, EdgeFieldMeta>> = {};
  for (const k of EDGE_SERIES) {
    const fm = p.meta.fieldMeta[k];
    if (fm) fieldMeta[k] = { trueLabel: fm.trueLabel, isProxy: fm.isProxy, unit: SERIES_UNITS[k] };
  }
  return {
    availability: 'ok',
    dir,
    freshness: edgeFreshness(p.meta.pulled, p.mtimeMs, now),
    readError,
    lastGoodLoadedAt: p.loadedAt,
    years: p.meta.years,
    fieldMeta,
    sources: p.meta.sources,
    coverage: computeCoverage(p.markets, p.meta.years),
    markets: p.markets,
    rejectedMarkets: p.rejectedMarkets,
    marketCount: p.markets.length,
    issues: [],
  };
}

export async function loadEdgeDataset(dir: string, now: Date, deps: EdgeFsDeps = NODE_EDGE_FS): Promise<EdgeLoadResult> {
  const file = join(dir, 'markets.json');
  const lastGood = cache.get(dir) ?? null;
  const serveLastGoodOr = (fallback: EdgeLoadResult, readError: string): EdgeLoadResult =>
    lastGood ? fromParsed(dir, lastGood, now, readError) : fallback;

  let st: { mtimeMs: number; size: number };
  try {
    st = await withRetry(() => deps.stat(file), deps);
  } catch (e) {
    const code = errCode(e);
    if (code !== null && MISSING_CODES.has(code)) return emptyResult('missing', dir, []);
    const msg = `stat failed: ${messageOf(e)}`;
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  if (lastGood && lastGood.mtimeMs === st.mtimeMs && lastGood.size === st.size) {
    return fromParsed(dir, lastGood, now, null);
  }

  let text: string;
  try {
    text = await withRetry(() => deps.readFile(file), deps);
  } catch (e) {
    const code = errCode(e);
    if (code !== null && MISSING_CODES.has(code)) return emptyResult('missing', dir, []);
    const msg = messageOf(e);
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const msg = `markets.json is not valid JSON (${messageOf(e)})`;
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  const fileShape = RawEdgeFile.safeParse(json);
  if (!fileShape.success) {
    const issues = formatIssues(fileShape.error.issues, 5);
    return serveLastGoodOr(emptyResult('invalid', dir, issues), `markets.json failed schema validation: ${issues[0] ?? ''}`);
  }
  const meta = RawEdgeMeta.safeParse(fileShape.data.meta);
  if (!meta.success) {
    const issues = formatIssues(meta.error.issues, 5).map((i) => `meta.${i}`);
    return serveLastGoodOr(emptyResult('invalid', dir, issues), `markets.json failed schema validation: ${issues[0] ?? ''}`);
  }

  const schema = rawEdgeMarketSchema(meta.data.years.length);
  const markets: EdgeMarket[] = [];
  const rejectedMarkets: EdgeRejectedMarket[] = [];
  for (const rawMarket of fileShape.data.markets) {
    const parsed = schema.safeParse(rawMarket);
    if (parsed.success) markets.push(toEdgeMarket(parsed.data));
    else rejectedMarkets.push({ id: idOf(rawMarket), reason: formatIssues(parsed.error.issues, 3).join('; ') });
  }

  const dataset: ParsedDataset = {
    meta: meta.data,
    markets,
    rejectedMarkets,
    mtimeMs: st.mtimeMs,
    size: st.size,
    loadedAt: now.toISOString(),
  };
  cache.set(dir, dataset);
  return fromParsed(dir, dataset, now, null);
}
