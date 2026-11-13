// tests/unit/rct-runtime-config.test.ts
//
// The fail-closed paths of the local-only Replacement-Cost Table (docs/ops/rct-runtime-config.md): the keyed-HMAC pin,
// the plausibility bounds, the raw-is-canonical rule, the synthetic refusal, and the loader's missing-file / bad-JSON
// errors. Runs in CI on the committed synthetic stand-in, with a TEST key and a TEST pin computed here, so the real
// table and the real key are never needed. Replaces the plain-SHA-256 content pin and the per-row value pins this repo
// carried while the table was tracked (refute wf_fe1b0b9e-3b2: without this file a no-op assertPinnedRct passed CI).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReplacementCostTable } from '@contracts/acquisition';
import { loadRatifiedRct, loadReplacementCostTable } from '../../server/warehouse/acquisition';
import {
  assertPinnedRct, assertPlausibleRct, assertRawIsCanonical, PIN_KEY_MIN_LENGTH, RATIFIED_RCT_HMAC, RCT_PIN_KEY_ENV, rctTableHmac,
} from '../../server/warehouse/rct-pin';
import { syntheticRctRaw } from '../support/rct';

type Json = Record<string, unknown>;
const TEST_KEY = 'test-only-key-'.padEnd(48, 'x');
const dir = mkdtempSync(join(tmpdir(), 'rct-runtime-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The stand-in with its synthetic marker removed: invented figures standing in for a ratified table. */
function ratifiedLike(): Json {
  const j = syntheticRctRaw();
  delete j._synthetic;
  return j;
}
let n = 0;
function writeTable(j: unknown, raw?: string): string {
  const p = join(dir, `t${n++}.json`);
  writeFileSync(p, raw ?? JSON.stringify(j, null, 2));
  return p;
}
const pinOf = (j: Json): string => rctTableHmac(ReplacementCostTable.parse(j), TEST_KEY);
const PIN = pinOf(ratifiedLike());
const env = { [RCT_PIN_KEY_ENV]: TEST_KEY };
const load = (p: string, e: Record<string, string | undefined> = env) => loadRatifiedRct(p, { pinnedHmac: PIN, env: e });

describe('keyed-HMAC pin', () => {
  it('a table equal to the pinned one loads', () => {
    expect(load(writeTable(ratifiedLike())).rctVersion).toBe(ratifiedLike().rctVersion);
  });

  it.each([
    ['a market LOW', (j: Json) => { ((j.markets as Json)['Columbus OH'] as Json).low = (((j.markets as Json)['Columbus OH'] as Json).low as number) + 0.01; }],
    ['a market proxy flag', (j: Json) => { ((j.markets as Json)['Columbus OH'] as Json).proxy = !((j.markets as Json)['Columbus OH'] as Json).proxy; }],
    ['the fallback LOW', (j: Json) => { (j.psf as Json).low = ((j.psf as Json).low as number) - 0.01; }],
    ['a construction multiplier', (j: Json) => { (j.constructionMultipliers as Json).cmu = ((j.constructionMultipliers as Json).cmu as number) + 0.01; }],
    ['a PEMB band', (j: Json) => { ((j.constructionMultipliers as Json).pemb as Json).under20k = (((j.constructionMultipliers as Json).pemb as Json).under20k as number) + 0.01; }],
    ['an adder', (j: Json) => { (j.adders as Json).esfr = ((j.adders as Json).esfr as number) + 1; }],
    ['the version', (j: Json) => { j.ratifiedDate = '2000-01-02'; }],
    ['a dropped market', (j: Json) => { delete (j.markets as Json)['Columbus OH']; }],
  ])('changing %s fails the pin', (_what, mutate) => {
    const j = ratifiedLike();
    mutate(j);
    expect(() => load(writeTable(j))).toThrow(/does not match the ratified table/);
  });

  it('key order and number formatting do not move the pin (canonical form)', () => {
    const j = ratifiedLike();
    const reordered = Object.fromEntries(Object.entries(j).reverse());
    const text = JSON.stringify(reordered, null, 1).replace(/(\d+\.\d*[1-9])(\d*)/g, '$1$2'); // same numbers, other layout
    expect(() => load(writeTable(null, text))).not.toThrow();
    expect(pinOf(reordered)).toBe(PIN);
  });

  it('the pin depends on the key: another key gives another HMAC', () => {
    expect(rctTableHmac(ReplacementCostTable.parse(ratifiedLike()), 'another-test-key-'.padEnd(48, 'y'))).not.toBe(PIN);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['too short', 'k'.repeat(PIN_KEY_MIN_LENGTH - 1)],
  ])('a %s key fails closed', (_what, key) => {
    expect(() => load(writeTable(ratifiedLike()), { [RCT_PIN_KEY_ENV]: key })).toThrow(/RCT_PIN_KEY is not set/);
  });

  it('the default options check the COMMITTED pin: a table pinned under a test key is refused in production posture', () => {
    expect(() => loadRatifiedRct(writeTable(ratifiedLike()), { env })).toThrow(/does not match the ratified table/);
    expect(() => loadRatifiedRct(writeTable(ratifiedLike()), { env: {} })).toThrow(/RCT_PIN_KEY is not set/);
    expect(RATIFIED_RCT_HMAC).not.toBe(PIN);
  });

  it('assertPinnedRct compares the full HMAC (a prefix or a different length never matches)', () => {
    const t = ReplacementCostTable.parse(ratifiedLike());
    expect(() => assertPinnedRct(t, TEST_KEY, PIN)).not.toThrow();
    expect(() => assertPinnedRct(t, TEST_KEY, PIN.slice(0, 32))).toThrow(/does not match/);
    expect(() => assertPinnedRct(t, TEST_KEY, `${PIN}0`)).toThrow(/does not match/);
  });
});

describe('the raw file must be its parsed form (what the pin hashes is what the drawer reads)', () => {
  it('a market row with no proxy key (parsed as proxy:false) is refused, not silently pinned', () => {
    const j = ratifiedLike();
    const row = Object.entries(j.markets as Record<string, Json>).find(([, r]) => r.proxy === false)!;
    delete row[1].proxy;
    expect(pinOf(j)).toBe(PIN); // the parsed form is identical, so the HMAC alone cannot see it
    expect(() => load(writeTable(j))).toThrow(/drops or defaults/);
  });

  it('an unknown field (stripped by the parser) is refused; _-prefixed top-level notes are allowed', () => {
    const extra = ratifiedLike();
    ((extra.markets as Json)['Columbus OH'] as Json).note = 'x';
    expect(() => load(writeTable(extra))).toThrow(/drops or defaults/);
    const noted = { ...ratifiedLike(), _comment: 'prose', _v9_note: 'prose' };
    expect(() => load(writeTable(noted))).not.toThrow();
  });

  it('assertRawIsCanonical accepts the stand-in itself', () => {
    const raw = ratifiedLike();
    expect(() => assertRawIsCanonical(raw, ReplacementCostTable.parse(raw))).not.toThrow();
  });
});

describe('plausibility bounds (apply to any table, pinned or not)', () => {
  it.each([
    ['a LOW typed in thousands', (j: Json) => { ((j.markets as Json)['Columbus OH'] as Json).low = 0.25; }],
    ['a POINT above the ceiling', (j: Json) => { ((j.markets as Json)['Columbus OH'] as Json).point = 5000; }],
    ['a band out of order', (j: Json) => { const r = (j.markets as Json)['Columbus OH'] as Json; r.low = (r.high as number) + 1; }],
    ['a fallback out of order', (j: Json) => { const p = j.psf as Json; p.mid = (p.high as number) + 1; }],
    ['a multiplier of 9', (j: Json) => { (j.constructionMultipliers as Json).brick = 9; }],
    ['an adder typed as a total', (j: Json) => { (j.adders as Json).cranes = 250_000; }],
  ])('%s fails closed', (_what, mutate) => {
    const j = ratifiedLike();
    mutate(j);
    const parsed = ReplacementCostTable.safeParse(j);
    if (parsed.success) expect(() => assertPlausibleRct(parsed.data)).toThrow(/plausible|out of order/);
    expect(() => loadRatifiedRct(writeTable(j), { pinnedHmac: null })).toThrow();
  });
});

describe('loader fail-closed errors', () => {
  it('the synthetic stand-in is refused unless code allows it', () => {
    const p = writeTable(syntheticRctRaw());
    expect(() => loadReplacementCostTable(p)).toThrow(/synthetic test stand-in/);
    expect(() => loadRatifiedRct(p, { pinnedHmac: null })).toThrow(/synthetic test stand-in/);
    expect(loadRatifiedRct(p, { allowSynthetic: true, pinnedHmac: null }).rctVersion).toBe(syntheticRctRaw().rctVersion);
  });

  it('a missing file names the doc, not a figure', () => {
    expect(() => loadRatifiedRct(join(dir, 'absent.json'))).toThrow(/not found .*docs\/ops\/rct-runtime-config\.md/);
  });

  it('bad JSON fails closed', () => {
    expect(() => loadRatifiedRct(writeTable(null, '{ "rctVersion": '))).toThrow(/not valid JSON/);
  });

  it('no loader error message carries a figure from the table', () => {
    const figures = new Set<string>();
    const j = ratifiedLike();
    for (const r of Object.values(j.markets as Record<string, Json>)) for (const v of [r.low, r.point, r.high]) figures.add(String(v));
    const msgs: string[] = [];
    for (const attempt of [
      () => load(writeTable({ ...j, adders: { ...(j.adders as Json), esfr: 99 } })),
      () => load(writeTable(j), {}),
      () => loadRatifiedRct(writeTable({ ...j, psf: { low: 1, mid: 2, high: 3 } }), { pinnedHmac: null }),
    ]) {
      try { attempt(); } catch (e) { msgs.push((e as Error).message); }
    }
    expect(msgs).toHaveLength(3);
    for (const m of msgs) for (const f of figures) expect(m.includes(f)).toBe(false);
  });
});
