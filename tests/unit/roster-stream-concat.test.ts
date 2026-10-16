// Refute round 8, J2: the document-order stream check treated every piece boundary as a word
// break, so a term split INSIDE a token across nesting levels missed although the same split
// across direct siblings hit: '$3,875,000' hit "3875000", ['387', '5000'] and {a: '387',
// b: '5000'}, but not ['387', ['5000']]; 'Bay 12' hit 'Bay12' but not ['Bay1', ['2']] or
// ['Ba', ['y12']]. The stream's plain concatenation (no separator added) now also gets the bounded
// normalised test for the term and its separators-deleted form, exactly as a sibling join does.
// Every existing negative stays a miss. Synthetic terms only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  p: { label: 'P', active: true, always: ['$3,875,000'] },
  b: { label: 'B', active: true, always: ['Bay 12'] },
  q: { label: 'Q', active: true, always: ['$4,250,000'] },
  i: { label: 'I', active: true, always: ['K.C.'] },
  g: { label: 'G', active: true, always: ['Bldg #1'] },
};
const scan = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;

describe('J2: a token split across nesting levels is seen whole', () => {
  it.each<[string, unknown, string]>([
    ['digits split across a nesting level', ['387', ['5000']], 'P'],
    ['digits split across records', { a: ['387'], b: { c: '5000' } }, 'P'],
    ['short term split after the digit', ['Bay1', ['2']], 'B'],
    ['short term split inside the word', ['Ba', ['y12']], 'B'],
    ['short term split across a key and its value', { Ba: 'y12' }, 'B'],
    ['short term split across direct siblings', ['Bay1', '2'], 'B'],
    ['short term split across sibling fields', { a: 'Bay1', b: '2' }, 'B'],
    // Unchanged positives (already hit before J2).
    ['plain digits', '3875000', 'P'],
    ['direct siblings', ['387', '5000'], 'P'],
    ['direct sibling record', { a: '387', b: '5000' }, 'P'],
    ['unspaced short term', 'Bay12', 'B'],
  ])('%s', (_n, v, label) => {
    expect(scan(v)).toBe(label);
  });
});

// CHANGED by the merge with origin/main (c04bf53b). These three were in 'negatives stay a miss'
// (`expect(scan(v)).toBeNull()`). rosterMatchWithTerms is now the OR of main's normalised
// scanForConfidential and roster-core's matcher. Main's scanner folds digits into a canonical
// digit-run form (ANY separator between two digits dropped, haystack and term alike), so the
// flattened '42 50,000' / '42 50 000' read as '4250000' and the union HITS. ACCEPTED fail-closed
// over-match (an availability cost: two separate figures that happen to concatenate to a roster
// price block the payload), never a leak. roster-core's own rule (a break may not MOVE) is still
// pinned on matchRosterTerms alone.
describe('J2: moved-break digit groups (union: accepted fail-closed over-match)', () => {
  it.each<[string, unknown]>([
    // The concatenation '4250,000' normalises to '4250 000': neither '4 250 000' nor '4250000'.
    ['cross-record digit groups that move a break', { a: ['42'], b: { c: '50,000' } }],
    ['the same groups across a nesting level', ['42', ['50,000']]],
    // Piece boundaries at 2 and 4, term breaks at 1 and 4: the break at 1 MOVED to 2.
    ['nested digit groups that move a break (H1 negative)', ['42', ['50', ['000']]]],
  ])('%s', (_n, v) => {
    expect(matchRosterTerms(v, terms)).toBeNull();
    expect(scan(v)).toBe('Q');
  });
});

describe('J2: negatives stay a miss', () => {
  it.each<[string, unknown]>([
    ['building number and SF in one leaf', 'Building 42, 50,000 SF'],
    ['building number and SF across a nesting level', ['Building 42,', ['50,000 SF']]],
    ['initials inside a word', 'Back carriage'],
    ['initials inside a word, split across a nesting level', ['Bac', ['k carriage']]],
    ['a longer building number', 'Bldg 10'],
    ['a longer building number, split across a nesting level', ['Bldg', ['10']]],
    ['a longer bay number, split across a nesting level', ['Bay1', ['23']]],
  ])('%s', (_n, v) => {
    expect(scan(v)).toBeNull();
  });
});

// ACCEPTED LIMIT (J2) of roster-core's matcher: an all-digit term split at a NON-break position whose
// pieces also drop one of the term's own separators ('$3,8' + '75000' for '$3,875,000') stays a
// miss there, across direct siblings as across nesting levels. On a concatenation that shape is
// indistinguishable from two separate fields glued together ('42' + '50,000' read as '$4,250,000').
// CLOSED by the merge with origin/main (c04bf53b), was `expect(scan(v)).toBeNull()`: main's
// canonical digit-run form reads the flattened '$3,8 75000' as '$3875000', so the union now HITS
// (and so, consistently, does the moved-break shape above). roster-core alone still misses.
describe('J2: former accepted limit, now closed by the union', () => {
  it.each<[string, unknown]>([
    ['direct siblings', ['$3,8', '75000']],
    ['across a nesting level', ['$3,8', ['75000']]],
  ])('an all-digit split that also drops a separator: %s', (_n, v) => {
    expect(matchRosterTerms(v, terms)).toBeNull();
    expect(scan(v)).toBe('P');
    expect(scan('$3,875000')).toBe('P'); // the same text as one leaf hits
  });
});
