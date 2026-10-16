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

const { loadEgressTerms, loadConfidentialTerms, isPlaceholderRoster } = await import('../../server/briefing/confidential');
const { egressRosterMatch, egressRosterScanner } = await import('../../server/briefing/roster-match');
const { rosterClaimsDeal, rosterClaimChecker, isDeclassified, publicationRosterScan } =
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

describe('every egress / publication gate reads the roster exactly once per decision', () => {
  it.each([
    ['egressRosterMatch', () => egressRosterMatch('clean text')],
    ['egressRosterScanner', () => egressRosterScanner()('clean text')],
    ['publicationRosterScan', () => publicationRosterScan({ name: 'Public Yard' })],
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
