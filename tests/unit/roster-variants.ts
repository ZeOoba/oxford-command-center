// Shared obfuscation-variant table for the publication/egress roster matcher (refute R1, S1, S2).
// SYNTHETIC roster only. Every string is built from code points so no invisible character lives in
// the source.
const cp = (...n: number[]) => String.fromCodePoint(...n);

/** A synthetic roster: write it to a temp file and point CONFIDENTIAL_TERMS_PATH at it. */
export const SYNTHETIC_ROSTER = {
  syn: { label: 'Synthetic', active: true, always: ['9900 quarry', 'heron-ridge'] },
  // Context/anchor deal (refute round 4, W2): matches only when an anchor AND a context term occur.
  synctx: { label: 'Synthetic Ctx', active: true, always: [], context: ['Lot 4'], context_requires_any: ['7700 Kestrel'] },
  // Refute round 5, F5: letters with no decomposition, punctuated short-token terms, line-end forms.
  synfold: {
    label: 'Synthetic Fold', active: true,
    always: ['Lakeview Park', 'Nordvik Lofts', 'Kestrel Ridge', 'Hauptstrasse 12', "O'Brannigan Yard",
      'K.C. Kestrel Lofts', 'D&L Kestrel', '1,250 Kestrel Way', 'Unit 4B Kestrel', 'Bay 12', 'K.C. Yard'],
  },
  synbldg: { label: 'Synthetic Bldg', active: true, always: [], context: ['Bldg 7'], context_requires_any: ['Kestrel Commons'] },
  // Refute round 6, G1: terms carrying a SHORT token (a street suffix, price digit groups).
  synshort: { label: 'Synthetic Short', active: true, always: ['4417 Quarry Rd', '$3,875,000'] },
  // Refute round 6, G2: control / private-use / letter-symbol forms.
  synctl: { label: 'Synthetic Ctl', active: true, always: ['Heronmoor'] },
};

