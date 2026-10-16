// Differential regression for the matcher reconciliation (merge of origin/main c04bf53b into the
// audit-W1 branch; Hard Invariant 3). The corpus below is a copy of the read-only differential
// analysis (recon diff.ts, 204 in-memory cases), run then against main's scanForConfidential (M) and
// the branch's rosterMatchWithTerms (W) separately. REPORT records what each side returned in that
// analysis. The merged gate (rosterMatchWithTerms = main's normalised scanForConfidential OR
// roster-core's matchRosterTerms) must:
//  - HIT every case EITHER side hit (the union loses nothing either matcher caught);
//  - THROW (fail closed, scan budget) on the exponentially unfolding DAG, where W threw;
//  - and, for the cases NEITHER side hit, still miss (the union adds no over-match beyond the two
//    matchers' own; the accepted over-matches each side already had are pinned in ACCEPTED_OVERMATCH).
// SYNTHETIC terms and text only.
import { describe, it, expect } from 'vitest';
import type { DealTerms } from '../../server/briefing/confidential';
import { rosterMatchWithTerms } from '../../server/briefing/roster-match';

const cp = (...n: number[]) => String.fromCodePoint(...n);
type Terms = Record<string, DealTerms>;
const R = (always: string[], context: string[] = [], anchors: string[] = []): Terms => ({
  syn: { label: 'SYN', active: true, always, context, context_requires_any: anchors },
});
interface Case { cls: string; name: string; terms: Terms; value: () => unknown; expect: 'HIT' | 'miss' | '?' }
const cases: Case[] = [];
const add = (cls: string, name: string, terms: Terms, value: unknown | (() => unknown), expect: 'HIT' | 'miss' | '?' = 'HIT') =>
  cases.push({ cls, name, terms, value: typeof value === 'function' ? (value as () => unknown) : () => value, expect });

// ---- corpus (verbatim from the differential analysis) ----
const ONE = R(['Heronmoor']); // single-token 9-char term
const TWO = R(['Zephyrine Holdings']); // two-word term
const ADDR = R(['4417 Quarry Rd']);
const PRICE = R(['$3,875,000']);
const BAY = R(['Bay 12']);
const KC = R(['K.C.']);
const BLDG = R(['Bldg #1']);
const OBR = R(["O'Brannigan Yard"]);
const NUM = R(['4250000']);
const PRICE2 = R(['$4,250,000']);
const P250 = R(['$250,000']);

// ---- baseline
add('baseline', 'plain single word', ONE, 'Bid from Heronmoor accepted');
add('baseline', 'plain two words', TWO, 'Bid from Zephyrine Holdings accepted');
add('baseline', 'unrelated text', TWO, 'quarterly update on flex leasing', 'miss');

// ---- whitespace / invisible
add('NBSP', 'NBSP as separator', TWO, `Zephyrine${cp(0xa0)}Holdings`);
add('NBSP', 'ideographic space', TWO, `Zephyrine${cp(0x3000)}Holdings`);
add('NBSP', 'narrow NBSP', TWO, `Zephyrine${cp(0x202f)}Holdings`);
add('zero-width', 'ZWSP mid-word (1 token)', ONE, `Heron${cp(0x200b)}moor`);
add('zero-width', 'ZWSP as separator', TWO, `Zephyrine${cp(0x200b)}Holdings`);
add('zero-width', 'ZWJ / WJ / BOM mid-word', ONE, `He${cp(0x200d)}ron${cp(0x2060)}mo${cp(0xfeff)}or`);
add('zero-width', 'soft hyphen mid-word', ONE, `Heron${cp(0xad)}moor`);
add('zero-width', 'variation selector mid-word', ONE, `Heron${cp(0xfe0f)}moor`);
add('zero-width', 'CGJ mid-word', ONE, `Heron${cp(0x34f)}moor`);
add('zero-width', 'Hangul filler as separator', TWO, `Zephyrine${cp(0x3164)}Holdings`);
add('bidi', 'RLO inside word', ONE, `Heron${cp(0x202e)}moor`);
add('bidi', 'LRI/PDI inside word', ONE, `Her${cp(0x2066)}on${cp(0x2069)}moor`);
add('bidi', 'RLO run rendering reversed text', ONE, `${cp(0x202e)}roomnoreH${cp(0x202c)}`);
add('bidi', 'RLO reversed two-word', TWO, `${cp(0x202e)}sgnidloH enirypheZ${cp(0x202c)}`);
add('tag chars', 'tag A inside word', ONE, `Heron${cp(0xe0041)}moor`);
add('tag chars', 'tag run inside word', ONE, `Heron${cp(0xe0020, 0xe0061, 0xe007f)}moor`);
add('control', 'NUL inside word', ONE, `Heron${cp(0)}moor`);
add('control', 'DEL inside word', ONE, `Heron${cp(0x7f)}moor`);
add('control', 'SOH inside word', ONE, `Heron${cp(1)}moor`);
add('control', 'C1 0x90 inside word', ONE, `Heron${cp(0x90)}moor`);
add('control', 'NEL inside word', ONE, `Heron${cp(0x85)}moor`);
add('control', 'ESC inside word', ONE, `Heron${cp(0x1b)}moor`);
add('private-use', 'U+E000 inside word', ONE, `Heron${cp(0xe000)}moor`);
add('private-use', 'plane-15 PUA inside word', ONE, `Heron${cp(0xf0000)}moor`);
add('noncharacter', 'U+FDD0 inside word', ONE, `Heron${cp(0xfdd0)}moor`);
add('noncharacter', 'U+FFFF inside word', ONE, `Heron${cp(0xffff)}moor`);
add('unassigned', 'U+0378 inside word', ONE, `Heron${cp(0x378)}moor`);
add('unassigned', 'lone surrogate inside word', ONE, `Heron\ud800moor`);

