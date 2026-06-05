import { describe, it, expect } from 'vitest';
import { chunkText, isExcludedPath, type DocChunk, type Embedder, buildIndex, queryIndex, realEmbedder } from '../../server/sources/documents';

describe('chunkText', () => {
  it('returns a single chunk for short text and none for empty', () => {
    expect(chunkText('A short lease clause.')).toEqual(['A short lease clause.']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Section ${i}. ` + 'lorem ipsum dolor sit amet. ').join('\n\n');
    const chunks = chunkText(long, 400, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 600)).toBe(true);
  });
});

describe('isExcludedPath — confidentiality / personal guard', () => {
  it('excludes the confidential codename and personal/estate paths (case-insensitive)', () => {
    expect(isExcludedPath('E Fulton Street Due Dilligence Items/Phase II.pdf')).toBe(true);
    expect(isExcludedPath('deals/E. FULTON/psa.pdf')).toBe(true);
    expect(isExcludedPath('Estate Planning and Trust Documents/trust.pdf')).toBe(true);
    expect(isExcludedPath('Gabriel Documents/personal.pdf')).toBe(true);
    expect(isExcludedPath('GDG Properties EG Properties and personal info/x.pdf')).toBe(true);
  });
  it('allows ordinary property lease/PSA paths', () => {
    expect(isExcludedPath('1100 Rarig/REDACTED-659 Lease.pdf')).toBe(false);
    expect(isExcludedPath('29000 Information Lane/Shore United PSA.pdf')).toBe(false);
  });
});

// Deterministic fake embedder: 3-dim vectors keyed on simple token presence — no model, fully hermetic.
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([
      l.includes('renew') ? 1 : 0,
      l.includes('roof') ? 1 : 0,
      l.includes('rent') ? 1 : 0,
    ]);
  });

const CHUNKS: DocChunk[] = [
  { docId: 'REDACTED-659', docName: 'REDACTED-659 Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];

describe('buildIndex / queryIndex — sqlite-vec vector search (fake embedder)', () => {
  it('ranks the semantically nearest chunk first and shapes a cited, scored DocHit', async () => {
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
    expect(hits[0]!.doc).toBe('REDACTED-659 Lease.pdf');
    expect(hits[0]!.docId).toBe('REDACTED-659');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score); // closer = higher score
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
    index.close();
  });

  it('returns nothing for an empty query or empty index', async () => {
    const empty = await buildIndex([], fakeEmbedder);
    expect(await queryIndex(empty, 'renewal', fakeEmbedder, 3)).toEqual([]);
    empty.close();
    const index = await buildIndex(CHUNKS, fakeEmbedder);
    expect(await queryIndex(index, '   ', fakeEmbedder, 3)).toEqual([]);
    index.close();
  });
});

// Real-model semantic proof. Skipped in CI (no model download in `gate`); run locally with
// RUN_MODEL_TESTS=1 npx vitest run tests/unit/documents.test.ts
const maybe = process.env.RUN_MODEL_TESTS ? describe : describe.skip;
maybe('semantic retrieval (real all-MiniLM-L6-v2)', () => {
  it('finds the ROFR clause from a no-keyword-overlap query', async () => {
    const chunks: DocChunk[] = [
      { docId: 'a', docName: 'Lease A.pdf', idx: 0, text: 'Tenant shall have a right of first refusal to purchase the Premises on the same terms offered by a bona fide third party.' },
      { docId: 'b', docName: 'Lease B.pdf', idx: 0, text: 'Base rent shall escalate three percent on each anniversary of the commencement date.' },
      { docId: 'c', docName: 'Lease C.pdf', idx: 0, text: 'Landlord maintains the roof, foundation, and structural elements.' },
    ];
    const index = await buildIndex(chunks, realEmbedder);
    const hits = await queryIndex(index, 'ROFR preferential right to purchase', realEmbedder, 3);
    expect(hits[0]!.docId).toBe('a');
    index.close();
  }, 60_000);
});
