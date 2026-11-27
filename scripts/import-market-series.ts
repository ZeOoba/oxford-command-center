// scripts/import-market-series.ts
//
// Populates market_series (migrations 013 + 017), the non-FRED inputs of buildMarketIntel
// (server/warehouse/market-intel.ts) and the cluster list of capital-allocation-api.ts. Before this
// importer nothing wrote the table, so Market Intelligence scored every cluster on FRED alone. Since
// the 2026-11-27 review only comps-ai feeds the score; census is displayed residential context.
//
// The reader takes, per cluster, the NEWEST row of each source whose metric matches. So this importer
// accepts exactly the two (source, metric) pairs the engine reads, keyed by market-intel.ts STALE_DAYS:
//   census-acs / housing_vacancy_rate  percent (7.2 = 7.2%); RESIDENTIAL housing vacancy, displayed only,
//                                      never scored (2026-11-27 review, Gabriel: ACS B25002/B25004 counts
//                                      housing units, not industrial space); stale after 400 days
//   comps-ai   / cap_rate              percent (6.5 = 6.5%), scored; stale after 90 days
// Any other metric under these sources is rejected, not stored. The census metric was `vacancy_rate`
// until migration 038 renamed every stored census row, so no reader can take it for industrial vacancy.
//
// SOURCES OF RECORD
//   --census   US Census Bureau ACS 5-year Detailed Tables B25002 (occupancy) and B25004 (vacancy
//              status), seasonal units excluded from both sides (the Mid-Atlantic CBSAs include beach
//              markets, where seasonal homes would read as slack):
//              housing_vacancy_rate = (B25002_003E - B25004_006E) / (B25002_001E - B25004_006E) * 100, POOLED
//              over the cluster's CBSAs in config/market-series-geographies.json. as_of = the vintage's
//              PUBLIC RELEASE date (Gabriel ruling 2026-11-23), read from that file's acs5Releases table
//              (each entry cites its census.gov source) or given with --released. Release, not period
//              end, matches market-intel's 400-day census budget to the annual release cadence; the
//              period stays in source_detail. A vintage with no recorded release date and no
//              --released is refused, never guessed (the API's catalog 'modified' date is not the
//              release date). Needs CENSUS_API_KEY (never logged; the request carries only public CBSA
//              codes). Default vintage: the newest of the last four years the API serves.
//
//              Re-stamping as_of creates a NEW tuple, so a warehouse that already holds the same vintage
//              under another as_of keeps both rows; the reader takes the newest as_of. Delete the
//              superseded rows by hand if that matters for display.
//   --file     a JSON array (or { rows: [...] }) or an .xlsx whose first sheet has a header row,
//              columns: cluster, as_of, source, metric, value, confidence, source_detail. The path
//              for cap rates (comps-ai): no in-system cap-rate feed covers the portfolio clusters.
//              census-acs rows are REFUSED here: census rows come only from --census, which stamps
//              the ratified release-date as_of (a hand-typed as_of could keep a census row fresh, or
//              newest, that should not be).
//
// VALIDATION (format failures are rejected and reported, never stored, never auto-fixed)
//   cluster  non-empty; must equal a property_master.market at import time, else skipped and logged
//            as data_quality_issues kind='market-series-unknown-cluster' (a new cluster would add a
//            market verdict to capital allocation: that is a decision, not an import side effect)
//   as_of    strict ISO YYYY-MM-DD, a real calendar day, not in the future
//   source/metric  one of the two pairs above
//   value    finite; housing_vacancy_rate in [1, 50], cap_rate in [2, 20]. Below the floor reads as a
//            decimal fraction (0.07) entered where percent is expected, which the cap-rate score
//            would turn into a zero score (and the displayed housing vacancy into a misleading one)
//   confidence  number in [0, 1] (CHECK in migration 013)
//
// DUPLICATES: two payload rows with the same (cluster, as_of, source, metric) and the same value collapse
// to one; with different values, every copy is rejected (the file contradicts itself).
//
// IDEMPOTENCY: the UNIQUE(cluster, as_of, source, metric) tuple (migration 017) is checked with a
// SELECT before a plain INSERT. Not INSERT OR IGNORE: SQLite's OR IGNORE also swallows CHECK
// violations, which would count a bad row as "already present". A re-run reports every row as ignored. A corrected value for an existing tuple is NOT overwritten:
// the first observation stands, the row counts as ignored, and a differing value is logged as
// data_quality_issues kind='market-series-conflict' (fix the stored row by hand).
// Each row's insert has its own try/catch inside one transaction; a DB error is logged as
// kind='market-series-check-violation' and never rolls back its siblings.
//
// Opens the warehouse with openWarehouseNoMigrate: a DB behind this code is refused, never migrated.
//
// Usage:
//   npx tsx scripts/import-market-series.ts --file <rows.json|rows.xlsx> [--db <path>]
//   npx tsx scripts/import-market-series.ts --census [--vintage <year> [--released <YYYY-MM-DD>]] [--geographies <json>]
//                                               [--db <path>] [--dry-run]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openWarehouseNoMigrate } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { isIsoCalendarDate } from '../server/warehouse/placeholder-data';
import { STALE_DAYS } from '../server/warehouse/market-intel';
import { refuseIfSynthetic } from '../server/real-data-status';

