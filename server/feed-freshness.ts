import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_THRESHOLDS } from '../src/analytics/conditions';
import { STALE_DAYS } from './warehouse/market-intel';

export type FeedId =
  | 'snapshot'
  | 'cashHistory'
  | 'ar'
  | 'dailyBrief'
  | 'leaseMarket'
  | 'docIndex'
  | 'warehouseLedger'
  | 'backup'
  | 'overlay'
  | 'taxRegister'
  | 'pcaRegister'
  | 'marketSeries'
  | 'leaseEvents';
/** 'error' = the read itself failed. Kept apart from 'missing' (never ran / nothing imported) so a
 *  locked DB or a corrupt file no longer looks like a feed that simply has no data (2026-11-23 review). */
export type FeedStatus = 'fresh' | 'stale' | 'missing' | 'error';
export type FeedReadError = { error: string };
export type FeedInput = string | null | FeedReadError;
/** Partial: an omitted feed grades 'missing'. */
export type FeedInputs = Partial<Record<FeedId, FeedInput>>;

export interface FeedFreshness {
  id: FeedId;
  label: string;
  lastAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FeedStatus;
  fix: string;
  /** Set only when status is 'error': the read failure, for the System Health row. */
  error?: string;
}

/** Per-feed staleness budget in days (2026-09-23 review found six feeds silently stale). */
export const FEED_MAX_AGE_DAYS: Record<FeedId, number> = {
  snapshot: 2,
  cashHistory: 40, // monthly rows, 10th of the month
  ar: ALERT_THRESHOLDS.arStalenessMaxDays,
  dailyBrief: 1.5, // matches the client's BRIEF_STALE_HOURS = 36 (src/lib/freshness.ts) — I-3, 2026-09-23 review
  leaseMarket: 14,
  docIndex: 30,
  // P&L exports land at month/quarter close; 45 days covers one close plus slack. Before this feed
  // the ledger sat 139 days unloaded with nothing in the UI saying so (roadmap 2026-10-30, item 1.1).
  warehouseLedger: 45,
  // The backup is meant to run nightly; two days allows one missed night.
  backup: 2,
  // The overlay holds user write-backs, so its age is not staleness. Only 'missing' (the file is
  // absent, so every enrichment domain merges empty) and 'error' (unreadable or a domain the loader
  // drops) matter; the budget is set high on purpose.
  overlay: 3650,
  // Assessments carry an annual valuation date; 18 months allows one tax-year cycle plus the lag
  // before the new values are posted.
  taxRegister: 548,
  // PCAs are commissioned per property every few years; three years flags an import that never recurs.
  pcaRegister: 1095,
  // Census ACS releases annually; the budget is the market-intel scorer's own census staleness
  // window, and the reader grades the stalest cluster, so this row goes stale when the scorer
  // starts flagging any cluster's census series stale.
  marketSeries: STALE_DAYS['census-acs']!,
  // Last run of the rent-roll diff derivation; the snapshot refreshes weekly or faster, so two weeks
  // allows one missed run before the leasing-velocity events are called stale.
  leaseEvents: 14,
};

const META: Record<FeedId, { label: string; fix: string }> = {
  snapshot: { label: 'Workbook snapshot', fix: 'Check the Brain Server workbook watcher / OneDrive sync' },
  cashHistory: { label: 'Cash history (monthly rows)', fix: 'Add the missing monthly rows to Cash Data in the Master Workbook' },
  ar: { label: 'AR aging (QuickBooks)', fix: 'Run the QuickBooks AR export + ar-import-headless' },
  dailyBrief: { label: 'Daily brief', fix: 'Check the scheduled snapshot-refresh / brief task on the CC fleet' },
  leaseMarket: { label: 'Lease market compute', fix: 'npm run lease-market:ingest && npm run lease-market:compute' },
  docIndex: { label: 'Document index (Ask)', fix: 'npm run index:docs' },
  warehouseLedger: {
    label: 'P&L warehouse (last import)',
    fix: 'Drop current property P&L exports in the P&L folder, then npm run warehouse:backfill',
  },
  backup: {
    label: 'Warehouse backup',
    fix: 'npm run backup (set BACKUP_DIR to an off-machine OneDrive folder). Not scheduled: register it via register-scheduled-task',
  },
  overlay: {
    label: 'Overlay (write-backs)',
    fix: 'data/overlay.json is absent or unreadable, so write-back enrichment (arrears, renewal stages, comps) is merging empty. Restore it from the live checkout or a backup',
  },
  taxRegister: {
    label: 'Tax assessments (latest valuation date)',
    fix: 'Import the current assessor values: scripts/import-assessments.ts',
  },
  pcaRegister: {
    label: 'PCA register (last import)',
    fix: 'Re-run the PCA register import with the latest extraction register',
  },
  marketSeries: {
    label: 'Market series (Census ACS, latest release)',
    fix: "Add the new vintage's release date to config/market-series-geographies.json acs5Releases, then npx tsx scripts/import-market-series.ts --census",
  },
  leaseEvents: {
    label: 'Lease events (last import of rent-roll diffs)',
    fix: 'npx tsx scripts/import-lease-events.ts (whether the rent-roll capture itself is current is the Workbook snapshot row)',
  },
};

