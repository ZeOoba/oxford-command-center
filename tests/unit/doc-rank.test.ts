import { describe, expect, it } from 'vitest';
import type { KnnRow } from '../../server/sources/doc-index-protocol';
import {
  ALL_TERMS_BOOST,
  DRAFT_PENALTY,
  MAX_ENTITY_TERMS,
  MAX_SCOPED_DOCS,
  MAX_TERM_DOCS,
  PATH_EXTRA_BOOST,
  PATH_TERM_BOOST,
  buildPathVocab,
  fuseCandidates,
  isDraftDoc,
  pickEntities,
  textKey,
} from '../../server/sources/doc-rank';

/** Build a KnnRow. `distance` is the sqlite-vec L2 distance; score = 1 / (1 + distance). */
function row(docName: string, idx: number, text: string, distance: number): KnnRow {
  return { chunk: { docId: docName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), docName, idx, text }, distance };
}
const BOILER = 'Option to Renew. Provided that this Lease is in full force and effect and Tenant is not in default, Tenant may renew.';
const docs = (...names: string[]) => names.map((name) => ({ name }));

/** A small realistic corpus: a named tenant with several files, generic words with high document counts. */
const CORPUS = docs(
  'Business\\55 New Plant Court\\Lease Dibita -- 55 New Plant Court 10-2022.pdf',
  'Business\\55 New Plant Court\\Dibita Commission Agreement.docx',
  'Business\\55 New Plant Court\\Lease Dibta -- EG comments 8-17-22.docx',
  'Business\\3540 East Fifth Ave\\QRT Lease -- 3540 East Fifth Avenue 03-2023.docx',
  'Business\\3540 East Fifth Ave\\QRT Perfume Lease.docx',
  'Business\\Insurance\\Insurance Certificate Alpha.pdf',
  'Business\\Insurance\\Insurance Certificate Beta.pdf',
  'Business\\Ledgers\\Tenant Security Deposit Ledger.xlsx',
  'Business\\UPS Store\\Lease UPS 2021.pdf',
  'Business\\Café Brûlé\\Lease Café Brûlé.pdf',
  'Business\\Westerville\\Example Roofing Lease Westerville.pdf',
  'Business\\Westerville\\Westerville Tax Bill.pdf',
  'Business\\Westerville\\Westerville Survey.pdf',
  // 130 documents that all mention "columbus": too common to be a name
  ...Array.from({ length: MAX_TERM_DOCS + 10 }, (_, i) => `Business\\Columbus\\Columbus Report ${i}.pdf`),
);
const vocab = buildPathVocab(CORPUS);

describe('buildPathVocab', () => {
  it('counts documents per path word, lower-cased, ignoring words shorter than 3 and repeats within one path', () => {
    expect(vocab.df('dibita')).toBe(2);
    expect(vocab.df('qrt')).toBe(2);
    expect(vocab.df('55')).toBe(0); // too short
    expect(vocab.df('court')).toBe(3);
    expect(vocab.df('nonexistent')).toBe(0);
    expect(vocab.docsOf('dibita')).toContain('Business\\55 New Plant Court\\Dibita Commission Agreement.docx');
  });
  it('handles non-ASCII names (one document carries them, however often the path repeats them)', () => {
    expect(vocab.df('café')).toBe(1);
    expect(vocab.df('brûlé')).toBe(1);
  });
});

