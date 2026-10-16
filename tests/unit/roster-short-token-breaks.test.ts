// Refute round 6, G1: a roster term carrying a SHORT token (a street suffix 'Rd', a unit letter, the
// digit groups of a price) missed every time the text added a break the term does not have:
// letter-spacing, one stray space from PDF text extraction, a thousands separator inside a number,
// or a split across sibling leaves. compactSubtokenHit only accepted text breaks that were also term
// breaks, and the sibling-join pass skipped short-token terms entirely. Synthetic terms only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  addr: { label: 'Addr', active: true, always: ['4417 Quarry Rd'] },
  price: { label: 'Price', active: true, always: ['$3,875,000'] },
  unit: { label: 'Unit', active: true, always: ['Unit 4B Kestrel'] },
  bay: { label: 'Bay', active: true, always: ['Bay 12'] },
};
const scan = (v: unknown) => rosterMatchWithTerms(v, terms)?.dealLabel ?? null;

describe('G1: short-token terms vs text that adds breaks', () => {
  it.each<[string, unknown, string]>([
    ['letter-spaced address', '4 4 1 7 Q u a r r y R d', 'Addr'],
    ['one stray space (PDF extraction)', '4417 Qu arry Rd.', 'Addr'],
    ['thousands separator in the street number', '4,417 Quarry Rd', 'Addr'],
    ['hyphen and stray space in the suffix', '4417 Quarry-R d', 'Addr'],
    ['dropped AND added break (letter term, compact >= 6)', '4417Qu arry Rd', 'Addr'],
    ['sibling leaves', ['4417Qua', 'rryRd'], 'Addr'],
    ['sibling object values', { a: '4417 Quar', b: 'ry Rd' }, 'Addr'],
    ['letter-spaced price', '$ 3 , 8 7 5 , 0 0 0', 'Price'],
    ['price with one stray space', '$3,87 5,000', 'Price'],
    ['letter-spaced short term (compact < 6)', 'B a y 1 2', 'Bay'],
    // Moved from the negatives in roster-matcher-gaps (round 5): with a 13-character compact form
    // carrying letters, "Unit 4 BKestrel" is the term with one space moved, an obfuscation to catch.
    ['unit term with one space moved', 'Unit 4 BKestrel', 'Unit'],
  ])('%s', (_n, v, label) => {
    expect(scan(v)).toBe(label);
  });

  // The raw pass is plain substring and only over-matches, so each negative is punctuated where
  // needed for the raw pass not to decide it.
  // The strict rules stay for all-digit terms and for short (compact < 6) terms: the text may DROP
  // the term's breaks, or ADD breaks while keeping every one of the term's, never move one.
  it.each<[string, unknown, Record<string, DealTerms>]>([
    ['Building 42, 50,000 SF vs $4,250,000', 'Building 42, 50,000 SF', { c: { label: 'C', active: true, always: ['$4,250,000'] } }],
    ['K.C. vs Back carriage', 'Back carriage house', { c: { label: 'C', active: true, always: ['K.C.'] } }],
    ['Bldg #1 vs Bldg 10', 'Bldg 10 roof', { c: { label: 'C', active: true, always: ['Bldg #1'] } }],
    ['Bldg #1 vs BLDG10', 'BLDG10', { c: { label: 'C', active: true, always: ['Bldg #1'] } }],
    ['Suite #10 vs Suite 100', 'Suite 100', { c: { label: 'C', active: true, always: ['Suite #10'] } }],
    ['Main St vs "Vacancy remains tight"', 'Vacancy remains tight', { c: { label: 'C', active: true, always: ['Main St'] } }],
    ['Main St vs "Germain-Street"', 'Germain-Street', { c: { label: 'C', active: true, always: ['Main St'] } }],
    ['Main St vs "Main-Station"', 'Main-Station', { c: { label: 'C', active: true, always: ['Main St'] } }],
    ['address vs a longer street number', '14417-Quarry Rd', { c: { label: 'C', active: true, always: ['4417 Quarry Rd'] } }],
    ['address vs a different suffix', '4417 Quarry-Rdg', { c: { label: 'C', active: true, always: ['4417 Quarry Rd'] } }],
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
    ['42 50 000 vs $4,250,000', 'priced 42 50 000', { c: { label: 'C', active: true, always: ['$4,250,000'] } }],
    ['cross-field strings vs a price term', { sf: '42', price: '50,000' }, { c: { label: 'C', active: true, always: ['$4,250,000'] } }],
  ])('union over-match (accepted, fail closed): %s', (_n, v, t) => {
    expect(matchRosterTerms(v, t)).toBeNull();
    expect(rosterMatchWithTerms(v, t)?.dealLabel).toBe('C');
  });
});
