// Refute round 7, H1: the document-order stream pass (G3) ran only for plain-compact terms, so a
// price or short term split mid-group ACROSS NESTING LEVELS missed, while the same text as one
// string or as direct siblings hit. The stream now also runs the strict sub-token alignment for the
// other terms, which keeps every all-digit / short-term negative (a break may be dropped or added,
// never moved). Synthetic terms only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  price: { label: 'Price', active: true, always: ['$3,875,000'] },
  bay: { label: 'Bay', active: true, always: ['Bay 12'] },
};
const scan = (v: unknown, t: Record<string, DealTerms> = terms) => rosterMatchWithTerms(v, t)?.dealLabel ?? null;
const one = (term: string): Record<string, DealTerms> => ({ c: { label: 'C', active: true, always: [term] } });

describe('H1: price / short terms split across nesting levels', () => {
  it.each<[string, unknown, string]>([
    ['one string (control)', '$3,875,000', 'Price'],
    ['direct siblings (control)', ['$3,87', '5,000'], 'Price'],
    ['parent / child array', ['$3,87', ['5,000']], 'Price'],
    ['value / nested record value', { a: '$3,87', b: { c: '5,000' } }, 'Price'],
    ['split inside the first group', ['3,8', ['75,000']], 'Price'],
    ['short term, parent / child', ['Ba', ['y 12']], 'Bay'],
    ['short term, key / value', { Ba: 'y 12' }, 'Bay'],
  ])('%s', (_n, v, label) => {
    expect(scan(v)).toBe(label);
  });

  it.each<[string, unknown, Record<string, DealTerms>]>([
    ['K.C. vs Back carriage across nesting', ['Back', ['carriage house']], one('K.C.')],
    ['Bldg #1 vs Bldg 10 across nesting', ['Bldg', ['10 roof']], one('Bldg #1')],
    ['Bldg #1 vs Bldg 10 as a key / value', { Bldg: '10 roof' }, one('Bldg #1')],
    ['Building 42, 50,000 SF across nesting', ['Building 42,', ['50,000 SF']], one('$4,250,000')],
    ['Suite #10 vs Suite 100 across nesting', ['Suite', ['100']], one('Suite #10')],
  ])('negative: %s', (_n, v, t) => {
    expect(rosterMatchWithTerms(v, t)).toBeNull();
  });

  // CHANGED by the merge with origin/main (c04bf53b): moved out of the negatives above, where each
  // was `expect(rosterMatchWithTerms(v, t)).toBeNull()`. rosterMatchWithTerms is now the OR of
  // main's normalised scanForConfidential and roster-core's matcher; main folds digits into a
  // canonical digit-run form (any separator between two digits dropped, term and haystack alike),
  // so these flattened texts read as '4250000' and the union HITS. ACCEPTED fail-closed over-match
  // (availability cost: separate figures that concatenate to a roster price block the payload),
  // never a leak. roster-core's own no-moved-break rule is still pinned on matchRosterTerms alone.
  it.each<[string, unknown, Record<string, DealTerms>]>([
    ['cross-record digit groups that MOVE a break', { a: ['42'], b: { c: '50,000' } }, one('$4,250,000')],
    ['nested digit groups that MOVE a break', ['42', ['50', ['000']]], one('$4,250,000')],
  ])('union over-match (accepted, fail closed): %s', (_n, v, t) => {
    expect(matchRosterTerms(v, t)).toBeNull();
    expect(rosterMatchWithTerms(v, t)?.dealLabel).toBe('C');
  });
});