// ---- letter forms
add('full-width', 'full-width word', ONE, 'Ｈｅｒｏｎｍｏｏｒ');
add('full-width', 'full-width two words', TWO, 'Ｚｅｐｈｙｒｉｎｅ Ｈｏｌｄｉｎｇｓ');
add('math-styled', 'math bold', ONE, [...'Heronmoor'].map((c) => cp((c === 'H' ? 0x1d400 + 7 : 0x1d41a + c.charCodeAt(0) - 97))).join(''));
add('math-styled', 'math double-struck H + plain', ONE, `${cp(0x210d)}eronmoor`);
add('math-styled', 'math sans-serif italic', ONE, [...'heronmoor'].map((c) => cp(0x1d622 + c.charCodeAt(0) - 97)).join(''));
add('small caps', 'Latin small capitals', ONE, `${cp(0x29c, 0x1d07, 0x280, 0x1d0f, 0x274, 0x1d0d, 0x1d0f, 0x1d0f, 0x280)}`);
add('letter symbols', 'regional indicator letters', ONE, [...'heronmoor'].map((c) => cp(0x1f1e6 + c.charCodeAt(0) - 97)).join(''));
add('letter symbols', 'negative squared letters', ONE, [...'heronmoor'].map((c) => cp(0x1f170 + c.charCodeAt(0) - 97)).join(''));
add('letter symbols', 'circled letters (decomposable)', ONE, [...'heronmoor'].map((c) => cp(0x24d0 + c.charCodeAt(0) - 97)).join(''));
add('ligatures', 'fi ligature', R(['Fieldcrest']), `${cp(0xfb01)}eldcrest`);
add('ligatures', 'ff ligature', R(['Cliffside']), `Cli${cp(0xfb00)}side`);
add('ligatures', 'term written with ligature', R([`${cp(0xfb01)}eldcrest`]), 'Fieldcrest');
add('accents', 'precomposed accents', ONE, 'Hérònmöör');
add('accents', 'roster term accented, text plain', R(['Hérònmöör']), 'Heronmoor');
add('combining', 'combining acute (Mn)', ONE, `He${cp(0x301)}ronmoor`);
add('combining', 'combining low line run', ONE, `H${cp(0x332)}e${cp(0x332)}ronmoor`);
add('combining', 'enclosing circle (Me)', ONE, `H${cp(0x20dd)}eronmoor`);
add('combining', 'enclosing keycap (Me)', ONE, `Heron${cp(0x20e3)}moor`);
add('combining', 'spacing mark Devanagari visarga (Mc)', ONE, `Heron${cp(0x903)}moor`);
add('combining', '5000 combining marks inside word', ONE, () => `Heron${cp(0x301).repeat(5000)}moor`);
add('undecomposable', 'o-slash', ONE, 'Heronmøør');
add('undecomposable', 'l-stroke', R(['Lodz Partners']), 'Łódź Partners');
add('undecomposable', 'sharp s', R(['Strasse Logistics']), 'Straße Logistics');
add('undecomposable', 'dotless i', R(['Kirkwood Yard']), `K${cp(0x131)}rkwood Yard`);
add('undecomposable', 'ae ligature', R(['Aegis Park']), `${cp(0xe6)}gis Park`);
add('undecomposable', 'thorn', R(['Thornfield']), `${cp(0xfe)}ornfield`);
add('superscripts', 'superscript two inside word', ONE, `Heron${cp(0xb2)}moor`);
add('superscripts', 'superscript digits for a number', R(['4417 Quarry Rd']), `${cp(0x2074, 0x2074, 0xb9, 0x2077)} Quarry Rd`);
add('homoglyph', 'Cyrillic e (accepted limit both)', ONE, `H${cp(0x435)}ronmoor`, '?');

// ---- digits
add('digits', 'Arabic-Indic digits', ADDR, `${cp(0x664, 0x664, 0x661, 0x667)} Quarry Rd`);
add('digits', 'Devanagari digits', ADDR, `${cp(0x96a, 0x96a, 0x967, 0x96d)} Quarry Rd`);
add('digits', 'full-width digits', ADDR, '４４１７ Quarry Rd');
add('digits', 'math bold digits', ADDR, `${cp(0x1d7d2, 0x1d7d2, 0x1d7cf, 0x1d7d5)} Quarry Rd`);
add('digits', 'circled digits (decomposable)', ADDR, `${cp(0x2463, 0x2463, 0x2460, 0x2466)} Quarry Rd`);
add('digits', 'dingbat negative circled digits', ADDR, `${cp(0x2779, 0x2779, 0x2776, 0x277c)} Quarry Rd`);
add('digits', 'double circled digits', ADDR, `${cp(0x24f8, 0x24f8, 0x24f5, 0x24fb)} Quarry Rd`);
add('digits', 'Adlam digits (supplementary)', ADDR, `${cp(0x1e954, 0x1e954, 0x1e951, 0x1e957)} Quarry Rd`);

