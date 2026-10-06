// server/property-financials/loader.ts
//
// Read-only loader for the Property Financials dataset (plan T4; pattern copied from
// server/edge/loader.ts). dataset.json and monthly-long.csv are written ONLY by the refresh pipeline
// (T9) / by hand in a commit. This module imports exactly two fs functions, readFileSync and
// statSync; tests/unit/property-financials-loader.test.ts fails if any other fs call appears here.
//
// Flow (dataset.json): stat → memo key (mtimeMs, size) → read with retry (EBUSY/EPERM/EACCES,
// 3 attempts, 250 ms backoff: OneDrive lock / mid-sync) → stat again (a file replaced mid-read
// restarts the cycle) → JSON.parse → parsePropertyFinancialsDataset (strict Zod). A failure after a
// good load serves the last-good copy with readError set; `missing` / `unreadable` / `invalid` are
// returned only when no last-good exists.
//
// monthly-long.csv is the audit twin: only its sha256 is surfaced (data-health panel), memoised on its
// own (mtimeMs, size). A CSV failure is non-fatal: csvSha256 null + a sanitized csvError.
//
// All error text is sanitized: errno code / fixed strings / Zod path+code (+ unknown key NAMES, which
// the contract deliberately reports) only. Never a raw fs message (paths) or an input value.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePropertyFinancialsDataset, type PfDataset } from '../../src/contracts/property-financials';
import { PF_STALE_DAYS } from './config';

export type PfAvailability = 'ok' | 'missing' | 'unreadable' | 'invalid';
export type PfStaleness = 'fresh' | 'stale';

/** The data-health block (plan T8): what was loaded, from which bytes, and how old it is. */
export interface PfDataHealthMeta {
  version: string;
  generated: string;
  as_of: string;
  basis: 'cash';
  sha256: string;
  csvSha256: string | null;
  csvError: string | null;
  /** Whole calendar days from as_of to today (server local date). */
  ageDays: number;
  /** `fresh` while -1 <= ageDays <= PF_STALE_DAYS (see isFutureAsOf for the lower bound). */
  staleness: PfStaleness;
  /** Why the dataset is stale, or null when fresh. */
  stalenessReason: string | null;
}

export interface PfLoadResult {
  availability: PfAvailability;
  readError: string | null;
  lastGoodLoadedAt: string | null;
  issues: string[];
  dataset: PfDataset | null;
  meta: PfDataHealthMeta | null;
}

export interface PfFsDeps {
  readFile: (path: string) => Buffer;
  stat: (path: string) => { mtimeMs: number; size: number };
  sleep: (ms: number) => Promise<void>;
}

