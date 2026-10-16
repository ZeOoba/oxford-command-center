// Refute round 7, H5: unassigned code points and noncharacters (\p{Cn}) were not stripped, so
// 'Heron<U+FDD0>moor' and 'Heron<U+0378>moor' missed 'Heronmoor'; and the circled / dingbat digits
// with NO compatibility decomposition (negative circled 11-20 and 0, double circled 1-10, the
// U+2776-U+2793 dingbat circled digits, U+1F10B/U+1F10C) stayed symbols, so 'Bay ❶❷' missed
// 'Bay 12'. The decomposable circled / parenthesised / full-stop digits (U+2460-U+249B, U+24EA)
// already fold under NFKC; the rest now map to the same ASCII digits, with no spaces, exactly as
// NFKC folds ① to '1'. Regional-indicator pairs (flag emoji) keep folding to their two letters: see
// the comment on LETTER_SYMBOLS. Synthetic strings only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { normalizeRosterText, rosterMatchWithTerms } from '../../server/briefing/roster-match';

const cp = (...n: number[]) => String.fromCodePoint(...n);

describe('H5: normalizeRosterText', () => {
  it.each<[string, string, string]>([
    ['noncharacter U+FDD0 stripped', `Heron${cp(0xfdd0)}moor`, 'heronmoor'],
    ['noncharacter U+FFFE stripped', `Heron${cp(0xfffe)}moor`, 'heronmoor'],
    ['supplementary noncharacter stripped', `Heron${cp(0x1fffe)}moor`, 'heronmoor'],
    ['unassigned U+0378 stripped', `Heron${cp(0x378)}moor`, 'heronmoor'],
    ['circled digits (NFKC, control)', `Bay ${cp(0x2460, 0x2461)}`, 'bay 12'],
    ['circled zero (NFKC, control)', `Bay ${cp(0x24ea)}`, 'bay 0'],
    ['dingbat negative circled 1, 2', `Bay ${cp(0x2776, 0x2777)}`, 'bay 12'],
    ['dingbat circled sans-serif 1, 2', `Bay ${cp(0x2780, 0x2781)}`, 'bay 12'],
    ['dingbat negative circled sans-serif 1, 2', `Bay ${cp(0x278a, 0x278b)}`, 'bay 12'],
    ['dingbat 10s', cp(0x277f, 0x2789, 0x2793), '101010'],
    ['negative circled 11..20', cp(0x24eb, 0x24f4), '1120'],
    ['double circled 1..10', cp(0x24f5, 0x24fe), '110'],
    ['negative circled zero', cp(0x24ff), '0'],
    ['dingbat circled sans-serif zero / negative zero', cp(0x1f10b, 0x1f10c), '00'],
    // Pinned (not a defect): a flag folds to its two letters, exactly like typing them.
    ['flag emoji folds to its two letters', `Bay ${cp(0x1f1fa, 0x1f1f8)}`, 'bay us'],
  ])('%s', (_n, input, out) => {
    expect(normalizeRosterText(input)).toBe(out);
  });
});

describe('H5: roster hits', () => {
  const terms: Record<string, DealTerms> = {
    h: { label: 'H', active: true, always: ['Heronmoor'] },
    b: { label: 'B', active: true, always: ['Bay 12'] },
  };
  it.each<[string, string, string]>([
    ['noncharacter inside a word', `Heron${cp(0xfdd0)}moor`, 'H'],
    ['unassigned inside a word', `Heron${cp(0x378)}moor`, 'H'],
    ['dingbat negative circled digits', `Bay ${cp(0x2776, 0x2777)}`, 'B'],
    ['dingbat circled sans-serif digits', `Bay ${cp(0x2780, 0x2781)}`, 'B'],
  ])('%s', (_n, text, label) => {
    expect(rosterMatchWithTerms(text, terms)?.dealLabel).toBe(label);
  });
  it('negative: a different dingbat number does not hit', () => {
    expect(rosterMatchWithTerms(`Bay ${cp(0x2776, 0x2778)}`, terms)).toBeNull();
  });
});