export const SOURCE_METRIC = { 'census-acs': 'housing_vacancy_rate', 'comps-ai': 'cap_rate' } as const;
export type MarketSource = keyof typeof SOURCE_METRIC;
export const VALUE_BOUNDS: Record<MarketSource, [number, number]> = {
  'census-acs': [1, 50],
  'comps-ai': [2, 20],
};

export interface MarketSeriesRow {
  cluster: string;
  asOf: string;
  source: MarketSource;
  metric: string;
  value: number;
  confidence: number;
  sourceDetail: string | null;
}

export interface RejectedRow {
  index: number;
  cluster: string;
  reason: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Pure validator shared by every mode. `today` is injectable for tests. `allowCensus: false` is --file mode. */
export function parseMarketSeriesPayload(
  payload: unknown,
  today: string = todayIso(),
  opts: { allowCensus?: boolean } = {},
): { rows: MarketSeriesRow[]; rejected: RejectedRow[] } {
  const allowCensus = opts.allowCensus ?? true;
  const list = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null && Array.isArray((payload as { rows?: unknown }).rows))
      ? (payload as { rows: unknown[] }).rows
      : null;
  if (list === null) return { rows: [], rejected: [{ index: -1, cluster: '', reason: 'payload is not an array or { rows: [...] }' }] };

  const rows: MarketSeriesRow[] = [];
  const rejected: RejectedRow[] = [];
  list.forEach((raw, index) => {
    const reject = (cluster: string, reason: string): void => { rejected.push({ index, cluster, reason }); };
    if (typeof raw !== 'object' || raw === null) return reject('', 'row is not an object');
    const r = raw as Record<string, unknown>;
    const cluster = typeof r.cluster === 'string' ? r.cluster.trim() : '';
    if (cluster === '') return reject('', 'cluster is missing');
    const asOf = typeof r.as_of === 'string' ? r.as_of.trim() : '';
    if (!isIsoCalendarDate(asOf)) return reject(cluster, `as_of '${String(r.as_of)}' is not an ISO YYYY-MM-DD calendar day`);
    if (asOf > today) return reject(cluster, `as_of ${asOf} is in the future`);
    const source = r.source;
    if (source !== 'census-acs' && source !== 'comps-ai') return reject(cluster, `source '${String(source)}' is not one of census-acs, comps-ai`);
    if (source === 'census-acs' && !allowCensus) return reject(cluster, 'census-acs rows come only from --census (release-date as_of); not accepted in --file mode');
    if (r.metric !== SOURCE_METRIC[source]) {
      return reject(cluster, `metric '${String(r.metric)}' is not read for ${source} (expected ${SOURCE_METRIC[source]}); it would shadow the read row`);
    }
    const value = r.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) return reject(cluster, `value '${String(value)}' is not a finite number`);
    const [lo, hi] = VALUE_BOUNDS[source];
    if (value < lo || value > hi) {
      const hint = value > 0 && value < 1 ? ' (looks like a decimal fraction; enter percent, e.g. 6.5 not 0.065)' : '';
      return reject(cluster, `${SOURCE_METRIC[source]} ${value} is outside [${lo}, ${hi}] percent${hint}`);
    }
    const confidence = r.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return reject(cluster, `confidence '${String(confidence)}' is not a number in [0, 1]`);
    }
    const detail = r.source_detail;
    if (detail !== undefined && detail !== null && typeof detail !== 'string') return reject(cluster, 'source_detail must be text');
    rows.push({
      cluster, asOf, source, metric: SOURCE_METRIC[source], value, confidence,
      sourceDetail: typeof detail === 'string' && detail.trim() !== '' ? detail.trim() : null,
    });
  });
  // Duplicate tuples inside one payload.
  const tupleKey = (r: MarketSeriesRow): string => `${r.cluster}|${r.asOf}|${r.source}|${r.metric}`;
  const groups = new Map<string, MarketSeriesRow[]>();
  for (const r of rows) groups.set(tupleKey(r), [...(groups.get(tupleKey(r)) ?? []), r]);
  const kept: MarketSeriesRow[] = [];
  for (const [key, g] of groups) {
    if (g.length === 1) { kept.push(g[0]!); continue; }
    if (g.every((r) => r.value === g[0]!.value)) {
      kept.push(g[0]!);
      for (let k = 1; k < g.length; k++) rejected.push({ index: -1, cluster: g[k]!.cluster, reason: `duplicate of ${key} in payload (same value; kept once)` });
    } else {
      for (const r of g) rejected.push({ index: -1, cluster: r.cluster, reason: `conflicting duplicate ${key} in payload (values ${g.map((x) => x.value).join(' / ')}); all copies rejected` });
    }
  }
  return { rows: kept, rejected };
}