// ---- PDF hyphenation
add('hyphenation', 'line-end hyphen single word', ONE, 'Heron-\nmoor');
add('hyphenation', 'line-end hyphen two words', TWO, 'Zephy-\nrine Holdings');
add('hyphenation', 'line-end hyphen + CR + indent', ONE, 'Heron-  \r\n   moor');
add('hyphenation', 'full-width hyphen line end', ONE, `Heron${cp(0xff0d)}\nmoor`);
add('hyphenation', 'U+2010 hyphen line end', ONE, `Heron${cp(0x2010)}\nmoor`);
add('hyphenation', 'soft hyphen line end', ONE, `Heron${cp(0xad)}\nmoor`);
add('hyphenation', 'real compound at line end (term has hyphen)', R(['Heron-Ridge']), 'Heron-\nRidge');

// ---- spacing
add('letter-spaced', 'single word letter-spaced', ONE, 'H e r o n m o o r');
add('letter-spaced', 'two words letter-spaced', TWO, 'Z e p h y r i n e  H o l d i n g s');
add('letter-spaced', 'address letter-spaced', ADDR, '4 4 1 7 Q u a r r y R d');
add('letter-spaced', 'short term letter-spaced', BAY, 'B a y 1 2');
add('letter-spaced', 'dotted letters', ONE, 'H.e.r.o.n.m.o.o.r');
add('run-together', 'two words run together', TWO, 'ZephyrineHoldings');
add('run-together', 'address run together', ADDR, '4417QuarryRd');
add('run-together', 'short term run together', BAY, 'Bay12');
add('run-together', 'term single word, text split by space', ONE, 'Heron moor');
add('run-together', 'term single word, text split by hyphen', ONE, 'Heron-moor');

// ---- numbers
for (const [n, t] of [
  ['plain', '3875000'], ['commas', '3,875,000'], ['dots', '3.875.000'], ['spaces', '3 875 000'], ['apostrophes', "3'875'000"],
  ['NBSP groups', `3${cp(0xa0)}875${cp(0xa0)}000`], ['thin-space groups', `3${cp(0x2009)}875${cp(0x2009)}000`], ['underscores', '3_875_000'],
  ['with cents', '$3,875,000.00'], ['currency space', '$ 3,875,000'], ['letter-spaced digits', '3 8 7 5 0 0 0'], ['stray space', '3 87 5 000'],
  ['moved break 38 75 000', '38 75 000'], ['$3.875M', '$3.875M'], ['Arabic thousands sep', `3${cp(0x66c)}875${cp(0x66c)}000`],
] as Array<[string, string]>) add('thousands', `$3,875,000 vs ${n}`, PRICE, `Price ${t} firm`, n === '$3.875M' ? 'miss' : n.startsWith('moved') ? '?' : 'HIT');
add('thousands', 'bare 4250000 vs lakh 42,50,000', NUM, 'Rs 42,50,000', '?');
add('thousands', 'bare 4250000 vs $4,250,000', NUM, 'Ask $4,250,000');
add('numeric-neg', '$4,250,000 vs 14,250,000', PRICE2, 'Total 14,250,000', 'miss');
add('numeric-neg', '$4,250,000 vs 4,250,000,000', PRICE2, 'Cap 4,250,000,000', 'miss');
add('numeric-neg', '$250,000 vs $1,250,000', P250, 'Loan $1,250,000', 'miss');
add('numeric-neg', '$250,000 vs 250,000,000', P250, 'Fund 250,000,000', 'miss');
add('numeric-neg', '$3,875,000 vs 13875000', PRICE, 'id 13875000', 'miss');
add('numeric-neg', 'Building 42, 50,000 SF vs $4,250,000', PRICE2, 'Building 42, 50,000 SF', 'miss');
add('numeric-neg', 'Building 42 50,000 SF vs $4,250,000', PRICE2, 'Building 42 50,000 SF', 'miss');
add('numeric-neg', "{a:['42'],b:{c:'50,000'}} vs $4,250,000", PRICE2, { a: ['42'], b: { c: '50,000' } }, 'miss');
add('numeric-neg', "['42', ['50', ['000']]] vs $4,250,000", PRICE2, ['42', ['50', ['000']]], 'miss');
add('numeric-neg', 'two fields 42 / 50000 (numbers)', PRICE2, { a: 42, b: 50000 }, 'miss');
add('numeric-neg', 'Suite 7 250,000 vs $250,000 (ambiguous)', P250, 'Suite 7 250,000', '?');

