// scripts/property-financials/lib/io.ts — file IO shared by the two Property Financials CLIs.
// All pure logic lives in src/analytics/property-financials/; this file only reads config, writes to
// the --out directory and prints diff summaries against the committed data/property-financials files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/** Load every versioned config file. `mappingVersion` picks account-mapping.<v>.json (default: highest). */
export function loadConfig(opts: { mappingVersion?: string; derivationVersion?: string } = {}): PipelineConfig {
  const mappingFile = resolve(CONFIG_DIR, `account-mapping.${opts.mappingVersion ?? 'v1'}.json`);
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

export function ensureOutDir(dir: string): string {
  const abs = resolve(dir);
  if (abs === COMMITTED_DIR || abs.startsWith(`${COMMITTED_DIR}\\`) || abs.startsWith(`${COMMITTED_DIR}/`)) {
    throw new Error(`refusing to write into ${COMMITTED_DIR}: promotion is a manual copy (see README.md)`);
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
