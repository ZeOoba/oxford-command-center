// Refute round 2, S1: the highest-volume egress gates still used the raw exact-substring scanner, so
// a line-wrapped / soft-hyphenated / NBSP / ideographic-space variant of a roster term reached the
// Anthropic API: OM extraction (PDF body), the AI agent's per-tool-result scan (server/index.ts),
// and the briefing / lease narrative pre-send and post-receive scans. They now share rosterMatch:
// the same raw pass plus the normalised pass, with each caller's existing placeholder and
// fail-closed behaviour unchanged. Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rosterMatch, assertNoRosterMatch } from '../../server/briefing/roster-match';
import { extractOmFields } from '../../server/warehouse/om-extract';
import { composeLeaseNarrative } from '../../server/ai/narrative';
import { SYNTHETIC_ROSTER, ROSTER_VARIANTS, ROSTER_VALUE_VARIANTS } from './roster-variants';

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'egress-norm-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(SYNTHETIC_ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const trackingFetch = (responseText = '{}') => {
  const calls: number[] = [];
  const f = (async () => {
    calls.push(1);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: responseText }] }), text: async () => responseText };
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('rosterMatch (shared egress matcher)', () => {
  it.each(ROSTER_VARIANTS)('%s', (_n, text) => {
    expect(rosterMatch(text)).not.toBeNull();
    expect(() => assertNoRosterMatch({ text })).toThrow(/confidential/i);
  });
  it.each(ROSTER_VALUE_VARIANTS)('value: %s', (_n, value) => {
    expect(rosterMatch(value)).not.toBeNull();
    expect(() => assertNoRosterMatch({ value })).toThrow(/confidential/i);
  });
  it('U1 perf: a multi-MB haystack scans linearly (no backtracking)', () => {
    // Pathological-for-regex shape: long runs of hyphens, spaces and newlines plus mixed text.
    // Refute round 6, G5: compares 1x vs 4x input (min of two runs) instead of an absolute bound
    // that flaked under load; linear is ~4x, quadratic ~16x.
    const chunk = 'Industrial OM - 22,000 SF -   \n  - clear height 24 ft; ' + '-'.repeat(50) + ' '.repeat(50) + '\n';
    const of = (bytes: number) => chunk.repeat(Math.ceil(bytes / chunk.length));
    const small = of(768 * 1024);
    const big = of(3 * 1024 * 1024);
    const minTime = (s: string) => {
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        expect(rosterMatch(s)).toBeNull();
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    const ts = minTime(small);
    const tl = minTime(big);
    expect(tl / Math.max(ts, 5)).toBeLessThan(10);
    expect(tl).toBeLessThan(20_000);
    expect(rosterMatch(big + ' 9 9 0 0 Q U A R R Y')).not.toBeNull();
  });
  it('clean text passes', () => {
    expect(rosterMatch('Industrial OM, 22,000 SF, 24 ft clear')).toBeNull();
  });
  it('still THROWS on an unreadable roster (fail closed, unchanged)', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(() => rosterMatch('anything')).toThrow();
  });
  it('still honours the explicit placeholder opt-out (unchanged semantics: degrade, not throw)', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(rosterMatch('anything')).toBeNull();
  });
});

describe('extractOmFields default egress scan (PDF body) catches every variant', () => {
  it.each(ROSTER_VARIANTS)('%s', async (_n, text) => {
    const { f, calls } = trackingFetch();
    const r = await extractOmFields(Buffer.from('x'), {
      apiKey: 'sk-test', fetchImpl: f, pdfParseFn: async () => ({ text: `Offering Memorandum\n${text}\n22,000 SF` }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

const LEASE_INPUT = (extra: string) => ({
  asOf: '2026-10-01', propertyCount: 1,
  signalSummary: { likelyCt: 0, uncertainCt: 0, unlikelyCt: 0 },
  note: extra,
}) as unknown as Parameters<typeof composeLeaseNarrative>[0];

describe('narrative pre-send guard degrades (no HTTP) on every variant', () => {
  it.each(ROSTER_VARIANTS)('%s', async (_n, text) => {
    const { f, calls } = trackingFetch();
    const r = await composeLeaseNarrative(LEASE_INPUT(text), { apiKey: 'sk-test', fetchImpl: f });
    expect(r).toEqual({ narrative: null, degraded: true });
    expect(calls).toHaveLength(0);
  });
});

describe('narrative pre-send guard degrades (no HTTP) on every structured variant', () => {
  it.each(ROSTER_VALUE_VARIANTS)('%s', async (_n, value) => {
    const { f, calls } = trackingFetch();
    const input = { ...LEASE_INPUT('clean'), note: value } as unknown as Parameters<typeof composeLeaseNarrative>[0];
    const r = await composeLeaseNarrative(input, { apiKey: 'sk-test', fetchImpl: f });
    expect(r).toEqual({ narrative: null, degraded: true });
    expect(calls).toHaveLength(0);
  });
});

describe('narrative post-receive scan discards AI output carrying any variant', () => {
  it.each(ROSTER_VARIANTS)('%s', async (_n, text) => {
    const { f, calls } = trackingFetch(JSON.stringify({ headline: 'Leasing update', summary: `Watch ${text}.`, bullets: ['a', 'b', 'c'] }));
    const r = await composeLeaseNarrative(LEASE_INPUT('clean'), { apiKey: 'sk-test', fetchImpl: f });
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ narrative: null, degraded: true });
  });
  it('control: clean AI output is kept', async () => {
    const { f } = trackingFetch(JSON.stringify({ headline: 'Leasing update', summary: 'Steady.', bullets: ['a', 'b', 'c'] }));
    const r = await composeLeaseNarrative(LEASE_INPUT('clean'), { apiKey: 'sk-test', fetchImpl: f });
    expect(r.degraded).toBe(false);
  });
});
