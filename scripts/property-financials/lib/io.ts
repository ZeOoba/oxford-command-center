// scripts/property-financials/lib/io.ts — file IO shared by the two Property Financials CLIs.
// All pure logic lives in src/analytics/property-financials/; this file only reads config, writes to
// the --out directory and prints diff summaries against the committed data/property-financials files.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCuratedInputs, parseDerivationConfig, parseEntityRegistry, type CuratedInputs, type DerivationConfig, type EntityRegistry } from '../../../src/analytics/property-financials/build-dataset';
import { parseAccountMapping, type AccountMapping } from '../../../src/analytics/property-financials/normalize';

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
export const CONFIG_DIR = resolve(SCRIPT_DIR, '..', 'config');
export const DEFAULT_OUT_DIR = resolve(SCRIPT_DIR, '..', '_out');
export const COMMITTED_DIR = resolve(REPO_ROOT, 'data', 'property-financials');
export const COMMITTED_CSV = resolve(COMMITTED_DIR, 'monthly-long.csv');
export const COMMITTED_DATASET = resolve(COMMITTED_DIR, 'dataset.json');

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export interface PipelineConfig {
  readonly mapping: AccountMapping;
  readonly registry: EntityRegistry;
  readonly derivation: DerivationConfig;
  readonly curated: CuratedInputs;
  readonly mappingFile: string;
}