const DAY_MS = 86_400_000;

/**
 * When the P&L ledger (Spine B) last took in data: the newest COMMITTED import batch. This is load
 * time, not the period the files cover; a re-run of unchanged files dedups by hash and does not move
 * it, which is the point: only new data counts as fresh. Null when nothing has been imported.
 */
export function lastLedgerImportAt(db: { prepare(sql: string): { get(): unknown } }): string | null {
  const row = db.prepare("SELECT MAX(imported_at) AS t FROM import_batches WHERE status = 'committed'").get() as
    | { t: string | null }
    | undefined;
  return row?.t ?? null;
}

/**
 * Newest valuation date in the tax-assessment register (null = nothing imported). as_of is free text
 * stored verbatim by the importer, so the max is taken over PARSED dates, not a lexical SQL MAX
 * ('9/1/2025' sorts above '2026-01-01'). Rows present with no parseable as_of throw, so the feed
 * reads 'error' rather than 'none on record' (refute round 1, 2026-11-23).
 */
export function lastTaxAssessmentAsOf(
  db: { prepare(sql: string): { all(): unknown[] } },
  now: number = Date.now(),
): string | null {
  const rows = db.prepare('SELECT as_of AS t FROM property_tax_assessments').all() as Array<{ t: string | null }>;
  return newestValidPastDay(rows, now, 'assessment', 'as_of');
}

/**
 * Newest strict ISO calendar day among `rows` (null = no rows). Strict ISO day, a real calendar
 * date, not in the future (refute round 2: V8's Date.parse takes '45658', 'FY 2025' and
 * '2025-02-30', and one future row would grade a stale register fresh). Rows present with none
 * valid throw, so the feed reads 'error' rather than 'none on record'.
 */
function newestValidPastDay(rows: Array<{ t: string | null }>, now: number, what: string, column: string): string | null {
  if (rows.length === 0) return null;
  let best: string | null = null;
  for (const { t } of rows) {
    const m = t ? /^(\d{4})-(\d{2})-(\d{2})/.exec(t) : null;
    if (!m) continue;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day || d.getTime() > now + DAY_MS) continue;
    if (best === null || day > best) best = day;
  }
  if (best === null) throw new Error(`${rows.length} ${what} row(s) imported, none with a valid past ${column} date (YYYY-MM-DD)`);
  return best;
}

/**
 * Latest Census ACS release on record for the STALEST cluster: per cluster the newest valid as_of,
 * then the oldest of those (null = never imported). The market-intel scorer flags census staleness
 * per cluster, so a portfolio-wide MAX would read fresh while one cluster's signal is already stale
 * (review 2026-11-23). as_of is the ACS public release date (ruling 2026-11-23), so this is the age
 * of the vintage, not of the import run. A cluster whose rows carry no valid as_of throws ('error').
 * Other sources (comps-ai) have no in-system writer yet and are not graded here.
 */
export function lastMarketSeriesAsOf(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  now: number = Date.now(),
): string | null {
  const rows = db
    .prepare('SELECT cluster AS c, as_of AS t FROM market_series WHERE source = ?')
    .all('census-acs') as Array<{ c: string; t: string | null }>;
  const byCluster = new Map<string, Array<{ t: string | null }>>();
  for (const r of rows) {
    const list = byCluster.get(r.c);
    if (list) list.push(r);
    else byCluster.set(r.c, [r]);
  }
  let stalest: string | null = null;
  for (const [cluster, list] of byCluster) {
    const newest = newestValidPastDay(list, now, `census-acs market_series (cluster ${cluster})`, 'as_of')!;
    if (stalest === null || newest < stalest) stalest = newest;
  }
  return stalest;
}