describe('pickEntities — names grounded in the corpus', () => {
  it('finds the tenant even when generic words that also occur in paths come first (review finding a)', () => {
    const pick = pickEntities('What are the operating expense reimbursement and insurance obligations in the Dibita lease?', vocab);
    expect(pick.terms).toEqual(['dibita']); // "insurance" is in the corpus but is lowercase, "Dibita" is the name
    expect(pick.docNames.every((n) => n.toLowerCase().includes('dibita'))).toBe(true);
  });

  it('does not let generic path words outvote the name (review finding b)', () => {
    const pick = pickEntities('What is the security deposit for Dibita?', vocab);
    expect(pick.terms).toEqual(['dibita']);
    expect(pick.docNames).not.toContain('Business\\Ledgers\\Tenant Security Deposit Ledger.xlsx');
  });

  it('falls back to the rarest corpus words when the question has no capitalized name', () => {
    const pick = pickEntities('dibita renewal option', vocab);
    expect(pick.terms).toEqual(['dibita']);
  });

  it('sees short and non-ASCII names (review finding c)', () => {
    expect(pickEntities('QRT lease 3540 East Fifth Avenue', vocab).terms).toContain('qrt');
    expect(pickEntities('What is the UPS lease expiration?', vocab).terms).toEqual(['ups']);
    expect(pickEntities('Café Brûlé lease term', vocab).terms).toEqual(expect.arrayContaining(['café', 'brûlé']));
  });

  it('ignores words that are absent from the corpus, generic, or too common (>MAX_TERM_DOCS documents)', () => {
    expect(pickEntities('What does the lease say about renewal notice?', vocab)).toEqual({ terms: [], docNames: [] });
    expect(pickEntities('Zorblax lease', vocab)).toEqual({ terms: [], docNames: [] });
    expect(pickEntities('Columbus Dibita', vocab).terms).toEqual(['dibita']);
    expect(pickEntities('', vocab)).toEqual({ terms: [], docNames: [] });
  });

  it('keeps at most MAX_ENTITY_TERMS words, preferring the rarest (word i appears in i+1 documents)', () => {
    const n = MAX_ENTITY_TERMS + 2;
    const words = Array.from({ length: n }, (_, i) => `Name${String.fromCharCode(97 + i).repeat(3)}`); // Nameaaa, Namebbb, ...
    const names: string[] = [];
    words.forEach((w, i) => {
      for (let d = 0; d <= i; d += 1) names.push(`Folder\\${w} file ${d}.pdf`);
    });
    const many = buildPathVocab(docs(...names));
    const pick = pickEntities(`Compare ${[...words].reverse().join(', ')}`, many);
    expect(pick.terms).toHaveLength(MAX_ENTITY_TERMS);
    expect(pick.terms).toEqual(words.slice(0, MAX_ENTITY_TERMS).map((w) => w.toLowerCase())); // the rarest, in rarity order
  });

  it('scopes to documents containing ALL the words when any do (a path counts, folders included)', () => {
    const pick = pickEntities('QRT 3540 East Fifth', vocab);
    expect(pick.docNames.sort()).toEqual([
      'Business\\3540 East Fifth Ave\\QRT Lease -- 3540 East Fifth Avenue 03-2023.docx',
      'Business\\3540 East Fifth Ave\\QRT Perfume Lease.docx',
    ]);
  });

  it('a capitalized name at the very start of the question still counts (review: "Dibita renewal…")', () => {
    expect(pickEntities('Dibita renewal option', vocab).terms).toEqual(['dibita']);
  });

  it('when the words share no document, scopes to the union of the two rarest words documents', () => {
    const pick = pickEntities('Dibita Westerville', vocab);
    expect(pick.docNames.some((n) => n.includes('Dibita'))).toBe(true);
    expect(pick.docNames.some((n) => n.includes('Westerville'))).toBe(true);
    expect(pick.docNames.length).toBeLessThanOrEqual(MAX_SCOPED_DOCS);
  });
});

describe('isDraftDoc — negotiation drafts must not outrank executed documents', () => {
  it.each([
    'Business\\55 New Plant Court\\Initial Lease Draft 7-19-22.docx',
    'Business\\55 New Plant Court\\Lease Dibita -- 08-2022 EG Comments.pdf',
    'Business\\X\\Lease QRT -- EG Redline 02-28.docx',
    'Business\\X\\Lease draft v2 LL comments off T RL.docx',
    'Business\\X\\Lease markup 3-9-23.docx',
    'Business\\X\\Lease Proposal Dibita - Clean 7-8-22.docx',
    // review finding f: glued / plural forms
    'Business\\X\\Lease Drafts.docx',
    'Business\\X\\LeaseDraft.pdf',
    'Business\\X\\Lease_markups.docx',
    'Business\\X\\Final Draft Lease.docx',
  ])('flags %s', (p) => expect(isDraftDoc(p)).toBe(true));

  it.each([
    'Business\\55 New Plant Court\\Lease Dibita -- 55 New Plant Court 10-2022.pdf',
    'Business\\Investment Candidates -- 2026\\Signed Synthwind Lease (1) (1)_OCR.pdf',
    'Business\\X\\Lease Fairground Village -- Unit 19 Example Grill Lease Extension 2015.pdf',
    'Business\\X\\Lease Amendment # 2 10-2017 and Guaranty.pdf',
    // review finding f: an explicit executed/signed/final marker wins
    'Business\\X\\Lease - Executed no comments.pdf',
    'Business\\X\\Final (supersedes proposal).pdf',
    'Business\\X\\Proposed Premises Exhibit - Executed Lease.pdf',
    'Business\\X\\Lease signed - comments resolved.pdf',
  ])('does not flag %s', (p) => expect(isDraftDoc(p)).toBe(false));
});

