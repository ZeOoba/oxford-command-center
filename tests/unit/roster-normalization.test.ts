// Refute R1 (2026-10-13): the roster scan was an exact lowercase substring match, so trivially
// re-spaced, re-punctuated, zero-width-split or full-width variants of a roster term slipped past
// every PUBLICATION gate (comps egress, the mergeDeals roster override, the redacted-bake scan).
// publicationRosterScan now normalises both sides. Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { publicationRosterScan, rosterClaimsDeal, normalizeRosterText } from '../../server/sources/deal-declassification';
import { mergeDeals } from '../../server/sources/notion-deals';
import { fetchDealComps } from '../../server/ai/comps';
import { redactAcquisitionPayload } from '../../scripts/bake-warehouse';

vi.mock('../../server/brain', () => ({ brain: { getSnapshot: vi.fn(() => null) } }));

import { SYNTHETIC_ROSTER as ROSTER, ROSTER_VARIANTS as VARIANTS, ROSTER_VALUE_VARIANTS as VALUE_VARIANTS } from './roster-variants';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

let dir: string;
const orig = process.env.CONFIDENTIAL_TERMS_PATH;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-norm-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (orig === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = orig;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('normalizeRosterText', () => {
  it('folds width, strips zero-width chars, maps separators to one space, lowercases', () => {
    expect(normalizeRosterText('  Ａb​-c__d  E. ')).toBe('ab c d e');
  });
});

describe('publicationRosterScan catches obfuscated variants', () => {
  it.each(VARIANTS)('%s', (_name, text) => {
    expect(publicationRosterScan(text)).not.toBeNull();
  });
  it.each(VALUE_VARIANTS)('value: %s', (_name, value) => {
    expect(publicationRosterScan(value)).not.toBeNull();
  });
  it('still clears unrelated text (no over-match)', () => {
    expect(publicationRosterScan('9901 Quarry Rd; Heron Lake')).toBeNull();
  });
  it('KNOWN, ACCEPTED fail-closed over-match: a term split across a sentence boundary still matches', () => {
    // Punctuation maps to a space, so "...unit 9900. Quarry tours resume..." reads as "9900 quarry".
    // Accepted by design (refute S2): a false positive only withholds data; a false negative leaks it.
    expect(publicationRosterScan('Suite count was 9900. Quarry tours resume Monday.')).not.toBeNull();
  });
});

describe('rosterClaimsDeal / mergeDeals (seed un-flag path)', () => {
  it.each(VARIANTS)('%s', (_name, text) => {
    expect(rosterClaimsDeal(deal({ location: text }))).toBe(true);
    const out = mergeDeals([deal({ id: 's', name: 'Plain', location: text, confidential: false })], []);
    expect(out.find((d) => d.id === 's')!.confidential).toBe(true);
  });
});

describe('fetchDealComps egress guard', () => {
  it.each(VARIANTS)('%s', async (_name, text) => {
    const calls: number[] = [];
    const f = (async () => { calls.push(1); return { ok: true, status: 200, json: async () => ({ content: [] }) }; }) as unknown as typeof fetch;
    const r = await fetchDealComps(deal({ name: 'Anon', location: text }), { apiKey: 'sk-test', now: '2026-10-13T00:00:00Z', fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('redacted-bake route scan', () => {
  it.each(VARIANTS)('%s', (_name, text) => {
    const payload = { openQuestions: [{ kind: 'data-quality', title: 'x', detail: text, wouldClose: 'y' }], trackRecord: [] };
    expect(redactAcquisitionPayload('/brain/report', payload, { nonDealSubjects: new Set(), scan: publicationRosterScan })).toBeNull();
  });
  it.each(VALUE_VARIANTS)('value: %s', (_name, value) => {
    const payload = { openQuestions: [{ kind: 'data-quality', title: 'x', detail: value, wouldClose: 'y' }], trackRecord: [] };
    expect(redactAcquisitionPayload('/brain/report', payload, { nonDealSubjects: new Set(), scan: publicationRosterScan })).toBeNull();
  });
});
