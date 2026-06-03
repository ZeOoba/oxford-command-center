import { describe, it, expect } from 'vitest';
import { chunkText, searchChunks, type DocChunk } from '../../server/sources/documents';

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

describe('searchChunks — lexical RAG over passages', () => {
  const chunks: DocChunk[] = [
    { docId: 'REDACTED-659', docName: 'REDACTED-659 Lease.pdf', idx: 0, text: 'Tenant shall have one (1) option to renew for a five-year term at the then fair market rent (the renewal option).' },
    { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year manufacturer warranty installed in 2021.' },
  ];

  it('returns the matching document and a cited snippet', () => {
    const hits = searchChunks(chunks, 'renewal option', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc).toBe('REDACTED-659 Lease.pdf');
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
  });

  it('returns nothing for an empty query or empty index', () => {
    expect(searchChunks(chunks, '')).toEqual([]);
    expect(searchChunks([], 'renewal')).toEqual([]);
  });
});
