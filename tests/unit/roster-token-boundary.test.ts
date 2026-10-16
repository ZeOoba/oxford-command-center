// Refute round 3, U2: mapping punctuation to a space lost word boundaries, so a short or
// punctuated term ("K.C." -> "k c", "Bldg #1" -> "bldg 1") matched inside unrelated words in the
// normalised pass ("Back carriage", "Bldg 10"). The normalised pass now matches on token
// boundaries for anchors, context terms and any term with a token shorter than 3 chars; the raw
// pass stays plain substring and the compact pass only applies to compact length >= 6.
// SCOPE (refute round 5, F6): the token-boundary rule is a property of the NORMALISED pass (and the
// compact alignment rules) only, NOT of the matcher as a whole. The raw pass is still a plain
// substring test, so an unpunctuated term over-matches a longer token ("Bay 12" in "Bay 120"): a
// fail-closed over-match, never a leak (pinned in roster-log-hygiene.test.ts). The two negatives
// below hold because the raw pass cannot see them (their terms carry punctuation the text lacks).
// Since round 5 (F5(c)) short-token terms use a stricter sub-token compact pass, not none.
// Synthetic terms only, injected directly (no roster file).
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { matchRosterTerms, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const terms: Record<string, DealTerms> = {
  short: { label: 'Short', active: true, always: ['K.C.', 'Bldg #1'] },
  ctx: { label: 'Ctx', active: true, always: [], context: ['park'], context_requires_any: ['oxbow'] },
};
const scan = (t: string) => rosterMatchWithTerms(t, terms);

describe('token-boundary matching in the normalised pass', () => {
  it('"K.C." no longer matches "Back carriage"', () => {
    expect(scan('Back carriage house, rear lot')).toBeNull();
  });
  it('"Bldg #1" no longer matches "Bldg 10"', () => {
    expect(scan('Bldg 10 roof replacement')).toBeNull();
  });
  it('the compact pass does not reintroduce either false positive', () => {
    expect(scan('backcarriage')).toBeNull();
    expect(scan('BLDG10')).toBeNull();
  });
  it('true positives still match (punctuation and spacing variants)', () => {
    expect(scan('Meeting in K.C. next week')?.dealLabel).toBe('Short');
    expect(scan('meeting in k c next week')?.dealLabel).toBe('Short');
    expect(scan('Bldg #1, roof')?.dealLabel).toBe('Short');
    expect(scan('bldg-1 roof')?.dealLabel).toBe('Short');
  });
  it('context terms and anchors match on token boundaries', () => {
    // A zero-width split defeats the raw pass, so only the normalised pass decides this one: the
    // anchor and context term occur only INSIDE longer words. The roster-core matcher still keeps
    // its token-boundary rule for them (null below).
    const inWord = `Parkway frontage near Ox${String.fromCodePoint(0x200b)}bowville`;
    expect(matchRosterTerms(inWord, terms)).toBeNull();
    // CHANGED by the merge with origin/main (c04bf53b), was `expect(scan(inWord)).toBeNull()`:
    // rosterMatchWithTerms is now the OR of main's normalised scanForConfidential and the matcher
    // above. Main's scanner (like the hook's find_hit) is a plain normalised SUBSTRING test for
    // context terms and anchors, with the zero-width char deleted ('parkway ... oxbowville' carries
    // 'park' and 'oxbow'), so the union HITS. ACCEPTED fail-closed over-match: an availability
    // cost (a block), never a leak.
    expect(scan(inWord)?.dealLabel).toBe('Ctx');
    expect(scan('the park near the oxbow')?.dealLabel).toBe('Ctx');
    expect(scan('the park, near the Oxbow.')?.dealLabel).toBe('Ctx');
  });
  it('the raw pass is still plain substring (unchanged scanForConfidential semantics)', () => {
    expect(scan('xxK.C.yy')?.dealLabel).toBe('Short');
  });
});
