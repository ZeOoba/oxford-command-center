import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkText,
  isExcludedPath,
  isLikelyNonLease,
  matchesIndexFilters,
  maxFiles,
  maxChunksPerDoc,
  pathIncludeRe,
  buildDocIndex,
  collectDocChunks,
  docStatus,
  type DocChunk,
  type Embedder,
  buildIndex,
  loadDiskIndex,
  docIndexPath,
  queryIndex,
} from '../../server/sources/documents';

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
  it('excludes personal/estate folders by default (case-insensitive)', () => {
    expect(isExcludedPath('Estate Planning and Trust Documents/trust.pdf')).toBe(true);
    expect(isExcludedPath('Gabriel Documents/personal.pdf')).toBe(true);
    expect(isExcludedPath('GDG Properties EG Properties and personal info/x.pdf')).toBe(true);
  });
  it('excludes confidential-deal patterns supplied via DOCUMENTS_EXCLUDE (injected here, never hardcoded)', () => {
    // The real codename lives only in the gitignored env var; the guard regex-matches it.
    const patterns = [/secret-codename/i];
    expect(isExcludedPath('deals/Secret-Codename/psa.pdf', patterns)).toBe(true);
    expect(isExcludedPath('deals/Secret-Codename DD Items/phase-ii.pdf', patterns)).toBe(true);
  });
  it('allows ordinary property lease/PSA paths', () => {
    expect(isExcludedPath('1100 Rarig/REDACTED-659 Lease.pdf')).toBe(false);
    expect(isExcludedPath('29000 Information Lane/Shore United PSA.pdf')).toBe(false);
  });
});

// OS-agnostic Leases-folder pattern: matcher normalizes `\` → `/`, so only `/` is needed here.
const LEASES_RE = /(^|\/)Leases(\/)/i;

