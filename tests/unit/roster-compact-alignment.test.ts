// Refute round 4, W1: the compact pass ran on the JOINED haystack and accepted any substring, so
// separate words and separate fields merged into false positives that blocked agent questions,
// tool results, OM extraction and narratives, and quietly kept non-confidential deals confidential
// (rosterClaimsDeal / isDeclassified). The compact pass now runs per string leaf, accepts a hit only
// when it starts and ends on word boundaries of that leaf, and skips terms with a short token.
// Synthetic terms only, injected directly.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  a: { label: 'A', active: true, always: ['Westport'] },
  b: { label: 'B', active: true, always: ['Main St'] },
  c: { label: 'C', active: true, always: ['$4,250,000'] },
  d: { label: 'D', active: true, always: ['Suite #10'] },
};
const scan = (v: unknown) => rosterMatchWithTerms(v, terms);

describe('compact pass: no cross-word / cross-field false positives', () => {
  it.each<[string, unknown]>([
    ['"Strong Midwest portfolio" vs Westport', 'Strong Midwest portfolio'],
    ['"Vacancy remains tight" vs Main St', 'Vacancy remains tight'],
    ['"Building 42, 50,000 SF" vs $4,250,000', 'Building 42, 50,000 SF'],
    ['cross-field numbers vs $4,250,000', { sf: 42, rentPsf: 50, price: 0, note: '000 noted' }],
    ['"Suite 100" vs Suite #10', 'Suite 100'],
  ])('%s', (_n, v) => {
    expect(scan(v)).toBeNull();
  });
  it('DELIBERATE CHANGE (refute round 5, F5(e)): a word split across two sibling string leaves now matches', () => {
    // Was a W1 negative. Adjacent sibling strings are now also scanned concatenated (bounded), so
    // {a:'West', b:'port'} reads as "Westport": a fail-closed over-match, accepted because the same
    // shape is how a split-inside-a-word leak looks. Separate WORDS still never merge (see the
    // sibling-join negatives in roster-matcher-gaps.test.ts).
    expect(scan({ a: 'West', b: 'port' })?.dealLabel).toBe('A');
  });
});

describe('refute round 4, W2: anchor and context hits combine ACROSS passes', () => {
  const ctx: Record<string, DealTerms> = {
    x: { label: 'X', active: true, always: [], context: ['Lot 4'], context_requires_any: ['9900 Quarry'] },
  };
  it('anchor caught only by the compact pass + context caught cleanly => hit', () => {
    expect(rosterMatchWithTerms('9,900 Quarry Road, Lot 4', ctx)?.dealLabel).toBe('X');
  });
  it('still requires BOTH: anchor alone or context alone is no hit', () => {
    expect(rosterMatchWithTerms('9,900 Quarry Road', ctx)).toBeNull();
    expect(rosterMatchWithTerms('Lot 4 is vacant', ctx)).toBeNull();
  });
});

describe('true positives for the same terms still match', () => {
  it.each<[string, string, string]>([
    ['Westport Industrial Park', 'Westport', 'A'],
    ['West-port Industrial', 'West-port', 'A'],
    ['W E S T P O R T', 'letter-spaced', 'A'],
    ['123 Main St.', 'Main St', 'B'],
    ['priced at $4,250,000 firm', '$4,250,000', 'C'],
    ['priced at 4 250 000', 'spaced thousands', 'C'],
    ['Suite #10 lease', 'Suite #10', 'D'],
    ['suite 10, first floor', 'suite 10', 'D'],
  ])('%s', (text, _n, label) => {
    expect(scan(text)?.dealLabel).toBe(label);
  });
});
