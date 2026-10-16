// Refute round 5, F6. Two parts:
//  - log hygiene: rosterEnforce (server/sources/notion-deals.ts) console-logged a roster-claimed
//    deal's id, which is a slug of its NAME, and isDeclassified logged the allowlisted deal's id on
//    a roster hit. Both now log a count / an allowlist position, never the id.
//  - scope of the token-boundary rule: it applies to the normalised pass (and the compact
//    alignment rules) only. The raw pass is still plain substring, so a term with no punctuation
//    over-matches a longer token. That is a fail-closed over-match, never a leak, and is pinned here
//    so no doc can claim the boundary rule applies everywhere.
// Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import type { DealTerms } from '../../server/briefing/confidential';
import { rosterEnforce } from '../../server/sources/notion-deals';
import { isDeclassified } from '../../server/sources/deal-declassification';
import { rosterMatchWithTerms } from '../../server/briefing/roster-match';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;
const saved = process.env.CONFIDENTIAL_TERMS_PATH;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-log-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic', active: true, always: ['kestrel ridge'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const logged = () => warn.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');

describe('F6: roster-claimed deal ids never reach a log', () => {
  it('rosterEnforce logs a count, not the id', () => {
    const out = rosterEnforce([
      deal({ id: 'kestrel-ridge-flex', name: 'Kestrel Ridge Flex' }),
      deal({ id: 'kestrel-ridge-two', name: 'Kestrel Ridge Two' }),
      deal({ id: 'plain', name: 'Plain' }),
    ]);
    expect(out.map((d) => d.confidential)).toEqual([true, true, false]);
    expect(logged()).not.toMatch(/kestrel/i);
    expect(logged()).toMatch(/2 deal/);
  });
  it('rosterEnforce logs nothing when the roster claims nothing', () => {
    rosterEnforce([deal({ id: 'plain', name: 'Plain' })]);
    expect(warn).not.toHaveBeenCalled();
  });
  it('isDeclassified logs an allowlist position, not the id, on a roster hit', () => {
    const allow = ['other-deal', 'kestrel-ridge-flex'];
    expect(isDeclassified(deal({ id: 'kestrel-ridge-flex', name: 'Kestrel Ridge Flex' }), allow)).toBe(false);
    expect(logged()).not.toMatch(/kestrel/i);
    expect(logged()).toMatch(/#2/);
  });
  it('isDeclassified logs no id on an unreadable roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(isDeclassified(deal({ id: 'kestrel-ridge-flex', name: 'X' }), ['kestrel-ridge-flex'])).toBe(false);
    expect(logged()).not.toMatch(/kestrel/i);
  });
});

describe('F6: token-boundary matching is a property of the normalised pass only', () => {
  const terms: Record<string, DealTerms> = { t: { label: 'T', active: true, always: ['Bay 12'] } };
  it('the raw pass is plain substring: an unpunctuated term over-matches a longer token (fail closed)', () => {
    expect(rosterMatchWithTerms('Bay 120 dock', terms)?.dealLabel).toBe('T');
  });
  it('the normalised pass alone keeps the boundary: a variant the raw pass cannot see does not over-match', () => {
    expect(rosterMatchWithTerms('Bay-120 dock', terms)).toBeNull();
  });
});