describe('textKey — identical copies collapse, different text does not', () => {
  it('ignores whitespace and case differences', () => {
    expect(textKey('Tenant  shall\nhave an OPTION to renew')).toBe(textKey('tenant shall have an option to renew'));
  });
  it('differs when the clause text differs', () => {
    expect(textKey('Renewal Term January 1, 2028 to December 31, 2032')).not.toBe(textKey('Renewal Term January 1, 2030 to December 31, 2034'));
  });
});

describe('fuseCandidates', () => {
  it('collapses byte-identical copies into one hit and lists the other paths', () => {
    const a = row('Business\\Leases\\Cell Tower Lease.pdf', 16, BOILER, 0.9);
    const b = row('Business\\Master Lease Database\\00\\Cell Tower Lease.pdf', 16, BOILER, 0.9);
    const c = row('Business\\Sepich\\Leases\\Cell Tower Lease.pdf', 16, BOILER, 0.9);
    const out = fuseCandidates({ terms: [], knn: [a, b, c], scoped: [], limit: 8 });
    expect(out).toHaveLength(1);
    expect(out[0]!.row.chunk.docName).toBe(a.chunk.docName);
    expect([...out[0]!.alsoIn].sort()).toEqual([b.chunk.docName, c.chunk.docName].sort());
  });

  it('when a better-scoring copy replaces an earlier one, the earlier path moves to alsoIn (review finding C6)', () => {
    const early = row('Business\\Far\\Copy.pdf', 1, BOILER, 1.0);
    const better = row('Business\\Near\\Copy.pdf', 1, BOILER, 0.8);
    const out = fuseCandidates({ terms: [], knn: [early, better], scoped: [], limit: 8 });
    expect(out).toHaveLength(1);
    expect(out[0]!.row.chunk.docName).toBe(better.chunk.docName);
    expect(out[0]!.alsoIn).toEqual([early.chunk.docName]);
  });

  it('keeps different clauses from different documents as separate hits', () => {
    const a = row('Business\\A\\Lease A.pdf', 3, `${BOILER} Term five years.`, 0.9);
    const b = row('Business\\B\\Lease B.pdf', 3, `${BOILER} Term ten years.`, 0.95);
    expect(fuseCandidates({ terms: [], knn: [a, b], scoped: [], limit: 8 }).map((h) => h.row.chunk.docName)).toEqual([a.chunk.docName, b.chunk.docName]);
  });

  it('with no entity words, order is the semantic order', () => {
    const rows = [row('Business\\A\\x.pdf', 0, 'one', 0.8), row('Business\\B\\y.pdf', 0, 'two', 0.9), row('Business\\C\\z.pdf', 0, 'three', 1.0)];
    expect(fuseCandidates({ terms: [], knn: [...rows].reverse(), scoped: [], limit: 8 }).map((h) => h.row.chunk.docName)).toEqual(rows.map((r) => r.chunk.docName));
  });

  it('boosts a chunk whose PATH names the entity above higher-scoring generic boilerplate', () => {
    const generic = row('Business\\QRT\\QRT Lease.docx', 99, BOILER, 0.9);
    const named = row('Business\\55 New Plant Court\\Lease Dibita -- 10-2022.pdf', 96, 'Renewal Term January 1, 2028 to December 31, 2032', 1.0);
    expect(fuseCandidates({ terms: ['dibita'], knn: [generic, named], scoped: [], limit: 8 })[0]!.row.chunk.docName).toBe(named.chunk.docName);
  });

  it('a MATCHED path word is a boost, not a vote: more matched generic words cannot beat a clearly better semantic match (review finding b)', () => {
    const ledger = row('Business\\Ledgers\\Tenant Security Deposit Ledger.xlsx', 0, 'Deposit ledger rows.', 1.0); // semantic 0.500, matches 2 words
    const lease = row('Business\\55 New Plant Court\\Lease Dibita 10-2022.pdf', 7, 'Security deposit is two months rent.', 0.75); // semantic 0.571, matches 1 word
    const out = fuseCandidates({ terms: ['security', 'deposit', 'dibita'], knn: [ledger, lease], scoped: [], limit: 8 });
    expect(out[0]!.row.chunk.docName).toBe(lease.chunk.docName);
    expect(PATH_EXTRA_BOOST).toBeLessThan(PATH_TERM_BOOST / 3); // extra words are a tie-breaker
  });

  it('a document naming ALL the entity words beats ones naming only some, even when those are semantically closer ("Example Grill")', () => {
    // semantic 0.62 / 0.54: without the all-words boost the closer tattoo-shop chunk (one word) would win.
    const tattoo = row('Business\\FVC\\Lease Unit 14 REDACTED-690.pdf', 0, 'Term five years renewal option.', 1 / 0.62 - 1);
    const grill = row('Business\\FVC\\Lease Unit 19 Westminster Example Grill Lease Extension 2015.pdf', 0, 'Extension of the term.', 1 / 0.54 - 1);
    const out = fuseCandidates({ terms: ['grill', 'westminster'], knn: [tattoo], scoped: [grill], limit: 8 });
    expect(out[0]!.row.chunk.docName).toBe(grill.chunk.docName);
    // ...but only when SEVERAL entities were named: with one entity word the bonus does not exist.
    const solo = fuseCandidates({ terms: ['westminster'], knn: [tattoo], scoped: [grill], limit: 8 });
    expect(solo[0]!.row.chunk.docName).toBe(tattoo.chunk.docName);
    expect(ALL_TERMS_BOOST).toBeGreaterThan(PATH_EXTRA_BOOST);
  });

  it('pulls in a chunk that ONLY the entity-scoped pool found (outside the vector pool)', () => {
    const noise = Array.from({ length: 40 }, (_, i) => row(`Business\\N${i}\\Lease N${i}.pdf`, 1, `${BOILER} variation ${i}`, 0.95 + i * 0.001));
    const target = row('Business\\55 New Plant Court\\Lease Dibita -- 10-2022.pdf', 96, 'Renewal Term January 1, 2028 to December 31, 2032', 1.1);
    expect(fuseCandidates({ terms: ['dibita'], knn: noise, scoped: [target], limit: 5 })[0]!.row.chunk.docName).toBe(target.chunk.docName);
  });

  it('counts a chunk found by BOTH pools once', () => {
    const t = row('Business\\55 New Plant Court\\Lease Dibita -- 10-2022.pdf', 96, 'Renewal Term clause', 1.0);
    expect(fuseCandidates({ terms: ['dibita'], knn: [t], scoped: [t], limit: 8 })).toHaveLength(1);
  });

  it('demotes a negotiation draft below the executed lease with equal relevance', () => {
    const executed = row('Business\\55 New Plant Court\\Lease Dibita -- 55 New Plant Court 10-2022.pdf', 96, 'Executed renewal clause text', 1.0);
    const draft = row('Business\\55 New Plant Court\\Lease Dibita -- 08-2022 EG Comments.pdf', 94, 'Draft renewal clause text', 0.99);
    const out = fuseCandidates({ terms: ['dibita'], knn: [draft, executed], scoped: [], limit: 8 });
    expect(out[0]!.row.chunk.docName).toBe(executed.chunk.docName);
    expect(out.find((h) => h.row.chunk.docName === draft.chunk.docName)!.draft).toBe(true);
    expect(DRAFT_PENALTY).toBeGreaterThan(0);
  });

  it('with IDENTICAL text, the executed copy is returned (draft listed in alsoIn) even if the draft scores better (review finding e)', () => {
    const text = 'Option to Renew. Renewal Term from January 1, 2028 to December 31, 2032.';
    const draft = row('Business\\55 New Plant Court\\Dibita Lease DRAFT.docx', 5, text, 0.7); // much closer in vector space
    const executed = row('Business\\Leases\\Lease Dibita 10-2022.pdf', 5, text, 1.0);
    for (const order of [[draft, executed], [executed, draft]]) {
      const out = fuseCandidates({ terms: ['dibita'], knn: order, scoped: [], limit: 8 });
      expect(out).toHaveLength(1);
      expect(out[0]!.row.chunk.docName).toBe(executed.chunk.docName);
      expect(out[0]!.draft).toBe(false);
      expect(out[0]!.alsoIn).toEqual([draft.chunk.docName]);
    }
  });

  it('breaks exact score ties deterministically: document name, then chunk index', () => {
    const rows = [row('Business\\B\\b.pdf', 2, 'text b2', 1.0), row('Business\\A\\a.pdf', 9, 'text a9', 1.0), row('Business\\B\\b.pdf', 1, 'text b1', 1.0)];
    const names = fuseCandidates({ terms: [], knn: rows, scoped: [], limit: 8 }).map((h) => `${h.row.chunk.docName.split('\\').pop()}#${h.row.chunk.idx}`);
    expect(names).toEqual(['a.pdf#9', 'b.pdf#1', 'b.pdf#2']);
    expect(fuseCandidates({ terms: [], knn: [...rows].reverse(), scoped: [], limit: 8 }).map((h) => `${h.row.chunk.docName.split('\\').pop()}#${h.row.chunk.idx}`)).toEqual(names);
  });

  it('a fused score can exceed 1 (the cap is applied when hits are shaped, not here)', () => {
    const t = row('Business\\Dibita\\Lease Dibita Dibita Court.pdf', 0, 'Dibita renewal', 0.05);
    expect(fuseCandidates({ terms: ['dibita', 'court'], knn: [t], scoped: [], limit: 1 })[0]!.score).toBeGreaterThan(1);
  });

  it('drops rows with a non-finite distance (NaN/Infinity) or empty text, even when fewer rows than the limit remain', () => {
    const good = [row('Business\\A\\a.pdf', 0, 'alpha clause', 0.9), row('Business\\B\\b.pdf', 0, 'bravo clause', 0.95), row('Business\\C\\c.pdf', 0, 'charlie clause', 1.0)];
    const bad = [row('Business\\F\\nan.pdf', 0, 'not a number distance', Number.NaN), row('Business\\G\\inf.pdf', 0, 'infinite distance', Infinity), row('Business\\E\\empty.pdf', 0, '   ', 0.5)];
    const out = fuseCandidates({ terms: [], knn: [...bad, ...good], scoped: [], limit: 8 });
    expect(out.map((h) => h.row.chunk.docName)).toEqual(good.map((r) => r.chunk.docName)); // exactly the three finite, non-empty rows
  });

  it('honors the limit', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`Business\\D${i}\\d.pdf`, 0, `distinct text number ${i}`, 0.9 + i * 0.01));
    rows.push(row('Business\\E\\empty.pdf', 0, '   ', 0.5), row('Business\\F\\nan.pdf', 0, 'not a number distance', Number.NaN), row('Business\\G\\inf.pdf', 0, 'infinite distance', Infinity));
    const out = fuseCandidates({ terms: [], knn: rows, scoped: [], limit: 8 });
    expect(out).toHaveLength(8);
    expect(out.every((h) => h.row.chunk.text.trim().length > 0 && Number.isFinite(h.score))).toBe(true);
  });

  it('identical text in two chunks of the SAME document collapses without listing the document as its own copy', () => {
    const a = row('Business\\A\\Lease.pdf', 1, BOILER, 0.9);
    const b = row('Business\\A\\Lease.pdf', 2, BOILER, 0.92);
    const out = fuseCandidates({ terms: [], knn: [a, b], scoped: [], limit: 8 });
    expect(out).toHaveLength(1);
    expect(out[0]!.alsoIn).toEqual([]);
  });
});