export const NODE_PF_FS: PfFsDeps = {
  readFile: (path) => readFileSync(path),
  stat: (path) => {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const DATASET_FILE = 'dataset.json';
export const CSV_FILE = 'monthly-long.csv';

const RETRYABLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;
const MAX_ISSUES = 12;
const DAY_MS = 86_400_000;

interface FileKey {
  mtimeMs: number;
  size: number;
}

interface ParsedDataset {
  dataset: PfDataset;
  sha256: string;
  key: FileKey;
  loadedAt: string;
}

interface CsvHash {
  key: FileKey;
  sha256: string;
}

/** Last good parse per directory: doubles as the memo and the last-good cache. */
const datasetCache = new Map<string, ParsedDataset>();
const csvCache = new Map<string, CsvHash>();

export function resetPropertyFinancialsLoaderCache(): void {
  datasetCache.clear();
  csvCache.clear();
}

function errCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return null;
}

/** errno code + fixed wording only. Never the raw message (it can embed paths). */
function fsFailure(op: 'stat' | 'read', e: unknown): string {
  const code = errCode(e);
  return code !== null && /^[A-Z0-9_]{1,20}$/.test(code) ? `${op} failed (${code})` : `${op} failed`;
}

async function withRetry<T>(fn: () => T, deps: PfFsDeps): Promise<T> {
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

class ReadFailure {
  constructor(
    readonly kind: 'missing' | 'unreadable',
    readonly message: string,
  ) {}
}

function failureOf(op: 'stat' | 'read', e: unknown): ReadFailure {
  const code = errCode(e);
  return new ReadFailure(code !== null && MISSING_CODES.has(code) ? 'missing' : 'unreadable', fsFailure(op, e));
}

const sameKey = (a: FileKey | null | undefined, b: FileKey) => !!a && a.mtimeMs === b.mtimeMs && a.size === b.size;

/**
 * stat → (memo hit? return null) → read → stat again. The returned key is the POST-read stat, and a
 * file replaced mid-read restarts the cycle, so content and (mtime, size) always pair up.
 */
async function readStable(
  file: string,
  label: string,
  memo: FileKey | null,
  deps: PfFsDeps,
): Promise<{ buf: Buffer; key: FileKey } | null> {
  for (let cycle = 1; ; cycle++) {
    let pre: FileKey;
    try {
      pre = await withRetry(() => deps.stat(file), deps);
    } catch (e) {
      throw failureOf('stat', e);
    }
    if (sameKey(memo, pre)) return null;
    let buf: Buffer;
    let post: FileKey;
    try {
      buf = await withRetry(() => deps.readFile(file), deps);
      post = await withRetry(() => deps.stat(file), deps);
    } catch (e) {
      throw failureOf('read', e);
    }
    if (post.mtimeMs === pre.mtimeMs && post.size === pre.size) return { buf, key: post };
    if (cycle >= MAX_ATTEMPTS) throw new ReadFailure('unreadable', `${label} changed while being read`);
  }
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** File-derived text (contract issue lines can name unknown keys): printable ASCII, bounded. */
function clean(s: string): string {
  return s.replace(/[^ -~]/g, '').slice(0, 300);
}

/** Splits the contract's single-line error into per-issue lines (paths + codes only). */
function contractIssues(e: unknown): string[] {
  if (!(e instanceof Error)) return ['dataset failed schema validation'];
  const idx = e.message.indexOf('): ');
  const body = idx >= 0 ? e.message.slice(idx + 3) : 'dataset failed schema validation';
  return body.split('; ').slice(0, MAX_ISSUES).map(clean);
}

function localDayUtc(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole days from an ISO `YYYY-MM-DD` to the server-local calendar date of `now`. */
export function ageDaysFrom(isoDate: string, now: Date): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return Math.round((localDayUtc(now) - Date.UTC(y, m - 1, d)) / DAY_MS);
}

/**
 * An as-of date more than one day ahead of the server's local date. One day of slack absorbs a
 * time-zone / clock difference between the machine that stamped the date and this one; beyond that
 * a future date is an error (a typo'd year, a mis-set clock) and must never read as fresh forever.
 */
export function isFutureAsOf(ageDays: number): boolean {
  return ageDays < -1;
}

export const FUTURE_AS_OF_REASON = 'as-of date is in the future';

async function loadCsvHash(dir: string, deps: PfFsDeps): Promise<{ sha256: string | null; error: string | null }> {
  const memo = csvCache.get(dir) ?? null;
  try {
    const got = await readStable(join(dir, CSV_FILE), CSV_FILE, memo?.key ?? null, deps);
    if (got === null) return { sha256: memo!.sha256, error: null };
    const entry = { key: got.key, sha256: sha256(got.buf) };
    csvCache.set(dir, entry);
    return { sha256: entry.sha256, error: null };
  } catch (e) {
    csvCache.delete(dir);
    return { sha256: null, error: `${CSV_FILE}: ${e instanceof ReadFailure ? e.message : 'read failed'}` };
  }
}

function emptyResult(availability: PfAvailability, issues: string[]): PfLoadResult {
  return { availability, readError: null, lastGoodLoadedAt: null, issues, dataset: null, meta: null };
}

export async function loadPropertyFinancials(dir: string, now: Date, deps: PfFsDeps = NODE_PF_FS): Promise<PfLoadResult> {
  const fromParsed = async (p: ParsedDataset, readError: string | null): Promise<PfLoadResult> => {
    const csv = await loadCsvHash(dir, deps);
    const m = p.dataset.meta;
    const ageDays = ageDaysFrom(m.as_of, now);
    const stalenessReason = isFutureAsOf(ageDays) ? FUTURE_AS_OF_REASON : ageDays > PF_STALE_DAYS ? `as-of date is ${ageDays} days old (> ${PF_STALE_DAYS})` : null;
    return {
      availability: 'ok',
      readError,
      lastGoodLoadedAt: p.loadedAt,
      issues: [],
      dataset: p.dataset,
      meta: {
        version: m.version,
        generated: m.generated,
        as_of: m.as_of,
        basis: m.basis,
        sha256: p.sha256,
        csvSha256: csv.sha256,
        csvError: csv.error,
        ageDays,
        staleness: stalenessReason === null ? 'fresh' : 'stale',
        stalenessReason,
      },
    };
  };
  // Looked up at the moment of failure, never captured at request start: a concurrent request may have
  // cached a newer dataset while this one slept on a retry backoff.
  const serveLastGoodOr = (fallback: PfLoadResult, readError: string): Promise<PfLoadResult> => {
    const current = datasetCache.get(dir);
    return current ? fromParsed(current, readError) : Promise.resolve(fallback);
  };

  const memo = datasetCache.get(dir) ?? null;
  let got: { buf: Buffer; key: FileKey } | null;
  try {
    got = await readStable(join(dir, DATASET_FILE), DATASET_FILE, memo?.key ?? null, deps);
  } catch (e) {
    const f = e instanceof ReadFailure ? e : new ReadFailure('unreadable', 'read failed');
    return serveLastGoodOr(emptyResult(f.kind, f.kind === 'missing' ? [] : [f.message]), f.message);
  }
  if (got === null) return fromParsed(memo!, null);

  let json: unknown;
  try {
    const text = got.buf.toString('utf8');
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // Fixed text only: the V8 message quotes file content.
    const msg = `${DATASET_FILE} is not valid JSON`;
    return serveLastGoodOr(emptyResult('unreadable', [msg]), msg);
  }

  let dataset: PfDataset;
  try {
    dataset = parsePropertyFinancialsDataset(json);
  } catch (e) {
    const issues = contractIssues(e);
    return serveLastGoodOr(emptyResult('invalid', issues), `${DATASET_FILE} failed schema validation: ${issues[0] ?? ''}`);
  }

  const parsed: ParsedDataset = { dataset, sha256: sha256(got.buf), key: got.key, loadedAt: now.toISOString() };
  datasetCache.set(dir, parsed);
  return fromParsed(parsed, null);
}