// ---- short / punctuated
add('short', 'K.C. vs K.C.', KC, 'the K.C. yard');
add('short', 'K.C. vs KC', KC, 'the KC yard');
add('short', 'K.C. vs K C', KC, 'the K C yard');
add('short', 'K.C. vs Back carriage (NEG)', KC, 'Back carriage', 'miss');
add('short', 'K.C. vs kc inside word (NEG)', KC, 'backcountry', 'miss');
add('short', 'Bldg #1 vs Bldg #1', BLDG, 'Bldg #1 roof');
add('short', 'Bldg #1 vs Bldg 1', BLDG, 'Bldg 1 roof');
add('short', 'Bldg #1 vs Bldg1', BLDG, 'Bldg1 roof');
add('short', 'Bldg #1 vs Bldg 10 (NEG)', BLDG, 'Bldg 10 roof', 'miss');
add('short', 'Bldg #1 vs Bldg #10 (NEG)', BLDG, 'Bldg #10 roof', 'miss');
add('short', 'Bay 12 vs Bay 120 (NEG)', BAY, 'Bay 120', 'miss');
add('short', 'Bay 12 vs Bay-12', BAY, 'Bay-12');
add('short', 'Bay 12 vs Bay #12', BAY, 'Bay #12');
add('short', 'Bay 12 vs Bay  12 (2 spaces)', BAY, 'Bay  12');
add('short', 'Bay 12 vs Bay\\n12', BAY, 'Bay\n12');
add('short', 'Bay 12 vs Ebay 12 (NEG)', BAY, 'Ebay 12', 'miss');
add('short', 'Bay 12 vs B ay12', BAY, 'B ay12', '?');
add('short', "O'Brannigan Yard vs OBrannigan Yard", OBR, 'OBrannigan Yard');
add('short', "O'Brannigan Yard vs O Brannigan Yard", OBR, 'O Brannigan Yard');
add('short', "O'Brannigan Yard vs curly apostrophe", OBR, `O${cp(0x2019)}Brannigan Yard`);
add('short', "O'Brannigan Yard vs O-Brannigan Yard", OBR, 'O-Brannigan Yard');
// 4417 Quarry Rd break variants
for (const [n, t, e] of [
  ['exact', '4417 Quarry Rd', 'HIT'], ['trailing dot', '4417 Quarry Rd.', 'HIT'], ['hyphen', '4417-Quarry-Rd', 'HIT'], ['comma', '4417, Quarry Rd', 'HIT'],
  ['newline', '4417\nQuarry Rd', 'HIT'], ['split token', '4417 Qu arry Rd', 'HIT'], ['digits split', '44 17 Quarry Rd', 'HIT'], ['hash', '#4417 Quarry Rd', 'HIT'],
  ['Road spelled out', '4417 Quarry Road', '?'], ['NEG 14417', '14417 Quarry Rd', 'miss'], ['NEG Rdg', '4417 Quarry Rdg', '?'], ['slash', '4417/Quarry/Rd', 'HIT'],
] as Array<[string, string, 'HIT' | 'miss' | '?']>) add('short-token term', `4417 Quarry Rd vs ${n}`, ADDR, t, e);
add('short-token term', '$3,875,000 vs $3,8 + 75000 split', PRICE, ['$3,8', '75000'], '?');

// ---- keys / structure
add('keys', 'term as object key', ONE, { Heronmoor: 5 });
add('keys', 'term as nested key', TWO, { a: { 'Zephyrine Holdings': { x: 1 } } });
add('keys', 'term split key|value', ONE, { Heron: 'moor' });
add('keys', 'Map key', ONE, () => new Map([['Heronmoor', 1]]));
add('split leaves', "siblings ['Heron','moor']", ONE, ['Heron', 'moor']);
add('split leaves', "siblings ['Kest','rel Ridge'] 2-word", R(['Kestrel Ridge']), ['Kest', 'rel Ridge']);
add('split leaves', "nested ['Heron',['moor']]", ONE, ['Heron', ['moor']]);
add('split leaves', "values across records {a:'Heron',b:{c:'moor'}}", ONE, { a: 'Heron', b: { c: 'moor' } });
add('split leaves', "price split ['$3,87',['5,000']]", PRICE, ['$3,87', ['5,000']]);
add('split leaves', "price split ['387',['5000']]", PRICE, ['387', ['5000']]);
add('split leaves', "Bay split ['Ba',['y12']]", BAY, ['Ba', ['y12']]);
add('split leaves', "fields {a:'Zephyrine',b:'Holdings'}", TWO, { a: 'Zephyrine', b: 'Holdings' });
add('split leaves', 'compact FP: {a:"cash", b:"fordham lane"} vs "Ash Ford Ham"', R(['Ash Ford Ham']), { a: 'cash', b: 'fordham lane' }, 'miss');
add('split leaves', 'compact FP in one string: "rash fordham" vs "Ash Ford Ham"', R(['Ash Ford Ham']), 'rash fordham lane', 'miss');
add('split leaves', 'compact FP: "midwest portfolio" vs "Westport Folio"', R(['Westport Folio']), 'midwest portfolio', 'miss');

// ---- object graph shapes
add('graph', 'shared DAG object', ONE, () => { const s = { n: 'Heronmoor' }; return { a: s, b: s }; });
add('graph', 'cyclic object', ONE, () => { const o: Record<string, unknown> = { n: 'Heronmoor' }; o.self = o; return o; });
add('graph', 'cyclic array', ONE, () => { const a: unknown[] = ['Heronmoor']; a.push(a); return a; });
add('graph', '20k-deep nested arrays', ONE, () => { let v: unknown = 'Heronmoor'; for (let i = 0; i < 20000; i++) v = [v]; return v; });
add('graph', '20k-deep nested objects', ONE, () => { let v: unknown = 'Heronmoor'; for (let i = 0; i < 20000; i++) v = { c: v }; return v; });
add('graph', '200k-key object, term in a value', ONE, () => { const o: Record<string, string> = {}; for (let i = 0; i < 200000; i++) o['k' + i] = 'x'; o.z = 'Heronmoor'; return o; });
add('graph', '200k-key object, term as a key', ONE, () => { const o: Record<string, string> = {}; for (let i = 0; i < 200000; i++) o['k' + i] = 'x'; o['Heronmoor'] = 'x'; return o; });
add('graph', 'exponential DAG depth 22 (4M leaves)', ONE, () => { let v: unknown = 'ab'; for (let i = 0; i < 22; i++) v = [v, v]; return v; }, '?');
add('values', 'boxed Number price', PRICE, () => ({ price: new Number(3875000) }));
add('values', 'boxed String word', ONE, () => ({ n: new String('Heronmoor') }));
add('values', 'boxed String two words', TWO, () => ({ n: new String('Zephyrine Holdings') }));
add('values', 'toJSON returning term', ONE, () => ({ toJSON: () => 'Heronmoor' }));
add('values', 'class with toJSON nested', ONE, () => ({ x: { toJSON: () => ({ name: 'Heronmoor' }) } }));
add('values', 'Date (no term, sanity)', ONE, () => ({ d: new Date(0) }), 'miss');
add('values', 'Map value', ONE, () => new Map([['k', 'Heronmoor']]));
add('values', 'Set value', ONE, () => new Set(['Heronmoor']));
add('values', 'BigInt price', PRICE, () => ({ p: 3875000n }));
add('values', 'Error message', ONE, () => ({ e: new Error('Heronmoor deal') }));
add('values', 'Error cause', ONE, () => new Error('x', { cause: 'Heronmoor' }));
add('values', 'AggregateError errors', ONE, () => new AggregateError([new Error('Heronmoor')], 'agg'));
add('values', 'URL percent-encoded', TWO, () => ({ u: new URL('https://x.test/Zephyrine%20Holdings') }));
add('values', 'URL path single word', ONE, () => ({ u: new URL('https://x.test/Heronmoor') }));
add('values', 'percent-encoded STRING (both accepted limit)', TWO, 'https://x.test/Zephyrine%20Holdings', '?');
add('values', 'non-enumerable property', ONE, () => Object.defineProperty({}, 'n', { value: 'Heronmoor', enumerable: false }), '?');
add('values', 'symbol-keyed property', ONE, () => ({ [Symbol('s')]: 'Heronmoor' }), '?');
add('values', 'getter property', ONE, () => ({ get n() { return 'Heronmoor'; } }));