export interface ImportResult {
  inserted: number;
  ignored: number;
  rejected: number;
}

export function importMarketSeriesRows(db: WarehouseDb, rows: MarketSeriesRow[]): ImportResult {
  const clusters = new Set(
    (db.prepare('SELECT DISTINCT market FROM property_master WHERE market IS NOT NULL').all() as { market: string }[]).map((r) => r.market),
  );
  const dqInsert = db.prepare("INSERT INTO data_quality_issues (property_id, kind, detail, severity) VALUES (NULL, ?, ?, 'warn')");
  const dqOpen = db.prepare("SELECT 1 FROM data_quality_issues WHERE property_id IS NULL AND kind = ? AND detail = ? AND status = 'open'");
  // An identical open issue is not re-filed on every run.
  const dqOnce = (kind: string) => ({ run: (detail: string): void => { if (!dqOpen.get(kind, detail)) dqInsert.run(kind, detail); } });
  const exists = db.prepare('SELECT value FROM market_series WHERE cluster = ? AND as_of = ? AND source = ? AND metric = ?');
  const insert = db.prepare(`
    INSERT INTO market_series (cluster, as_of, source, metric, value, confidence, source_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const dqUnknown = dqOnce('market-series-unknown-cluster');
  const dqConflict = dqOnce('market-series-conflict');
  const dqViolation = dqOnce('market-series-check-violation');
  let inserted = 0;
  let ignored = 0;
  let rejected = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!clusters.has(r.cluster)) {
        rejected += 1;
        dqUnknown.run(`import-market-series: cluster '${r.cluster}' (${r.source} ${r.asOf}) is not a property_master.market; row skipped`);
        continue;
      }
      try {
        const held = exists.get(r.cluster, r.asOf, r.source, r.metric) as { value: number | null } | undefined;
        if (held !== undefined) {
          ignored += 1;
          if (held.value !== r.value) {
            dqConflict.run(`import-market-series: ${r.cluster} ${r.source} ${r.asOf} stored ${String(held.value)}, incoming ${r.value}; stored value kept`);
          }
          continue;
        }
        insert.run(r.cluster, r.asOf, r.source, r.metric, r.value, r.confidence, r.sourceDetail);
        inserted += 1;
      } catch (e) {
        rejected += 1;
        dqViolation.run(`import-market-series: ${r.cluster} ${r.source} ${r.asOf} was skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  })();
  return { inserted, ignored, rejected };
}

/** Parse + import, for tests and the CLI. */
export function importMarketSeries(db: WarehouseDb, payload: unknown, today?: string, opts: { allowCensus?: boolean } = {}): ImportResult {
  const { rows, rejected } = parseMarketSeriesPayload(payload, today, opts);
  const res = importMarketSeriesRows(db, rows);
  return { ...res, rejected: res.rejected + rejected.length };
}

// ── xlsx reader ──────────────────────────────────────────────────────────────────────────────

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function cellValue(v: ExcelJS.CellValue | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: string }).text;
    return null;
  }
  return v;
}

