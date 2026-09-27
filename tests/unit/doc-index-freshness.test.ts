// I-1 (2026-09-23 review): docIndexBuiltAt() must only report a real, disk-persisted build time.
// Before the fix, both the in-memory fallback (warmDocIndex with no on-disk index) and the
// empty-corpus build stamped `builtAt: new Date()`, so the Data Feeds row read "fresh" for an
// index that was never actually built. This file gets its own module registry (vitest.config.ts
// isolate: true, pool: forks) so the module-level `cache` starts null — resetDocCacheForTests()
// is still called before each case for defense-in-depth / order-independence within the file.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIndex,
  docIndexBuiltAt,
  resetDocCacheForTests,
  setDocIndexTransportForTests,
  warmDocIndex,
  type Embedder,
} from '../../server/sources/documents';
import { inProcessDocIndexTransport } from '../../server/sources/doc-index-client';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const fakeEmbedder: Embedder = async (texts) => texts.map(() => new Float32Array([1]));

describe('docIndexBuiltAt — only a disk-loaded index reports a build time (I-1)', () => {
  const prev = { dir: process.env.DOCUMENTS_DIR, path: process.env.DOC_INDEX_PATH };
  afterEach(() => {
    restoreEnv('DOCUMENTS_DIR', prev.dir);
    restoreEnv('DOC_INDEX_PATH', prev.path);
    resetDocCacheForTests();
    setDocIndexTransportForTests(null);
  });

  it('returns null when no index has been loaded or built', () => {
    resetDocCacheForTests();
    expect(docIndexBuiltAt()).toBeNull();
  });

  it('returns null for the in-memory fallback index (DOCUMENTS_DIR set, no on-disk index yet)', async () => {
    resetDocCacheForTests();
    const root = mkdtempSync(join(tmpdir(), 'docidx-fallback-'));
    try {
      process.env.DOCUMENTS_DIR = root;
      process.env.DOC_INDEX_PATH = join(root, 'doc-index.sqlite'); // deliberately never created
      await warmDocIndex(); // no on-disk index -> serves the in-memory placeholder
      expect(docIndexBuiltAt()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns the real build time once a disk-persisted index is loaded into cache', async () => {
    resetDocCacheForTests();
    setDocIndexTransportForTests(() => inProcessDocIndexTransport());
    const root = mkdtempSync(join(tmpdir(), 'docidx-disk-'));
    try {
      const dbPath = join(root, 'doc-index.sqlite');
      const built = await buildIndex([], fakeEmbedder, { dbPath });
      built.close(); // persist to disk, then close the writer before warmDocIndex reopens it

      process.env.DOC_INDEX_PATH = dbPath;
      delete process.env.DOCUMENTS_DIR;
      await warmDocIndex(); // on-disk index exists -> loads it via ensureIndex/loadDiskIndex

      const builtAt = docIndexBuiltAt();
      expect(builtAt).not.toBeNull();
      expect(builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      resetDocCacheForTests(); // closes the sqlite handle warmDocIndex opened, before cleanup
      rmSync(root, { recursive: true, force: true });
    }
  });
});