// ---- context / anchor
const CTX = R([], ['Harbor Point'], ['Project Quill']);
add('context', 'anchor + context', CTX, 'Project Quill update: Harbor Point');
add('context', 'context alone (NEG)', CTX, 'Harbor Point update', 'miss');
add('context', 'anchor alone (NEG)', CTX, 'Project Quill update', 'miss');
add('context', 'obfuscated anchor + context', CTX, `Project${cp(0xa0)}Qu${cp(0x200b)}ill / Harbor${cp(0x2009)}Point`);
add('context', 'anchor in-word + context in-word', CTX, 'Project Quillon / Harbor Pointe', '?');
add('context', 'anchor in key, context in value', CTX, { 'Project Quill': 'Harbor Point' });
add('context', 'anchor split across siblings', CTX, [['Project Qu', 'ill'], 'Harbor Point']);
add('context', 'invisible-only anchor (unanchored, fail closed)', R([], ['Harbor Point'], [cp(0x200b)]), 'Harbor Point', 'HIT');
add('context', 'empty-string anchor next to real anchor', R([], ['Harbor Point'], ['', 'Project Quill']), 'Harbor Point', 'HIT');
add('context', 'short context term bounded (Lot 4 vs Lot 40)', R([], ['Lot 4'], ['Project Quill']), 'Project Quill Lot 40', 'miss');
add('context', 'inactive group', { syn: { label: 'SYN', active: false, always: ['Heronmoor'] } }, 'Heronmoor', 'miss');
add('roster-side', 'term stored with NBSP', R([`Zephyrine${cp(0xa0)}Holdings`]), 'Zephyrine Holdings');
add('roster-side', 'term stored full-width', R(['Ｈｅｒｏｎｍｏｏｒ']), 'Heronmoor');
add('roster-side', 'term stored with ZWSP', R([`Heron${cp(0x200b)}moor`]), 'Heronmoor');
add('roster-side', 'term with leading/trailing spaces', R(['  Heronmoor  ']), 'Heronmoor');
add('roster-side', 'term with trailing punctuation', R(['Heronmoor,']), 'Heronmoor', '?');