/** An as_of cell: a Date or an Excel serial becomes ISO; text passes through for the validator. */
function asOfCell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return new Date(EXCEL_EPOCH_MS + v * 86_400_000).toISOString().slice(0, 10);
  return typeof v === 'string' ? v.trim() : v;
}

/** First worksheet with a header row -> the same row objects the JSON mode accepts. */
export async function readMarketSeriesXlsx(path: string): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const header: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    header[col] = String(cellValue(cell.value) ?? '').trim().toLowerCase();
  });
  const out: Record<string, unknown>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, unknown> = {};
    let any = false;
    header.forEach((name, col) => {
      if (!name) return;
      let v = cellValue(row.getCell(col).value);
      if (v === '' ) v = null;
      if (v !== null) any = true;
      if (name === 'as_of') v = asOfCell(v);
      if (typeof v === 'string' && (name === 'value' || name === 'confidence') && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      obj[name] = v;
    });
    if (any) out.push(obj);
  }
  return out;
}

// ── Census ACS fetch ─────────────────────────────────────────────────────────────────────────

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AcsRelease { released: string; source: string }

export interface GeographyConfig {
  clusters: Record<string, string[]>;
  /** Vintage year -> public release of the ACS 5-year Detailed Tables. */
  acs5Releases?: Record<string, AcsRelease>;
}

export function loadGeographies(path: string): GeographyConfig {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { clusters?: unknown; acs5Releases?: unknown };
  if (typeof j.clusters !== 'object' || j.clusters === null) throw new Error(`${path}: no clusters object`);
  for (const [k, v] of Object.entries(j.clusters)) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((c) => typeof c === 'string' && /^\d{5}$/.test(c))) {
      throw new Error(`${path}: cluster '${k}' must map to a non-empty list of 5-digit CBSA codes`);
    }
  }
  if (j.acs5Releases !== undefined) {
    if (typeof j.acs5Releases !== 'object' || j.acs5Releases === null) throw new Error(`${path}: acs5Releases must be an object`);
    for (const [y, r] of Object.entries(j.acs5Releases)) {
      const rel = r as Partial<AcsRelease> | null;
      if (!/^\d{4}$/.test(y) || !rel || typeof rel.released !== 'string' || !isIsoCalendarDate(rel.released)
        || rel.released <= `${y}-12-31` || typeof rel.source !== 'string' || rel.source.trim() === '') {
        throw new Error(`${path}: acs5Releases['${y}'] needs an ISO 'released' date after ${y}-12-31 and a non-empty 'source'`);
      }
    }
  }
  return j as GeographyConfig;
}

/** The as_of for a vintage: --released wins, then the config table; null = unknown (refuse). */
export function releaseDateFor(geos: GeographyConfig, vintage: number, override?: string): { asOf: string; source: string } | null {
  if (override !== undefined) return { asOf: override, source: 'release date given with --released' };
  const r = geos.acs5Releases?.[String(vintage)];
  return r ? { asOf: r.released, source: r.source } : null;
}

const ACS_GEO = 'metropolitan statistical area/micropolitan statistical area';

function acsUrl(vintage: number, cbsas: string[], key: string): string {
  return `https://api.census.gov/data/${vintage}/acs/acs5?get=NAME,B25002_001E,B25002_003E,B25004_006E`
    + `&for=${encodeURIComponent(ACS_GEO)}:${cbsas.join(',')}&key=${encodeURIComponent(key)}`;
}

/**
 * Fetch ACS B25002 for every configured CBSA and pool per cluster. Returns market_series payload
 * rows (fed through parseMarketSeriesPayload like any file) plus per-cluster problems. A cluster
 * with any CBSA missing from the response is not emitted: pooling a subset changes what the
 * number means. Throws on HTTP failure (the caller exits 1).
 */