describe('matchesIndexFilters — extension + optional path-include filter', () => {
  it('requires a supported extension (pdf/txt/md), skipping docx/doc', () => {
    expect(matchesIndexFilters('PropA/Leases/x.pdf', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.txt', null)).toBe(true);
    expect(matchesIndexFilters('PropA/Leases/x.docx', null)).toBe(false);
    expect(matchesIndexFilters('PropA/Leases/x.doc', null)).toBe(false);
  });
  it('honors a Leases-only include filter (path must contain a Leases directory segment)', () => {
    expect(matchesIndexFilters('9050 Red Branch Rd/Leases/lease.pdf', LEASES_RE)).toBe(true);
    expect(matchesIndexFilters('9050 Red Branch Rd/Other/note.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('9050 Red Branch Rd/Leases.pdf', LEASES_RE)).toBe(false); // file, not a Leases folder
  });
  it('matches Windows backslash paths via separator normalization', () => {
    expect(matchesIndexFilters('29000 Information Lane\\Leases\\Shore United.pdf', LEASES_RE)).toBe(true);
    expect(matchesIndexFilters('29000 Information Lane\\Other\\x.pdf', LEASES_RE)).toBe(false);
  });
  it('drops non-lease docs even under a Leases folder', () => {
    expect(matchesIndexFilters('Sepich Portfolio/Leases/2019 Sepich I- P&L.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('Sepich Portfolio/Leases/Rent Roll -- Dec 2020.pdf', LEASES_RE)).toBe(false);
    expect(matchesIndexFilters('1100 Rarig/Leases/REDACTED-659 Lease.pdf', LEASES_RE)).toBe(true);
  });
});

describe('isLikelyNonLease — corpus tightening (drops financials/rent-rolls/disclosures)', () => {
  it('drops obvious non-lease docs by filename', () => {
    expect(isLikelyNonLease('Sepich Portfolio/Leases/Financial Statements 2019/2019 Sepich I- P&L.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Rent Roll -- Dec 2020.pdf')).toBe(true);
    expect(isLikelyNonLease('Leases All properties/Leases/Current Rent Rolls 11.9.20.xlsb.pdf')).toBe(true);
    expect(isLikelyNonLease('Sepich Portfolio/Leases/2012 Zettler Agency Disclosure.pdf')).toBe(true);
  });
  it('keeps real leases and legitimate lease components', () => {
    expect(isLikelyNonLease('1100 Rarig/Leases/REDACTED-659 Lease.pdf')).toBe(false);
    expect(isLikelyNonLease('9050 Red Branch Rd/Leases/Exhibit Package -- Unit A REDACTED-699 Lease 01-2025.pdf')).toBe(false);
    expect(isLikelyNonLease('1900 North Broadway/Leases/Commencement Date Certificate -- Exhibit D Baltimore Dialysis Lease.pdf')).toBe(false);
  });
  it('matches via separator normalization (Windows backslash paths)', () => {
    expect(isLikelyNonLease('Sepich Portfolio\\Leases\\Rent Roll -- Dec 2020.pdf')).toBe(true);
  });
});

describe('env knobs — pathIncludeRe + maxFiles', () => {
  const prev = { inc: process.env.DOCUMENTS_PATH_INCLUDE, max: process.env.DOCUMENTS_MAX_FILES };
  afterEach(() => {
    process.env.DOCUMENTS_PATH_INCLUDE = prev.inc;
    process.env.DOCUMENTS_MAX_FILES = prev.max;
  });
  it('pathIncludeRe is null when unset and a regex when set', () => {
    delete process.env.DOCUMENTS_PATH_INCLUDE;
    expect(pathIncludeRe()).toBeNull();
    process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
    expect(pathIncludeRe()?.test('A/Leases/x.pdf')).toBe(true);
  });
  it('maxFiles defaults to 2000 and honors a valid override', () => {
    delete process.env.DOCUMENTS_MAX_FILES;
    expect(maxFiles()).toBe(2000);
    process.env.DOCUMENTS_MAX_FILES = '50';
    expect(maxFiles()).toBe(50);
    process.env.DOCUMENTS_MAX_FILES = 'nonsense';
    expect(maxFiles()).toBe(2000);
  });
});

describe('maxChunksPerDoc — per-document chunk cap', () => {
  const prev = process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
  afterEach(() => {
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = prev;
  });
  it('defaults to 25 and honors a valid override; ignores nonsense', () => {
    delete process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC;
    expect(maxChunksPerDoc()).toBe(25);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '8';
    expect(maxChunksPerDoc()).toBe(8);
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = 'nonsense';
    expect(maxChunksPerDoc()).toBe(25);
  });
});

describe('buildDocIndex — Leases-only include filter + exclusion pruning (temp corpus)', () => {
  const prev = { dir: process.env.DOCUMENTS_DIR, inc: process.env.DOCUMENTS_PATH_INCLUDE };
  afterEach(() => {
    process.env.DOCUMENTS_DIR = prev.dir;
    process.env.DOCUMENTS_PATH_INCLUDE = prev.inc;
  });
  it('indexes ONLY files under Leases folders, skipping other + excluded (estate) dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'docidx-'));
    try {
      mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
      mkdirSync(join(root, 'PropB', 'Other'), { recursive: true });
      mkdirSync(join(root, 'Estate Planning', 'Leases'), { recursive: true });
      writeFileSync(join(root, 'PropA', 'Leases', 'lease.txt'), 'Tenant has a right of first refusal to renew the premises.');
      writeFileSync(join(root, 'PropB', 'Other', 'note.txt'), 'miscellaneous non-lease document');
      writeFileSync(join(root, 'Estate Planning', 'Leases', 'trust.txt'), 'confidential estate document');

      process.env.DOCUMENTS_DIR = root;
      process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
      await buildDocIndex(fakeEmbedder);
      const s = await docStatus();

      expect(s.documents).toBe(1); // only PropA/Leases/lease.txt
      expect(s.docs[0]!.name.replace(/\\/g, '/')).toBe('PropA/Leases/lease.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectDocChunks — list+extract+chunk with per-doc cap', () => {
  const prev = { dir: process.env.DOCUMENTS_DIR, inc: process.env.DOCUMENTS_PATH_INCLUDE, cap: process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC };
  afterEach(() => {
    process.env.DOCUMENTS_DIR = prev.dir;
    process.env.DOCUMENTS_PATH_INCLUDE = prev.inc;
    process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = prev.cap;
  });
  it('caps chunks per document and skips non-lease + excluded files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-'));
    try {
      mkdirSync(join(root, 'PropA', 'Leases'), { recursive: true });
      // Long lease text → many chunks before the cap.
      const long = Array.from({ length: 80 }, (_, i) => `Section ${i}. ` + 'lorem ipsum dolor sit amet renew. '.repeat(4)).join('\n\n');
      writeFileSync(join(root, 'PropA', 'Leases', 'big-lease.txt'), long);
      writeFileSync(join(root, 'PropA', 'Leases', 'Rent Roll -- Dec 2020.txt'), 'rent roll table'); // non-lease → skipped

      process.env.DOCUMENTS_DIR = root;
      process.env.DOCUMENTS_PATH_INCLUDE = '(^|/)Leases(/)';
      process.env.DOCUMENTS_MAX_CHUNKS_PER_DOC = '3';

      const { chunks, docs } = await collectDocChunks();
      expect(docs.length).toBe(1); // rent roll skipped
      expect(docs[0]!.chunks).toBe(3); // capped
      expect(chunks.length).toBe(3);
      expect(chunks.every((c) => c.docName.replace(/\\/g, '/') === 'PropA/Leases/big-lease.txt')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('buildIndex on-disk — persist + reload + batched embedding (fake embedder)', () => {
  it('persists vectors + metadata to disk and reloads into a queryable index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diskidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const built = await buildIndex(CHUNKS, fakeEmbedder, { dbPath });
      built.close(); // close the writer before reopening

      const { index, docs, builtAt } = loadDiskIndex(dbPath);
      expect(index.chunks.length).toBe(3);
      expect(docs.length).toBe(3); // REDACTED-659, Roof, Rent
      expect(builtAt).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp persisted

      const hits = await queryIndex(index, 'renewal', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('REDACTED-659 Lease.pdf');
      expect(hits[0]!.docId).toBe('REDACTED-659');
      expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('embeds in batches (never one pass) and still ranks correctly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'batchidx-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const sizes: number[] = [];
      const spy: Embedder = async (texts) => {
        sizes.push(texts.length);
        return fakeEmbedder(texts);
      };
      let lastDone = 0;
      const built = await buildIndex(CHUNKS, spy, {
        dbPath,
        batchSize: 1,
        onProgress: (done, total) => {
          expect(total).toBe(3);
          lastDone = done;
        },
      });
      built.close();
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1); // no single-pass embed of all 3
      expect(lastDone).toBe(3); // progress reached the end

      const { index } = loadDiskIndex(dbPath);
      const hits = await queryIndex(index, 'roof', fakeEmbedder, 3);
      expect(hits[0]!.doc).toBe('Roof Warranty.pdf');
      index.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('docIndexPath defaults under data/ and honors DOC_INDEX_PATH', () => {
    const prev = process.env.DOC_INDEX_PATH;
    try {
      delete process.env.DOC_INDEX_PATH;
      expect(docIndexPath().replace(/\\/g, '/')).toMatch(/\/data\/doc-index\.sqlite$/);
      process.env.DOC_INDEX_PATH = '/tmp/custom-index.sqlite';
      expect(docIndexPath()).toBe('/tmp/custom-index.sqlite');
    } finally {
      process.env.DOC_INDEX_PATH = prev;
    }
  });
});

// NOTE: The real-model semantic proof (e.g. "ROFR" → "right of first refusal" with no shared
// keywords) is verified against the LIVE Brain Server endpoint (GET /api/documents/search), not
// here — transformers.js/onnxruntime hit a Float32Array realm mismatch under Vitest's test
// environment (the model runs fine in the real server's plain-Node process). Unit tests above cover
// the chunking, exclusion guard, and sqlite-vec plumbing with a deterministic fake embedder.