/** [M, W] per case from the differential analysis (main scanForConfidential, branch rosterMatchWithTerms). */
const REPORT: Record<string, [string, string]> = {
  "baseline | plain single word": ["HIT", "HIT"],
  "baseline | plain two words": ["HIT", "HIT"],
  "baseline | unrelated text": ["miss", "miss"],
  "NBSP | NBSP as separator": ["HIT", "HIT"],
  "NBSP | ideographic space": ["HIT", "HIT"],
  "NBSP | narrow NBSP": ["HIT", "HIT"],
  "zero-width | ZWSP mid-word (1 token)": ["HIT", "HIT"],
  "zero-width | ZWSP as separator": ["HIT", "HIT"],
  "zero-width | ZWJ / WJ / BOM mid-word": ["HIT", "HIT"],
  "zero-width | soft hyphen mid-word": ["HIT", "HIT"],
  "zero-width | variation selector mid-word": ["HIT", "HIT"],
  "zero-width | CGJ mid-word": ["HIT", "HIT"],
  "zero-width | Hangul filler as separator": ["HIT", "HIT"],
  "bidi | RLO inside word": ["HIT", "HIT"],
  "bidi | LRI/PDI inside word": ["HIT", "HIT"],
  "bidi | RLO run rendering reversed text": ["HIT", "miss"],
  "bidi | RLO reversed two-word": ["miss", "miss"],
  "tag chars | tag A inside word": ["HIT", "HIT"],
  "tag chars | tag run inside word": ["HIT", "HIT"],
  "control | NUL inside word": ["HIT", "HIT"],
  "control | DEL inside word": ["HIT", "HIT"],
  "control | SOH inside word": ["HIT", "HIT"],
  "control | C1 0x90 inside word": ["HIT", "HIT"],
  "control | NEL inside word": ["miss", "HIT"],
  "control | ESC inside word": ["HIT", "HIT"],
  "private-use | U+E000 inside word": ["miss", "HIT"],
  "private-use | plane-15 PUA inside word": ["miss", "HIT"],
  "noncharacter | U+FDD0 inside word": ["miss", "HIT"],
  "noncharacter | U+FFFF inside word": ["miss", "HIT"],
  "unassigned | U+0378 inside word": ["miss", "HIT"],
  "unassigned | lone surrogate inside word": ["miss", "HIT"],
  "full-width | full-width word": ["HIT", "HIT"],
  "full-width | full-width two words": ["HIT", "HIT"],
  "math-styled | math bold": ["HIT", "HIT"],
  "math-styled | math double-struck H + plain": ["HIT", "HIT"],
  "math-styled | math sans-serif italic": ["HIT", "HIT"],
  "small caps | Latin small capitals": ["miss", "HIT"],
  "letter symbols | regional indicator letters": ["miss", "HIT"],
  "letter symbols | negative squared letters": ["miss", "HIT"],
  "letter symbols | circled letters (decomposable)": ["HIT", "HIT"],
  "ligatures | fi ligature": ["HIT", "HIT"],
  "ligatures | ff ligature": ["HIT", "HIT"],
  "ligatures | term written with ligature": ["HIT", "HIT"],
  "accents | precomposed accents": ["HIT", "HIT"],
  "accents | roster term accented, text plain": ["HIT", "HIT"],
  "combining | combining acute (Mn)": ["HIT", "HIT"],
  "combining | combining low line run": ["HIT", "HIT"],
  "combining | enclosing circle (Me)": ["miss", "HIT"],
  "combining | enclosing keycap (Me)": ["miss", "HIT"],
  "combining | spacing mark Devanagari visarga (Mc)": ["miss", "HIT"],
  "combining | 5000 combining marks inside word": ["HIT", "HIT"],
  "undecomposable | o-slash": ["miss", "HIT"],
  "undecomposable | l-stroke": ["miss", "HIT"],
  "undecomposable | sharp s": ["miss", "HIT"],
  "undecomposable | dotless i": ["miss", "HIT"],
  "undecomposable | ae ligature": ["miss", "HIT"],
  "undecomposable | thorn": ["miss", "HIT"],
  "superscripts | superscript two inside word": ["HIT", "miss"],
  "superscripts | superscript digits for a number": ["miss", "HIT"],
  "homoglyph | Cyrillic e (accepted limit both)": ["miss", "miss"],
  "digits | Arabic-Indic digits": ["HIT", "HIT"],
  "digits | Devanagari digits": ["HIT", "HIT"],
  "digits | full-width digits": ["HIT", "HIT"],
  "digits | math bold digits": ["HIT", "HIT"],
  "digits | circled digits (decomposable)": ["HIT", "HIT"],
  "digits | dingbat negative circled digits": ["miss", "HIT"],
  "digits | double circled digits": ["miss", "HIT"],
  "digits | Adlam digits (supplementary)": ["HIT", "HIT"],
  "hyphenation | line-end hyphen single word": ["miss", "HIT"],
  "hyphenation | line-end hyphen two words": ["miss", "HIT"],
  "hyphenation | line-end hyphen + CR + indent": ["miss", "HIT"],
  "hyphenation | full-width hyphen line end": ["miss", "HIT"],
  "hyphenation | U+2010 hyphen line end": ["miss", "HIT"],
  "hyphenation | soft hyphen line end": ["miss", "HIT"],
  "hyphenation | real compound at line end (term has hyphen)": ["miss", "HIT"],
  "letter-spaced | single word letter-spaced": ["miss", "HIT"],
  "letter-spaced | two words letter-spaced": ["HIT", "HIT"],
  "letter-spaced | address letter-spaced": ["HIT", "HIT"],
  "letter-spaced | short term letter-spaced": ["miss", "HIT"],
  "letter-spaced | dotted letters": ["miss", "HIT"],
  "run-together | two words run together": ["HIT", "HIT"],
  "run-together | address run together": ["HIT", "HIT"],
  "run-together | short term run together": ["miss", "HIT"],
  "run-together | term single word, text split by space": ["miss", "HIT"],
  "run-together | term single word, text split by hyphen": ["miss", "HIT"],
  "thousands | $3,875,000 vs plain": ["HIT", "HIT"],
  "thousands | $3,875,000 vs commas": ["HIT", "HIT"],
  "thousands | $3,875,000 vs dots": ["HIT", "HIT"],
  "thousands | $3,875,000 vs spaces": ["HIT", "HIT"],
  "thousands | $3,875,000 vs apostrophes": ["HIT", "HIT"],
  "thousands | $3,875,000 vs NBSP groups": ["HIT", "HIT"],
  "thousands | $3,875,000 vs thin-space groups": ["HIT", "HIT"],
  "thousands | $3,875,000 vs underscores": ["HIT", "HIT"],
  "thousands | $3,875,000 vs with cents": ["HIT", "HIT"],
  "thousands | $3,875,000 vs currency space": ["HIT", "HIT"],
  "thousands | $3,875,000 vs letter-spaced digits": ["HIT", "HIT"],
  "thousands | $3,875,000 vs stray space": ["HIT", "HIT"],
  "thousands | $3,875,000 vs moved break 38 75 000": ["HIT", "miss"],
  "thousands | $3,875,000 vs $3.875M": ["miss", "miss"],
  "thousands | $3,875,000 vs Arabic thousands sep": ["HIT", "HIT"],
  "thousands | bare 4250000 vs lakh 42,50,000": ["HIT", "HIT"],
  "thousands | bare 4250000 vs $4,250,000": ["HIT", "HIT"],
  "numeric-neg | $4,250,000 vs 14,250,000": ["miss", "miss"],
  "numeric-neg | $4,250,000 vs 4,250,000,000": ["miss", "HIT"],
  "numeric-neg | $250,000 vs $1,250,000": ["miss", "HIT"],
  "numeric-neg | $250,000 vs 250,000,000": ["miss", "HIT"],
  "numeric-neg | $3,875,000 vs 13875000": ["miss", "miss"],
  "numeric-neg | Building 42, 50,000 SF vs $4,250,000": ["miss", "miss"],
  "numeric-neg | Building 42 50,000 SF vs $4,250,000": ["HIT", "miss"],
  "numeric-neg | {a:['42'],b:{c:'50,000'}} vs $4,250,000": ["HIT", "miss"],
  "numeric-neg | ['42', ['50', ['000']]] vs $4,250,000": ["HIT", "miss"],
  "numeric-neg | two fields 42 / 50000 (numbers)": ["HIT", "miss"],
  "numeric-neg | Suite 7 250,000 vs $250,000 (ambiguous)": ["HIT", "HIT"],
  "short | K.C. vs K.C.": ["HIT", "HIT"],
  "short | K.C. vs KC": ["miss", "HIT"],
  "short | K.C. vs K C": ["miss", "HIT"],
  "short | K.C. vs Back carriage (NEG)": ["miss", "miss"],
  "short | K.C. vs kc inside word (NEG)": ["miss", "miss"],
  "short | Bldg #1 vs Bldg #1": ["HIT", "HIT"],
  "short | Bldg #1 vs Bldg 1": ["miss", "HIT"],
  "short | Bldg #1 vs Bldg1": ["miss", "HIT"],
  "short | Bldg #1 vs Bldg 10 (NEG)": ["miss", "miss"],
  "short | Bldg #1 vs Bldg #10 (NEG)": ["HIT", "HIT"],
  "short | Bay 12 vs Bay 120 (NEG)": ["HIT", "HIT"],
  "short | Bay 12 vs Bay-12": ["miss", "HIT"],
  "short | Bay 12 vs Bay #12": ["miss", "HIT"],
  "short | Bay 12 vs Bay  12 (2 spaces)": ["HIT", "HIT"],
  "short | Bay 12 vs Bay\\n12": ["HIT", "HIT"],
  "short | Bay 12 vs Ebay 12 (NEG)": ["HIT", "HIT"],
  "short | Bay 12 vs B ay12": ["miss", "miss"],
  "short | O'Brannigan Yard vs OBrannigan Yard": ["miss", "HIT"],
  "short | O'Brannigan Yard vs O Brannigan Yard": ["miss", "HIT"],
  "short | O'Brannigan Yard vs curly apostrophe": ["HIT", "HIT"],
  "short | O'Brannigan Yard vs O-Brannigan Yard": ["miss", "HIT"],
  "short-token term | 4417 Quarry Rd vs exact": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs trailing dot": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs hyphen": ["miss", "HIT"],
  "short-token term | 4417 Quarry Rd vs comma": ["miss", "HIT"],
  "short-token term | 4417 Quarry Rd vs newline": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs split token": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs digits split": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs hash": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs Road spelled out": ["miss", "miss"],
  "short-token term | 4417 Quarry Rd vs NEG 14417": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs NEG Rdg": ["HIT", "HIT"],
  "short-token term | 4417 Quarry Rd vs slash": ["miss", "HIT"],
  "short-token term | $3,875,000 vs $3,8 + 75000 split": ["HIT", "miss"],
  "keys | term as object key": ["miss", "HIT"],
  "keys | term as nested key": ["miss", "HIT"],
  "keys | term split key|value": ["miss", "HIT"],
  "keys | Map key": ["HIT", "HIT"],
  "split leaves | siblings ['Heron','moor']": ["miss", "HIT"],
  "split leaves | siblings ['Kest','rel Ridge'] 2-word": ["HIT", "HIT"],
  "split leaves | nested ['Heron',['moor']]": ["miss", "HIT"],
  "split leaves | values across records {a:'Heron',b:{c:'moor'}}": ["miss", "HIT"],
  "split leaves | price split ['$3,87',['5,000']]": ["HIT", "HIT"],
  "split leaves | price split ['387',['5000']]": ["HIT", "HIT"],
  "split leaves | Bay split ['Ba',['y12']]": ["miss", "HIT"],
  "split leaves | fields {a:'Zephyrine',b:'Holdings'}": ["HIT", "HIT"],
  "split leaves | compact FP: {a:\"cash\", b:\"fordham lane\"} vs \"Ash Ford Ham\"": ["HIT", "miss"],
  "split leaves | compact FP in one string: \"rash fordham\" vs \"Ash Ford Ham\"": ["HIT", "miss"],
  "split leaves | compact FP: \"midwest portfolio\" vs \"Westport Folio\"": ["HIT", "miss"],
  "graph | shared DAG object": ["HIT", "HIT"],
  "graph | cyclic object": ["HIT", "HIT"],
  "graph | cyclic array": ["HIT", "HIT"],
  "graph | 20k-deep nested arrays": ["THROW(RangeError)", "HIT"],
  "graph | 20k-deep nested objects": ["THROW(RangeError)", "HIT"],
  "graph | 200k-key object, term in a value": ["HIT", "HIT"],
  "graph | 200k-key object, term as a key": ["miss", "HIT"],
  "graph | exponential DAG depth 22 (4M leaves)": ["miss", "THROW(ScanBudgetError)"],
  "values | boxed Number price": ["miss", "HIT"],
  "values | boxed String word": ["miss", "HIT"],
  "values | boxed String two words": ["HIT", "HIT"],
  "values | toJSON returning term": ["miss", "HIT"],
  "values | class with toJSON nested": ["miss", "HIT"],
  "values | Date (no term, sanity)": ["miss", "miss"],
  "values | Map value": ["HIT", "HIT"],
  "values | Set value": ["HIT", "HIT"],
  "values | BigInt price": ["HIT", "HIT"],
  "values | Error message": ["HIT", "miss"],
  "values | Error cause": ["HIT", "miss"],
  "values | AggregateError errors": ["HIT", "miss"],
  "values | URL percent-encoded": ["HIT", "miss"],
  "values | URL path single word": ["HIT", "HIT"],
  "values | percent-encoded STRING (both accepted limit)": ["miss", "miss"],
  "values | non-enumerable property": ["miss", "miss"],
  "values | symbol-keyed property": ["miss", "miss"],
  "values | getter property": ["HIT", "HIT"],
  "context | anchor + context": ["HIT", "HIT"],
  "context | context alone (NEG)": ["miss", "miss"],
  "context | anchor alone (NEG)": ["miss", "miss"],
  "context | obfuscated anchor + context": ["HIT", "HIT"],
  "context | anchor in-word + context in-word": ["HIT", "HIT"],
  "context | anchor in key, context in value": ["miss", "HIT"],
  "context | anchor split across siblings": ["HIT", "HIT"],
  "context | invisible-only anchor (unanchored, fail closed)": ["HIT", "miss"],
  "context | empty-string anchor next to real anchor": ["HIT", "HIT"],
  "context | short context term bounded (Lot 4 vs Lot 40)": ["HIT", "HIT"],
  "context | inactive group": ["miss", "miss"],
  "roster-side | term stored with NBSP": ["HIT", "HIT"],
  "roster-side | term stored full-width": ["HIT", "HIT"],
  "roster-side | term stored with ZWSP": ["HIT", "HIT"],
  "roster-side | term with leading/trailing spaces": ["HIT", "HIT"],
  "roster-side | term with trailing punctuation": ["miss", "HIT"],
};