/** [name, text] — every text must be caught as the synthetic roster term. */
export const ROSTER_VARIANTS: Array<[string, string]> = [
  ['NBSP', `9900${cp(0xa0)}Quarry Rd`],
  ['double space', '9900  Quarry Rd'],
  ['tab/newline', '9900\t\nQuarry Rd'],
  ['line-wrapped (PDF text)', '9900\nQuarry'],
  ['hyphen', '9900-Quarry Rd'],
  ['underscore', '9900_quarry'],
  ['dot/comma/slash', '9900.Quarry / 9900,Quarry'],
  ['zero-width space / non-joiner', `99${cp(0x200b)}00 Qua${cp(0x200c)}rry`],
  ['zero-width joiner', `9900 Qu${cp(0x200d)}arry`],
  ['BOM', `9900 Q${cp(0xfeff)}uarry`],
  ['soft hyphen', `99${cp(0xad)}00 Quar${cp(0xad)}ry`],
  ['ideographic space', `9900${cp(0x3000)}Quarry`],
  ['full-width', `${cp(0xff19, 0xff19, 0xff10, 0xff10)} ${cp(0xff31, 0xff55, 0xff41, 0xff52, 0xff52, 0xff59)}`],
  ['bidi embedding/override (U+202A-202E)', `${cp(0x202a)}9900 ${cp(0x202e)}Quarry${cp(0x202c)}`],
  ['bidi isolates (U+2066-2069)', `${cp(0x2066)}9900${cp(0x2069)} Qu${cp(0x2068)}arry`],
  ['Arabic letter mark (U+061C)', `9900 Qua${cp(0x61c)}rry`],
  ['combining grapheme joiner (U+034F)', `99${cp(0x34f)}00 Quarry`],
  ['variation selectors', `9${cp(0xfe0f)}900 Quar${cp(0xfe00)}ry`],
  ['tag characters', `9900 Qu${cp(0xe0041, 0xe007f)}arry`],
  ['Hangul filler (U+3164) as space', `9900${cp(0x3164)}Quarry`],
  ['Hangul choseong/jungseong fillers (U+115F/U+1160) as space', `9900${cp(0x115f)}Quarry 9900${cp(0x1160)}Quarry`],
  ['braille blank (U+2800) as space', `9900${cp(0x2800)}Quarry`],
  ['other punctuation/symbols as separators', '9900*Quarry 9900~Quarry 9900|Quarry 9900+Quarry'],
  // Refute round 3, U1: separators INSIDE a word.
  ['PDF line-end hyphenation', '9900 Quar-\nry Road'],
  ['letter-spaced', '9 9 0 0  Q U A R R Y'],
  ['thousands separator', '9,900 Quarry Road'],
  ['term punctuation vs run-together haystack', 'HeronRidge Flex'],
  ['term punctuation vs plain haystack', 'Heron Ridge Flex'],
  // Refute round 4, W2: context/anchor deal. The anchor is caught only by the compact pass (or
  // the normalised pass) while the short context term is caught cleanly; the deal must still hit.
  ['ctx: thousands separator', '7,700 Kestrel Rd, Lot 4'],
  ['ctx: letter-spaced anchor', '7 7 0 0  K E S T R E L, Lot 4'],
  ['ctx: run-together anchor', '7700Kestrel yard, Lot 4'],
  ['ctx: PDF hyphenation in anchor', `7700 Kes-${cp(10)}trel Rd, Lot 4`],
  ['term punctuation vs other punctuation', 'heron_ridge'],
  // Refute round 4, W3: accents / combining marks are folded away (NFD, strip Mn marks, NFC).
  ['precomposed accent', `H${cp(0xe9)}ron Ridge Flex`],
  ['combining acute mark', `9900 Q${cp(0x301)}uarry Rd`],
  // Refute round 5, F5(a): letters with no Unicode decomposition, enclosing / spacing marks.
  ['l with stroke', `${cp(0x141)}akeview Park`],
  ['o with stroke', `N${cp(0xf8)}rdvik Lofts`],
  ['dotless i', `Kestrel R${cp(0x131)}dge`],
  ['sharp s', `Hauptstra${cp(0xdf)}e 12`],
  ['enclosing mark (Me)', `K${cp(0x20dd)}estrel Ridge`],
  ['spacing combining mark (Mc)', `Kes${cp(0x903)}trel Ridge`],
  // F5(b): decimal digits of any script.
  ['Arabic-Indic digits', `${cp(0x669, 0x669, 0x660, 0x660)} Quarry Rd`],
  ['Devanagari digits', `${cp(0x96f, 0x96f, 0x966, 0x966)} Quarry`],
  ['Thai digits', `${cp(0xe59, 0xe59, 0xe50, 0xe50)} Quarry`],
  // F5(c): punctuated short-token roster terms vs the bare text.
  ['apostrophe dropped', 'OBrannigan Yard'],
  ['initials undotted', 'KC Kestrel Lofts'],
  ['ampersand dropped', 'DL Kestrel'],
  ['thousands separator dropped', '1250 Kestrel Way'],
  ['short token run together', 'Unit4B Kestrel'],
  ['ctx: short context term run together', 'Kestrel Commons, Bldg7'],
  // F5(f): line-end hyphen forms (NFKC before the rejoin; the non-rejoined form is also scanned).
  ['full-width hyphen at a line end', `Ba${cp(0xff0d)}${cp(10)}y 12`],
  ['soft hyphen at a line end', `Ba${cp(0xad)}${cp(10)}y 12`],
  ['compound hyphen at a line end (non-rejoined form)', `Ex-${cp(10)}K. C. Yard`],
  // Refute round 6, G1: a term with a short token ('Rd', price digit groups) vs text that adds a
  // break the term does not have.
  ['short-token term letter-spaced', '4 4 1 7 Q u a r r y R d'],
  ['short-token term, one stray space (PDF extraction)', '4417 Qu arry Rd.'],
  ['short-token term, thousands separator in the number', '4,417 Quarry Rd'],
  ['short-token term, hyphen and stray space in the suffix', '4417 Quarry-R d'],
  ['price term letter-spaced', '$ 3 , 8 7 5 , 0 0 0'],
  ['price term, one stray space', '$3,87 5,000'],
  // Refute round 6, G2: control characters are stripped (NEL is a line break, so a space), private
  // use characters are stripped, and letter-like symbols with no decomposition fold to ASCII.
  ['DEL (U+007F) inside a word', `Heron${cp(0x7f)}moor`],
  ['NUL inside a word', `Heron${cp(0)}moor`],
  ['C1 control CSI (U+009B) inside a word', `Heron${cp(0x9b)}moor`],
  ['NEL (U+0085) as a word break', `Kestrel${cp(0x85)}Ridge`],
  ['C0 control (U+0001) inside a word', `Kes${cp(1)}trel Ridge`],
  ['private-use character inside a word', `Heron${cp(0xe000)}moor`],
  ['supplementary private-use character inside a word', `Heron${cp(0xf0000)}moor`],
  ['Latin small capitals', `Heron${cp(0x1d0d, 0x1d0f, 0x1d0f, 0x280)}`],
  ['small capitals, whole word', cp(0x29c, 0x1d07, 0x280, 0x1d0f, 0x274, 0x1d0d, 0x1d0f, 0x1d0f, 0x280)],
  ['regional indicator letters', `${cp(0x1f1ed, 0x1f1ea, 0x1f1f7, 0x1f1f4, 0x1f1f3)}moor`],
  ['negative squared letters', `${cp(0x1f177)}eron${cp(0x1f17c, 0x1f17e, 0x1f17e, 0x1f181)}`],
  ['negative circled letters', `${cp(0x1f157)}eronmoor`],
];

/** [name, value]: structured (non-string) variants, run by every consumer that scans a VALUE
 *  rather than one text field. Each must be caught as a synthetic roster term. */
export const ROSTER_VALUE_VARIANTS: Array<[string, unknown]> = [
  // Refute round 6, G1: a short-token term split across sibling leaves.
  ['short-token term split across sibling leaves', ['4417Qua', 'rryRd']],
  // Refute round 6, G3: splits across nesting levels / key and value, and values JSON.stringify
  // emits (toJSON) or that hold strings JSON.stringify would drop (Map, Set).
  ['word split across a parent and a child array', ['Kest', ['rel Ridge']]],
  ['word split across a key and its value', { Kest: 'rel Ridge' }],
  ['word split across a value and a nested value', { a: 'Kest', b: { c: 'rel Ridge' } }],
  ['word split across sibling keys', { Kest: 1, 'rel Ridge': 2 }],
  ['object with toJSON', { toJSON: () => 'Heronmoor' }],
  ['nested toJSON', { row: { toJSON: () => ({ note: 'Heronmoor' }) } }],
  ['Map value', new Map([['note', 'Heronmoor']])],
  ['Map key', new Map([['Heronmoor', 1]])],
  ['Set value', new Set(['Heronmoor'])],
];
