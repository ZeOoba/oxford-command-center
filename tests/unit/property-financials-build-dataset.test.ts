// @vitest-environment node
//
// tests/unit/property-financials-build-dataset.test.ts — T9a step 4: monthly-long.csv + versioned config
// -> dataset.json. The builder must regenerate the committed data/property-financials/dataset.json
// EXACTLY (deep-equal: amounts to the cent, ratios at the dataset's own 2/3/4-dp rounding, whole-dollar
// history series) from the committed CSV plus scripts/property-financials/config/**, and its output must
// pass the strict contract. A block that cannot be regenerated is a finding: the diff printer below names
// every path, nothing is loosened.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset, PF_ENTITY_IDS } from '@contracts/property-financials';
import { parseMonthlyLong } from '@analytics/property-financials/aggregate';
import { buildDataset, parseCuratedInputs, parseDerivationConfig, parseEntityRegistry } from '@analytics/property-financials/build-dataset';
import { loadCsvText, loadDatasetText } from './property-financials-helpers';

const root = process.cwd();
const CONFIG_DIR = resolve(root, 'scripts', 'property-financials', 'config');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

const REGISTRY = parseEntityRegistry(readJson(resolve(CONFIG_DIR, 'entities.json')));
const DERIVATION = parseDerivationConfig(readJson(resolve(CONFIG_DIR, 'derivation.v1.json')));
const CURATED = parseCuratedInputs({
  meta: readJson(resolve(CONFIG_DIR, 'curated', 'meta.json')),
  insights: readJson(resolve(CONFIG_DIR, 'curated', 'insights.json')),
  leases: readJson(resolve(CONFIG_DIR, 'curated', 'leases.json')),
  data_quality: readJson(resolve(CONFIG_DIR, 'curated', 'data_quality.json')),
  sf: readJson(resolve(CONFIG_DIR, 'curated', 'sf.json')),
});
const MAPPING = readJson(resolve(CONFIG_DIR, 'account-mapping.v1.json')) as { categories: { revenue: string[]; opex: string[]; below_line: Record<string, string> } };

const ROWS = parseMonthlyLong(loadCsvText());
const COMMITTED_RAW = JSON.parse(loadDatasetText()) as Record<string, unknown>;

/**
 * Python wrote `-0.0` for a few ratios that round to zero from below (e.g. yoy opex -0.0004 -> -0.0).
 * JSON.stringify cannot emit a negative zero and pyRound never returns one, so the only sanctioned
 * difference between built and committed is -0 vs 0. Counted and pinned, not waved through.
 */
function normalizeNegativeZero(v: unknown, count: { n: number }): unknown {
  if (typeof v === 'number') {
    if (Object.is(v, -0)) count.n++;
    return v === 0 ? 0 : v;
  }
  if (Array.isArray(v)) return v.map((x) => normalizeNegativeZero(x, count));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeNegativeZero(x, count)]));
  return v;
}
const NEG_ZEROS = { n: 0 };
const COMMITTED = normalizeNegativeZero(COMMITTED_RAW, NEG_ZEROS) as Record<string, unknown>;
const BUILT = buildDataset({ rows: ROWS, registry: REGISTRY, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories }) as unknown as Record<string, unknown>;

/** Every leaf path where two JSON values differ (type, value or key set). */
function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 40): string[] {
  if (out.length >= limit) return out;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(`${path}: ${Array.isArray(a) ? 'array' : typeof a} vs ${Array.isArray(b) ? 'array' : typeof b}`);
      return out;
    }
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of ka) if (!kb.includes(k)) out.push(`${path}.${k}: only in built`);
    for (const k of kb) if (!ka.includes(k)) out.push(`${path}.${k}: only in committed`);
    for (const k of ka) if (kb.includes(k)) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, limit);
    return out;
  }
  if (!Object.is(a, b) && !(typeof a === 'number' && typeof b === 'number' && a === b)) out.push(`${path}: built ${JSON.stringify(a)} vs committed ${JSON.stringify(b)}`);
  return out;
}

function expectBlockEqual(block: string): void {
  const diffs = diffPaths(BUILT[block], COMMITTED[block], block);
  expect(diffs, `${block}: ${diffs.length} difference(s)\n${diffs.join('\n')}`).toEqual([]);
}

describe('buildDataset regenerates the committed dataset.json from the CSV + config', () => {
  for (const block of ['meta', 'portfolio', 'properties', 'monthly', 'account_movers', 'history', 'sf', 'insights', 'leases', 'data_quality']) {
    it(`${block} block is identical`, () => expectBlockEqual(block));
  }

  it('has exactly the committed top-level keys and nothing else', () => {
    expect(Object.keys(BUILT).sort()).toEqual(Object.keys(COMMITTED).sort());
  });

  it('the committed file holds exactly three Python negative zeros and nothing else differs by sign of zero', () => {
    expect(NEG_ZEROS.n).toBe(3);
    const builtNegZeros = { n: 0 };
    normalizeNegativeZero(BUILT, builtNegZeros);
    expect(builtNegZeros.n).toBe(0);
  });

  it('whole dataset is deep-equal and passes the strict contract', () => {
    expect(BUILT).toEqual(COMMITTED);
    const parsed = parsePropertyFinancialsDataset(JSON.parse(JSON.stringify(BUILT)));
    expect(Object.keys(parsed.properties).sort()).toEqual([...PF_ENTITY_IDS].sort());
  });

  it('is deterministic: building twice gives byte-identical JSON', () => {
    const again = buildDataset({ rows: ROWS, registry: REGISTRY, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories });
    expect(JSON.stringify(again)).toBe(JSON.stringify(BUILT));
  });
});

describe('builder fails loud instead of guessing', () => {
  it('rejects a CSV entity missing from the registry, and a registry entity with no CSV rows', () => {
    const extraRow = { ...ROWS[0]!, entity: 'Ghost Plaza' };
    expect(() => buildDataset({ rows: [...ROWS, extraRow], registry: REGISTRY, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories })).toThrow(/Ghost Plaza.*registry/);
    const reg2 = { ...REGISTRY, entities: [...REGISTRY.entities, { ...REGISTRY.entities[0]!, id: 'Ghost Plaza', canonicalId: 'ghost' }] };
    expect(() => buildDataset({ rows: ROWS, registry: reg2, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories })).toThrow(/Ghost Plaza.*no rows/);
  });

  it('rejects a revenue/opex category outside the declared lists (an unmapped account can never vanish into NOI)', () => {
    const badRow = { ...ROWS[0]!, line_type: 'opex' as const, category: 'Mystery' };
    expect(() => buildDataset({ rows: [...ROWS, badRow], registry: REGISTRY, curated: CURATED, derivation: DERIVATION, categories: MAPPING.categories })).toThrow(/Mystery/);
  });
});