function run(fn: () => unknown): string {
  try {
    return fn() ? 'HIT' : 'miss';
  } catch (e) {
    return `THROW(${e instanceof Error ? e.constructor.name : typeof e})`;
  }
}
const key = (c: Case) => `${c.cls} | ${c.name}`;

/** Cases the corpus marks as a negative ('miss') that the union HITS: over-matches one side already
 *  had (main's digit-run form, or roster-core's raw substring / sibling-compact passes). Fail-closed
 *  availability costs, never a leak; pinned so any change to the set is deliberate. */
const ACCEPTED_OVERMATCH = [
  'numeric-neg | $4,250,000 vs 4,250,000,000',
  'numeric-neg | $250,000 vs $1,250,000',
  'numeric-neg | $250,000 vs 250,000,000',
  'numeric-neg | Building 42 50,000 SF vs $4,250,000',
  "numeric-neg | {a:['42'],b:{c:'50,000'}} vs $4,250,000",
  "numeric-neg | ['42', ['50', ['000']]] vs $4,250,000",
  'numeric-neg | two fields 42 / 50000 (numbers)',
  'short | Bldg #1 vs Bldg #10 (NEG)',
  'short | Bay 12 vs Bay 120 (NEG)',
  'short | Bay 12 vs Ebay 12 (NEG)',
  'short-token term | 4417 Quarry Rd vs NEG 14417',
  'split leaves | compact FP: {a:"cash", b:"fordham lane"} vs "Ash Ford Ham"',
  'split leaves | compact FP in one string: "rash fordham" vs "Ash Ford Ham"',
  'split leaves | compact FP: "midwest portfolio" vs "Westport Folio"',
  'context | short context term bounded (Lot 4 vs Lot 40)',
].sort();