export async function fetchCensusVacancy(
  geos: GeographyConfig,
  key: string,
  fetchFn: FetchFn,
  vintage?: number,
  now: Date = new Date(),
  released?: string,
): Promise<{ vintage: number; payload: Record<string, unknown>[]; problems: string[] }> {
  const all = [...new Set(Object.values(geos.clusters).flat())];
  const candidates = vintage !== undefined ? [vintage] : [1, 2, 3, 4].map((d) => now.getUTCFullYear() - d);
  let table: string[][] | null = null;
  let used = 0;
  const tried: string[] = [];
  for (const y of candidates) {
    const res = await fetchFn(acsUrl(y, all, key));
    if (res.ok) {
      const text = await res.text();
      try { table = JSON.parse(text) as string[][]; } catch { table = null; }
      if (table && Array.isArray(table) && table.length > 1) { used = y; break; }
    }
    tried.push(`${y}: HTTP ${res.status}`);
    table = null;
  }
  if (table === null) throw new Error(`ACS 5-year B25002 not available (${tried.join('; ')}). A missing/invalid CENSUS_API_KEY reads as a redirect.`);

  const release = releaseDateFor(geos, used, released);
  if (release === null) {
    throw new Error(`no public release date recorded for ACS 5-year vintage ${used}: add acs5Releases['${used}'] `
      + '(with its census.gov source) to the geographies config, or pass --released YYYY-MM-DD');
  }
  if (release.asOf <= `${used}-12-31`) throw new Error(`release date ${release.asOf} is not after the ${used} period end`);

  const head = table[0]!;
  const iTotal = head.indexOf('B25002_001E');
  const iVacant = head.indexOf('B25002_003E');
  const iSeasonal = head.indexOf('B25004_006E');
  const iGeo = head.indexOf(ACS_GEO);
  if (iTotal < 0 || iVacant < 0 || iSeasonal < 0 || iGeo < 0) {
    throw new Error('ACS response is missing B25002_001E / B25002_003E / B25004_006E / CBSA columns');
  }
  // Seasonal units come off both sides; a row whose counts do not reconcile is left out (its cluster
  // is then skipped as incomplete rather than pooled without it).
  const byCbsa = new Map<string, { total: number; vacant: number; name: string }>();
  for (const row of table.slice(1)) {
    const total = Number(row[iTotal]);
    const vacant = Number(row[iVacant]);
    const seasonal = Number(row[iSeasonal]);
    if ([total, vacant, seasonal].every(Number.isFinite) && seasonal >= 0 && seasonal <= vacant && vacant <= total && total - seasonal > 0) {
      byCbsa.set(String(row[iGeo]), { total: total - seasonal, vacant: vacant - seasonal, name: String(row[head.indexOf('NAME')] ?? '') });
    }
  }

  const payload: Record<string, unknown>[] = [];
  const problems: string[] = [];
  for (const [cluster, cbsas] of Object.entries(geos.clusters)) {
    const missing = cbsas.filter((c) => !byCbsa.has(c));
    if (missing.length > 0) { problems.push(`${cluster}: CBSA ${missing.join(', ')} not in the ${used} response; cluster skipped`); continue; }
    const total = cbsas.reduce((s, c) => s + byCbsa.get(c)!.total, 0);
    const vacant = cbsas.reduce((s, c) => s + byCbsa.get(c)!.vacant, 0);
    payload.push({
      cluster,
      as_of: release.asOf,
      source: 'census-acs',
      metric: SOURCE_METRIC['census-acs'],
      value: Math.round((vacant / total) * 10000) / 100,
      confidence: 1,
      source_detail: `ACS 5-year ${used - 4}-${used} (period end ${used}-12-31; as_of = public release ${release.asOf}: ${release.source}) `
        + `B25002/B25004 vacant/total housing units excl. seasonal, pooled CBSA ${cbsas.join('+')}`
        + ` (${cbsas.map((c) => byCbsa.get(c)!.name).join('; ')}); vacant=${vacant} total=${total}`,
    });
  }
  return { vintage: used, payload, problems };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export type CliArgs =
  | { mode: 'file'; filePath: string; db?: string; dryRun: boolean }
  | { mode: 'census'; geographies: string; vintage?: number; released?: string; db?: string; dryRun: boolean };

export const DEFAULT_GEOGRAPHIES = join('config', 'market-series-geographies.json');

export function parseArgs(argv: string[]): CliArgs {
  let file: string | undefined;
  let census = false;
  let vintage: number | undefined;
  let geographies: string | undefined;
  let released: string | undefined;
  let db: string | undefined;
  let dryRun = false;
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') { file = value(i, a); i += 1; }
    else if (a === '--census') census = true;
    else if (a === '--vintage') {
      const v = value(i, a); i += 1;
      if (!/^\d{4}$/.test(v)) throw new Error(`--vintage '${v}' is not a 4-digit year`);
      vintage = Number(v);
    }
    else if (a === '--geographies') { geographies = value(i, a); i += 1; }
    else if (a === '--released') {
      released = value(i, a); i += 1;
      if (!isIsoCalendarDate(released)) throw new Error(`--released '${released}' is not an ISO YYYY-MM-DD calendar day`);
      if (released > todayIso()) throw new Error(`--released ${released} is in the future`);
    }
    else if (a === '--db') { db = value(i, a); i += 1; }
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument '${a}'`);
  }
  if (file !== undefined && census) throw new Error('--file and --census are mutually exclusive');
  if (file === undefined && !census) {
    throw new Error('Usage: npx tsx scripts/import-market-series.ts --file <rows.json|rows.xlsx> [--db <path>]\n'
      + '   or: npx tsx scripts/import-market-series.ts --census [--vintage <year> [--released <date>]] [--geographies <json>] [--db <path>] [--dry-run]');
  }
  if (!census && (vintage !== undefined || geographies !== undefined || released !== undefined)) {
    throw new Error('--vintage, --geographies and --released only apply with --census');
  }
  if (released !== undefined && vintage === undefined) throw new Error('--released needs --vintage (a release date belongs to one vintage)');
  if (dryRun && db !== undefined) throw new Error('--dry-run and --db are mutually exclusive (a dry run opens no DB)');
  if (census) return { mode: 'census', geographies: geographies ?? DEFAULT_GEOGRAPHIES, vintage, released, db, dryRun };
  return { mode: 'file', filePath: file!, db, dryRun };
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try { args = parseArgs(argv); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); return 1; }

  let payload: unknown;
  let label: string;
  if (args.mode === 'census') {
    const key = process.env.CENSUS_API_KEY;
    if (!key) { console.error('import-market-series: CENSUS_API_KEY is not set'); return 1; }
    try {
      const geos = loadGeographies(args.geographies);
      const res = await fetchCensusVacancy(geos, key, (u) => fetch(u, { redirect: 'manual' }), args.vintage, undefined, args.released);
      payload = res.payload;
      label = `census-acs ${res.vintage} (${args.geographies})`;
      for (const p of res.problems) console.error(`  ${p}`);
    } catch (e) {
      console.error(`import-market-series: census fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  } else {
    label = args.filePath;
    try {
      payload = args.filePath.toLowerCase().endsWith('.xlsx')
        ? await readMarketSeriesXlsx(args.filePath)
        : JSON.parse(readFileSync(args.filePath, 'utf8'));
    } catch (e) {
      console.error(`cannot read ${args.filePath}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  const parseOpts = { allowCensus: args.mode === 'census' };
  if (args.dryRun) {
    const { rows, rejected } = parseMarketSeriesPayload(payload, undefined, parseOpts);
    console.log(`import-market-series (dry-run): ${rows.length} valid row(s), ${rejected.length} rejected from ${label}`);
    for (const r of rows) console.log(`  ${r.cluster} ${r.source} ${r.asOf} ${r.metric}=${r.value}`);
    for (const r of rejected) console.log(`  rejected #${r.index} ${r.cluster}: ${r.reason}`);
    return 0;
  }

  refuseIfSynthetic('import-market-series');
  const dbPath = args.db ?? process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
  let db: WarehouseDb;
  // Never the schema migrator (tests/unit/warehouse-open-sites.test.ts).
  try { db = openWarehouseNoMigrate(dbPath); }
  catch (e) { console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`); return 1; }
  try {
    const { rows, rejected } = parseMarketSeriesPayload(payload, undefined, parseOpts);
    for (const r of rejected) console.error(`  rejected #${r.index} ${r.cluster}: ${r.reason}`);
    const res = importMarketSeriesRows(db, rows);
    console.log(`import-market-series: ${res.inserted} inserted, ${res.ignored} already present, ${res.rejected + rejected.length} rejected from ${label}`);
    const stale = rows.filter((r) => Date.now() - Date.parse(`${r.asOf}T00:00:00Z`) > (STALE_DAYS[r.source] ?? 0) * 86_400_000);
    if (stale.length > 0) {
      console.log(`  note: ${stale.length} row(s) are already past market-intel's STALE_DAYS budget for their source `
        + `(${Object.entries(STALE_DAYS).map(([k, d]) => `${k} ${d}d`).join(', ')}); they display but do not score`);
    }
  } catch (e) {
    console.error(`import-market-series: database error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    db.close();
  }
  return 0;
}

// Run the CLI only when invoked directly: importing for tests must never open a db or write.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/import-market-series.ts')) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
