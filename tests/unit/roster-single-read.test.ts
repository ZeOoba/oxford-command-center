// #478 item 2: the two-read placeholder race. The egress / publication gates probed for the
// placeholder roster on one roster read and scanned on a SECOND read. Under
// CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1, a roster that turned unreadable between the two (a
// mid-write, an editor's atomic replace) passed the probe as real and was then scanned as
// FALLBACK_TERMS, which matches nothing: fail OPEN. Every gate now reads the roster ONCE per decision
// through loadEgressTerms, which never returns the placeholder. Synthetic roster only; node:fs is
// wrapped so a test can make the roster unreadable on a chosen read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';

// Reads of the roster path go through `rosterRead`: each call takes the next scripted outcome
// ('ok' = the real file, 'gone' = ENOENT). Other paths are untouched.
const script: Array<'ok' | 'gone'> = [];
let rosterPath = '';
let rosterReads = 0;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readFileSync = ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (rosterPath && String(p) === rosterPath) {
      rosterReads++;
      if ((script.shift() ?? 'ok') === 'gone') {
        throw Object.assign(new Error(`ENOENT: no such file, open '${String(p)}'`), { code: 'ENOENT' });
      }
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { loadEgressTerms, loadConfidentialTerms, isPlaceholderRoster, RosterSchemaError } = await import('../../server/briefing/confidential');
const { egressRosterMatch, egressRosterScanner } = await import('../../server/briefing/roster-match');
const { agentEgressGuards, omExtractEgressGuards } = await import('../../server/ai/egress-guards');
const { tightenDeals } = await import('../../server/ai/deal-name-gate');
const { fetchDealComps } = await import('../../server/ai/comps');
const { rosterClaimsDeal, rosterClaimChecker, syncPassRosterClaims, isDeclassified, publicationRosterScan, egressScan, dealConfidentialForEgress } =
  await import('../../server/sources/deal-declassification');

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});
const CLAIMED = deal({ id: 'pub', name: '9900 Quarry Yard' });
const PUBLIC = deal({ id: 'pub', name: 'Public Flex Center' });

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-1read-'));
  rosterPath = join(dir, 't.json');
  writeFileSync(rosterPath, JSON.stringify({ syn: { label: 'Synthetic', active: true, always: ['9900 quarry'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = rosterPath;
  process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1'; // the opt-out the race needs
  script.length = 0;
  rosterReads = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rosterPath = '';
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadEgressTerms: strict single-read loader', () => {
  it('returns the real roster on one read', () => {
    const t = loadEgressTerms();
    expect(Object.keys(t)).toEqual(['syn']);
    expect(isPlaceholderRoster(t)).toBe(false);
    expect(rosterReads).toBe(1);
  });
  it('throws on an unreadable roster EVEN under the placeholder opt-out (never returns the placeholder)', () => {
    script.push('gone');
    expect(() => loadEgressTerms()).toThrow(/placeholder/i);
    expect(rosterReads).toBe(1);
  });
  it.each([
    ['an empty object', {}],
    ['only "_" metadata keys', { _note: 'retired', _schema: 1 }],
  ])('throws on an EMPTY roster (%s) even under the opt-out', (_n, body) => {
    writeFileSync(rosterPath, JSON.stringify(body), 'utf8');
    expect(() => loadEgressTerms()).toThrow(/absent, unreadable or empty/);
    expect(() => egressScan('clean text')).toThrow();
    expect(rosterClaimsDeal(PUBLIC)).toBe(true);
    expect(isDeclassified(PUBLIC, ['pub'])).toBe(false);
  });
  it('throws on an unparseable roster even under the opt-out', () => {
    writeFileSync(rosterPath, '{ not json', 'utf8');
    expect(() => loadEgressTerms()).toThrow(/absent, unreadable or empty/);
  });
  it('a malformed active entry still throws RosterSchemaError (Wave 1 validateEntry), not the generic refusal', () => {
    writeFileSync(rosterPath, JSON.stringify({ syn: { active: true, always: [] } }), 'utf8');
    expect(() => loadEgressTerms()).toThrow(RosterSchemaError);
  });
  it('throws without the opt-out too', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    script.push('gone');
    expect(() => loadEgressTerms()).toThrow();
  });
  it('the render loader keeps its documented placeholder concession (unchanged)', () => {
    script.push('gone');
    expect(isPlaceholderRoster(loadConfidentialTerms())).toBe(true);
  });
});

describe('the placeholder state (roster file absent, opt-out set) is refused by every egress gate', () => {
  beforeEach(() => { process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json'); rosterPath = ''; });
  it('the render loader returns the placeholder there, so the egress gates must not', () => {
    expect(isPlaceholderRoster(loadConfidentialTerms())).toBe(true);
    expect(() => loadEgressTerms()).toThrow(/placeholder/i);
    expect(() => egressRosterScanner()).toThrow(/placeholder/i);
    expect(() => egressRosterMatch('clean text')).toThrow(/placeholder/i);
    expect(() => egressScan('clean text')).toThrow(/placeholder/i);
    expect(() => publicationRosterScan({ name: 'Public Yard' })).toThrow(/placeholder/i);
    expect(rosterClaimsDeal(PUBLIC)).toBe(true);
    expect(rosterClaimChecker()(PUBLIC)).toBe(true);
    expect(dealConfidentialForEgress(PUBLIC)).toBe(true);
    expect(isDeclassified(PUBLIC, ['pub'])).toBe(false);
  });
});

describe('every egress / publication gate reads the roster exactly once per decision', () => {
  it.each([
    ['egressRosterMatch', () => egressRosterMatch('clean text')],
    ['egressRosterScanner', () => egressRosterScanner()('clean text')],
    ['publicationRosterScan', () => publicationRosterScan({ name: 'Public Yard' })],
    ['egressScan', () => egressScan('clean text')],
    ['dealConfidentialForEgress', () => dealConfidentialForEgress(PUBLIC)],
    ['rosterClaimsDeal', () => rosterClaimsDeal(PUBLIC)],
    ['isDeclassified', () => isDeclassified(PUBLIC, ['pub'])],
  ])('%s', (_n, run) => {
    run();
    expect(rosterReads).toBe(1);
  });
  it('rosterClaimChecker reads once for a whole batch', () => {
    const claims = rosterClaimChecker();
    expect([CLAIMED, PUBLIC, PUBLIC, CLAIMED].map(claims)).toEqual([true, false, false, true]);
    expect(rosterReads).toBe(1);
  });
});

describe('the race: roster readable on the first read, unreadable on the second (opt-out set)', () => {
  // Before the fix the probe consumed 'ok' and the scan consumed 'gone' -> FALLBACK_TERMS -> no hit.
  const race = () => script.push('ok', 'gone', 'gone', 'gone');

  it('egressScan finds the hit or throws, never a clean null', () => {
    race();
    let out: unknown = 'threw';
    try { out = egressScan('the 9900 Quarry Yard deal'); } catch { /* fail closed */ }
    expect(out).not.toBeNull();
  });
  it('egressScan throws (never a clean null) when its one read is the failing one', () => {
    script.push('gone', 'ok');
    expect(() => egressScan('the 9900 Quarry Yard deal')).toThrow(/placeholder/i);
  });
  it('dealConfidentialForEgress keeps the roster deal confidential', () => {
    race();
    expect(dealConfidentialForEgress(CLAIMED)).toBe(true);
  });
  it('rosterClaimsDeal still claims the roster deal', () => {
    race();
    expect(rosterClaimsDeal(CLAIMED)).toBe(true);
  });
  it('isDeclassified keeps the roster deal confidential', () => {
    race();
    expect(isDeclassified(CLAIMED, ['pub'])).toBe(false);
  });
  it('publicationRosterScan finds the hit', () => {
    race();
    expect(publicationRosterScan(CLAIMED)).not.toBeNull();
  });
  it('rosterClaimChecker claims every deal when its one read fails (fail closed)', () => {
    script.push('gone');
    const claims = rosterClaimChecker();
    expect([CLAIMED, PUBLIC].map(claims)).toEqual([true, true]);
  });
  it('a roster that comes BACK between reads cannot clear a deal the failed read refused', () => {
    script.push('gone', 'ok');
    expect(isDeclassified(PUBLIC, ['pub'])).toBe(false);
    expect(rosterClaimsDeal(PUBLIC)).toBe(false); // second call: its own single read, roster back
  });
});

describe('pre-send gate cost (#478 LOW): one roster read per decision, not per deal', () => {
  const many = Array.from({ length: 12 }, (_, i) => deal({ id: `p${i}`, name: `Public Flex ${i}` }));

  it('the agent dealClaimed predicate reads once per synchronous pass over the deals', async () => {
    const { dealClaimed } = agentEgressGuards();
    tightenDeals(many, dealClaimed);
    expect(rosterReads).toBe(1);
    await Promise.resolve(); // the next pass (after an await) must see a roster edit: a fresh read
    tightenDeals(many, dealClaimed);
    expect(rosterReads).toBe(2);
  });
  it('the per-pass predicate still claims the roster deal and fails closed on a failed read', async () => {
    const claims = syncPassRosterClaims();
    expect([PUBLIC, CLAIMED].map(claims)).toEqual([false, true]);
    await Promise.resolve();
    script.push('gone');
    expect([PUBLIC, CLAIMED].map(claims)).toEqual([true, true]);
  });
  it('the OM deal-name gate reads once for every served deal', () => {
    const g = omExtractEgressGuards(undefined, false, { deals: many });
    expect(g.mentionsConfidentialDeal!('Public Flex 3 offering memorandum')).toBe(false);
    expect(rosterReads).toBe(1);
  });
  it('comps reads once for the record AND the prompt (unclaimed deal: both scans run)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }));
    await fetchDealComps(PUBLIC, { apiKey: 'sk-test', now: '2026-10-16T00:00:00Z', fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1); // cleared both scans and reached the (stubbed) API
    expect(rosterReads).toBe(1);
  });
  it('comps blocks a roster-claimed deal before any fetch', async () => {
    const f = vi.fn();
    const r = await fetchDealComps(CLAIMED, { apiKey: 'sk-test', now: '2026-10-16T00:00:00Z', fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/matches an active confidential deal/) });
    expect(f).not.toHaveBeenCalled();
  });
  it('comps still honours an injected prompt scan that reports a hit', async () => {
    const f = vi.fn();
    const r = await fetchDealComps(PUBLIC, {
      apiKey: 'sk-test', now: '2026-10-16T00:00:00Z', fetchImpl: f as unknown as typeof fetch,
      confidentialScan: () => ({ dealLabel: 'injected' }),
    });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/matches an active confidential deal/) });
    expect(f).not.toHaveBeenCalled();
  });
  it('comps refuses when its one read is unreadable (opt-out set)', async () => {
    script.push('gone');
    const f = vi.fn();
    const r = await fetchDealComps(PUBLIC, { apiKey: 'sk-test', now: '2026-10-16T00:00:00Z', fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/could not be verified/) });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('rosterClaimChecker: a per-deal scan throw counts as claimed', () => {
  it('a deal whose scan throws is claimed; its neighbours are judged normally', () => {
    const hostile = { ...PUBLIC, toJSON() { throw new Error('hostile'); } } as unknown as Deal;
    const claims = rosterClaimChecker();
    expect([PUBLIC, hostile, CLAIMED].map(claims)).toEqual([false, true, true]);
    expect(rosterReads).toBe(1);
  });
});