/**
 * When the lease-event derivation last ran: MAX(created_at) over rows whose source_file carries the
 * [DERIVED:<basis>] tag (null = never derived). scripts/import-lease-events.ts deletes and re-inserts
 * the whole derived set in one transaction per successful run and never updates a row in place, so
 * the newest created_at is the last successful run. abstract_date is NOT used: it is the capture each
 * event was observed in, so its MAX lags the run whenever no new tenancy appears (review 2026-11-23).
 * Whether the rent-roll capture itself is current is the `snapshot` feed's job.
 * created_at is SQLite datetime('now'): 'YYYY-MM-DD HH:MM:SS' in UTC, no 'T'/'Z', so it is parsed
 * strictly as UTC and returned as ISO. Rows present with no valid created_at throw ('error').
 */
export function lastLeaseEventsImportAt(db: { prepare(sql: string): { all(): unknown[] } }): string | null {
  // Same match the importer uses to own (and replace) its rows: LIKE '%[DERIVED:%' (SQLite LIKE is
  // ASCII case-insensitive and gives '[' no meaning), so reader and writer agree on the row set.
  const rows = db
    .prepare("SELECT created_at AS t FROM lease_events WHERE source_file LIKE '%[DERIVED:%'")
    .all() as Array<{ t: string | null }>;
  if (rows.length === 0) return null;
  let best: string | null = null;
  for (const { t } of rows) {
    const m = t ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(t) : null;
    if (!m) continue;
    const iso = `${m[1]}T${m[2]}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19) !== iso.slice(0, 19)) continue;
    if (best === null || iso > best) best = iso;
  }
  if (best === null) throw new Error(`${rows.length} derived lease_events row(s), none with a valid created_at (YYYY-MM-DD HH:MM:SS UTC)`);
  return best;
}

/** When the PCA register last took in a report (null = nothing imported). */
export function lastPcaImportAt(db: { prepare(sql: string): { get(): unknown } }): string | null {
  const row = db.prepare('SELECT MAX(imported_at) AS t FROM pca_reports').get() as { t: string | null } | undefined;
  return row?.t ?? null;
}

/** The backup directory scripts/warehouse-backup.ts writes to (same env var, same default). */
export function backupDirPath(): string {
  return process.env.BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');
}

/**
 * When the last verified backup finished: manifest.json `at`, which warehouse-backup.ts writes only
 * after the integrity and row-count checks pass. Null when there is no manifest. Throws on a
 * corrupt manifest, which the caller reports as 'error'.
 */
export function lastBackupAt(dir: string = backupDirPath()): string | null {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, 'utf8')) as { at?: unknown };
  if (typeof m.at !== 'string') throw new Error('backup manifest.json has no `at` timestamp');
  return m.at;
}

/** Runs one feed read; a throw becomes an error input, so a failure is never shown as 'missing'. */
export function readFeed(read: () => string | null): FeedInput {
  try {
    return read();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function assessFeeds(input: FeedInputs, now: number): FeedFreshness[] {
  return (Object.keys(META) as FeedId[]).map((id) => {
    const raw = input[id] ?? null;
    if (raw !== null && typeof raw === 'object') {
      return {
        id, label: META[id].label, lastAt: null, ageDays: null, maxAgeDays: FEED_MAX_AGE_DAYS[id],
        status: 'error' as const, fix: META[id].fix, error: raw.error,
      };
    }
    const lastAt = raw;
    // A stamp more than a day in the future is a bad source value, never 'fresh' (refute round 2).
    const futureMs = lastAt ? Date.parse(lastAt) - now : NaN;
    if (Number.isFinite(futureMs) && futureMs > DAY_MS) {
      return {
        id, label: META[id].label, lastAt, ageDays: null, maxAgeDays: FEED_MAX_AGE_DAYS[id],
        status: 'error' as const, fix: META[id].fix, error: `timestamp ${lastAt} is in the future`,
      };
    }
    const t = lastAt ? Date.parse(lastAt) : NaN;
    const ok = Number.isFinite(t);
    const ageMs = ok ? now - t : null;
    // Display keeps whole-day granularity; status decides on exact elapsed ms so a sub-day
    // budget (dailyBrief = 1.5 days = 36h) doesn't get rounded away by Math.floor (I-3, 2026-09-23
    // review — the card badge and this row disagreed on when the daily brief goes stale).
    const ageDays = ok ? Math.floor(ageMs! / DAY_MS) : null;
    const maxAgeDays = FEED_MAX_AGE_DAYS[id];
    const status: FeedStatus = ageMs === null ? 'missing' : ageMs > maxAgeDays * DAY_MS ? 'stale' : 'fresh';
    return { id, label: META[id].label, lastAt, ageDays, maxAgeDays, status, fix: META[id].fix };
  });
}
