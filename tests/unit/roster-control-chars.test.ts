// Refute round 6, G2: control and private-use characters were neither stripped nor treated as
// separators by the roster normaliser, and letter-like forms with no decomposition (Latin small
// capitals, regional indicator / negative squared / negative circled letters) normalised to
// separators or stayed unfolded. The obfuscation variants themselves live in the shared
// roster-variants table; this pins the normaliser's output. Synthetic strings only.
import { describe, it, expect } from 'vitest';
import { normalizeRosterText } from '../../server/briefing/roster-match';

const cp = (...n: number[]) => String.fromCodePoint(...n);

describe('G2: normalizeRosterText', () => {
  it.each<[string, string, string]>([
    ['DEL stripped', `Heron${cp(0x7f)}moor`, 'heronmoor'],
    ['NUL stripped', `Heron${cp(0)}moor`, 'heronmoor'],
    ['C0 controls stripped', `a${cp(1, 2, 0x1b, 0x1f)}b`, 'ab'],
    ['C1 controls stripped', `a${cp(0x80, 0x9b, 0x9f)}b`, 'ab'],
    ['NEL is a line break (space)', `a${cp(0x85)}b`, 'a b'],
    ['tab / LF / CR / VT / FF stay whitespace', `a\tb\nc\rd${cp(0xb)}e${cp(0xc)}f`, 'a b c d e f'],
    ['BMP private use stripped', `a${cp(0xe000, 0xf8ff)}b`, 'ab'],
    ['supplementary private use stripped', `a${cp(0xf0000, 0x10fffd)}b`, 'ab'],
    ['lone surrogate stripped', `a${String.fromCharCode(0xd800)}b`, 'ab'],
    ['small capitals fold', cp(0x1d00, 0x299, 0x1d04, 0x1d05, 0x1d07, 0xa730, 0x262, 0x29c, 0x26a, 0x1d0a, 0x1d0b, 0x29f, 0x1d0d), 'abcdefghijklm'],
    ['small capitals fold (n..z)', cp(0x274, 0x1d0f, 0x1d18, 0xa7af, 0x280, 0xa731, 0x1d1b, 0x1d1c, 0x1d20, 0x1d21, 0x28f, 0x1d22), 'nopqrstuvwyz'],
    ['regional indicators fold', cp(0x1f1e6, 0x1f1ff), 'az'],
    ['negative squared letters fold', cp(0x1f170, 0x1f189), 'az'],
    ['negative circled letters fold', cp(0x1f150, 0x1f169), 'az'],
    ['other symbols are still separators', `a${cp(0x1f600)}b`, 'a b'],
  ])('%s', (_n, input, out) => {
    expect(normalizeRosterText(input)).toBe(out);
  });
});