describe('differential regression: the merged gate catches everything either matcher caught', () => {
  it('the corpus and the report agree (204 cases, every case reported)', () => {
    expect(cases.length).toBe(204);
    for (const c of cases) expect(REPORT[key(c)], key(c)).toBeDefined();
  });

  it.each(cases.map((c) => [key(c), c] as const))('%s', (_k, c) => {
    const [m, w] = REPORT[key(c)]!;
    const union = run(() => rosterMatchWithTerms(c.value(), c.terms));
    if (m === 'HIT' || w === 'HIT') expect(union).toBe('HIT');
    else if (m.startsWith('THROW') || w.startsWith('THROW')) expect(union).toMatch(/^THROW\(ScanBudgetError\)$/);
    else expect(union).toBe('miss');
  }, 30_000);

  it('the accepted over-match set (corpus negatives the union hits) is exactly the pinned list', () => {
    // Refute wf_fb340eb2 (P5): computed from the LIVE gate, not from REPORT, so a gate change that
    // adds or drops an over-match fails here.
    const got = cases
      .filter((c) => c.expect === 'miss')
      .filter((c) => run(() => rosterMatchWithTerms(c.value(), c.terms)) === 'HIT')
      .map(key)
      .sort();
    expect(got).toEqual(ACCEPTED_OVERMATCH);
    // ...and the pinned list is still exactly the negatives either parent already hit (REPORT).
    const reported = cases
      .filter((c) => c.expect === 'miss')
      .filter((c) => {
        const [m, w] = REPORT[key(c)]!;
        return m === 'HIT' || w === 'HIT';
      })
      .map(key)
      .sort();
    expect(reported).toEqual(ACCEPTED_OVERMATCH);
  }, 60_000);
});
