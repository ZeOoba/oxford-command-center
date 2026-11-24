import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_THRESHOLDS } from '../src/analytics/conditions';

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
  | 'acqInputs';
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
  // Acquisition engine inputs: underwriting runs weekly-to-monthly; 30 days with no deal input scored
  // means the Cowork screens are not reaching the engine (it had never scored a live deal before the
  // screen-packet importer, 2026-11-23 review Tier 1 #3).
  acqInputs: 30,
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
  acqInputs: {
    label: 'Acquisition engine inputs (last deal scored)',
    fix: 'Import the acquisition-underwriting screen packet: npx tsx scripts/import-acq-screen-packet.ts <packet.json>',
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
  if (rows.length === 0) return null;
  // Strict ISO day, a real calendar date, not in the future (refute round 2: V8's Date.parse takes
  // '45658', 'FY 2025' and '2025-02-30', and one future row would grade a stale register fresh).
  let best: string | null = null;
  for (const { t } of rows) {
    const m = t ? /^(\d{4})-(\d{2})-(\d{2})/.exec(t) : null;
    if (!m) continue;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day || d.getTime() > now + DAY_MS) continue;
    if (best === null || day > best) best = day;
  }
  if (best === null) throw new Error(`${rows.length} assessment row(s) imported, none with a valid past as_of date (YYYY-MM-DD)`);
  return best;
}

/** When the PCA register last took in a report (null = nothing imported). */
export function lastPcaImportAt(db: { prepare(sql: string): { get(): unknown } }): string | null {
  const row = db.prepare('SELECT MAX(imported_at) AS t FROM pca_reports').get() as { t: string | null } | undefined;
  return row?.t ?? null;
}

/**
 * When the acquisition engine last took in a Cowork screen (null = none ever imported). Newest
 * acq_score_inputs row stamped scored_by 'cowork-skill' — the screen-packet importer. POST /acq/score
 * ('api') and re-score sweeps do not count: they re-run the engine without a new underwriting screen
 * (refute wf_c51f7c6a-65b). A re-import of an unchanged packet is INSERT OR IGNORE and does not move it.
 * Known limit: this is load time, not the packet's screenedAt, so importing a backlog of old screens
 * reads fresh.
 */
export function lastAcqInputAt(db: { prepare(sql: string): { get(): unknown } }): string | null {
  const row = db.prepare("SELECT MAX(scored_at) AS t FROM acq_score_inputs WHERE scored_by = 'cowork-skill'").get() as { t: string | null } | undefined;
  // scored_at is SQLite datetime('now'): 'YYYY-MM-DD HH:MM:SS' in UTC with no zone. Date.parse would read it
  // as LOCAL time, so mark it UTC explicitly.
  return row?.t ? `${row.t.replace(' ', 'T')}Z` : null;
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