/** The highest `account-mapping.vN.json` present in config/ (v2 adds the QuickBooks rules; AF/CF/A12 rules are identical across versions). */
export function latestMappingVersion(dir: string = CONFIG_DIR): string {
  const versions = readdirSync(dir)
    .map((f) => /^account-mapping\.v(\d+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  if (versions.length === 0) throw new Error(`no account-mapping.vN.json in ${dir}`);
  return `v${versions[0]}`;
}

/** Load every versioned config file. `mappingVersion` picks account-mapping.<v>.json (default: highest present). */
export function loadConfig(opts: { mappingVersion?: string; derivationVersion?: string } = {}): PipelineConfig {
  const mappingFile = resolve(CONFIG_DIR, `account-mapping.${opts.mappingVersion ?? latestMappingVersion()}.json`);
  const derivationFile = resolve(CONFIG_DIR, `derivation.${opts.derivationVersion ?? 'v1'}.json`);
  const curatedDir = resolve(CONFIG_DIR, 'curated');
  return {
    mapping: parseAccountMapping(readJson(mappingFile)),
    registry: parseEntityRegistry(readJson(resolve(CONFIG_DIR, 'entities.json'))),
    derivation: parseDerivationConfig(readJson(derivationFile)),
    curated: parseCuratedInputs({
      meta: readJson(resolve(curatedDir, 'meta.json')),
      insights: readJson(resolve(curatedDir, 'insights.json')),
      leases: readJson(resolve(curatedDir, 'leases.json')),
      data_quality: readJson(resolve(curatedDir, 'data_quality.json')),
      sf: readJson(resolve(curatedDir, 'sf.json')),
    }),
    mappingFile,
  };
}

/** Minimal `--flag value` / `--flag` parser; no positional args. */
export function parseArgs(argv: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * The file-system identity of a path for comparison: the nearest EXISTING ancestor resolved through
 * realpathSync.native (expands 8.3 short names, symlinks / junctions, and the on-disk letter case),
 * the not-yet-created tail re-appended, `\` normalised to `/`, lower-cased on win32 (case-insensitive
 * file system). Never used as a write target — only to compare.
 */
export function canonicalPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync.native(head);
  } catch {
    // unreadable ancestor: compare the resolved spelling
  }
  const joined = (tail.length ? join(real, ...tail) : real).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform !== 'win32') return joined;
  // Local-drive aliases: \\?\C:\..., \\.\C:\..., \\localhost\C$\..., \\127.0.0.1\C$\... all name C:\...
  return joined.toLowerCase().replace(/^\/\/(?:\?|\.|localhost|127\.0\.0\.1)\/([a-z])(?::|\$)(?=\/|$)/, '$1:');
}

const COMMITTED_FILES = ['dataset.json', 'monthly-long.csv'] as const;

/**
 * Create and return the --out directory, refusing (a) this checkout's committed dataset directory or
 * anything under it, however the path is spelled, and (b) any directory under a
 * `.../data/property-financials` path that already holds a committed dataset file (another
 * checkout's, or a worktree's). Promotion into data/property-financials is a reviewed manual copy.
 */
export function ensureOutDir(dir: string, committedDir: string = COMMITTED_DIR): string {
  const abs = resolve(dir);
  const target = canonicalPath(abs);
  const committed = canonicalPath(committedDir);
  if (target === committed || target.startsWith(`${committed}/`)) {
    throw new Error(`refusing to write into ${committedDir}: promotion is a manual copy (see README.md)`);
  }
  // Any checkout's committed dataset directory: the target itself, or any ancestor of it, that is a
  // data/property-financials directory already holding a committed dataset file.
  for (let at = abs; ; at = dirname(at)) {
    if (/(^|\/)data\/property-financials$/i.test(canonicalPath(at))) {
      const held = COMMITTED_FILES.filter((f) => existsSync(join(at, f)));
      if (held.length > 0) {
        throw new Error(`refusing to write into ${abs}: ${at} already holds a committed dataset file (${held.join(', ')}); promotion is a manual copy (see README.md)`);
      }
    }
    if (dirname(at) === at) break;
  }
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text, 'utf8');
}

/** Line-level diff summary of two texts (CRLF-aware): counts and the first few differing lines. */
export function summarizeTextDiff(built: string, committedPath: string, label: string): string {
  if (!existsSync(committedPath)) return `${label}: no committed file at ${committedPath} (nothing to diff)`;
  const a = built.split(/\r?\n/);
  const b = readFileSync(committedPath, 'utf8').split(/\r?\n/);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return `${label}: IDENTICAL to ${committedPath} (${a.length - 1} lines)`;
  const multiset = new Map<string, number>();
  for (const l of b) multiset.set(l, (multiset.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of a) {
    const n = multiset.get(l) ?? 0;
    if (n > 0) multiset.set(l, n - 1);
    else added.push(l);
  }
  const removed = [...multiset.entries()].filter(([, n]) => n > 0).flatMap(([l, n]) => Array.from({ length: n }, () => l));
  const show = (xs: string[]): string => xs.slice(0, 10).map((x) => `    ${x}`).join('\n') + (xs.length > 10 ? `\n    ... +${xs.length - 10} more` : '');
  const orderOnly = added.length === 0 && removed.length === 0;
  return [
    `${label}: DIFFERS from ${committedPath} — built ${a.length - 1} lines vs committed ${b.length - 1}`,
    orderOnly ? '  same multiset of lines, different order' : '',
    added.length ? `  only in built (${added.length}):\n${show(added)}` : '',
    removed.length ? `  only in committed (${removed.length}):\n${show(removed)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Deep diff of two JSON values: every differing leaf path (first `limit`). -0 and 0 are treated as equal. */
export function diffJsonPaths(built: unknown, committed: unknown, path = '', out: string[] = [], limit = 60): string[] {
  if (out.length >= limit) return out;
  if (Array.isArray(built) || Array.isArray(committed)) {
    if (!Array.isArray(built) || !Array.isArray(committed)) {
      out.push(`${path}: ${Array.isArray(built) ? 'array' : typeof built} vs ${Array.isArray(committed) ? 'array' : typeof committed}`);
      return out;
    }
    if (built.length !== committed.length) out.push(`${path}: length ${built.length} vs ${committed.length}`);
    for (let i = 0; i < Math.min(built.length, committed.length); i++) diffJsonPaths(built[i], committed[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (built !== null && committed !== null && typeof built === 'object' && typeof committed === 'object') {
    const ka = Object.keys(built as object);
    const kb = Object.keys(committed as object);
    for (const k of ka) if (!kb.includes(k)) out.push(`${path}.${k}: only in built`);
    for (const k of kb) if (!ka.includes(k)) out.push(`${path}.${k}: only in committed`);
    for (const k of ka) if (kb.includes(k)) diffJsonPaths((built as Record<string, unknown>)[k], (committed as Record<string, unknown>)[k], `${path}.${k}`, out, limit);
    return out;
  }
  const equal = built === committed || (typeof built === 'number' && typeof committed === 'number' && built === committed);
  if (!equal) out.push(`${path}: built ${JSON.stringify(built)} vs committed ${JSON.stringify(committed)}`);
  return out;
}

export function summarizeJsonDiff(built: unknown, committedPath: string, label: string): string {
  if (!existsSync(committedPath)) return `${label}: no committed file at ${committedPath} (nothing to diff)`;
  const committed = readJson(committedPath);
  const diffs = diffJsonPaths(built, committed);
  if (diffs.length === 0) return `${label}: IDENTICAL to ${committedPath} (deep-equal; -0/0 treated as equal)`;
  return `${label}: DIFFERS from ${committedPath} — ${diffs.length}${diffs.length >= 60 ? '+' : ''} leaf difference(s):\n${diffs.map((d) => `    ${d}`).join('\n')}`;
}
