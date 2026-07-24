// @vitest-environment node
//
// tests/unit/acq-notion-sync.test.ts
//
// Phase 4 Step 5 — syncNotionPipeline() unit tests.
// All tests use in-memory SQLite + a mock fetchImpl (never hits network).
// SPINE ISOLATION: after any sync, ledger_entries and import_batches stay at 0.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { syncNotionPipeline } from '../../server/warehouse/acq-notion-sync';
import type { FetchLike } from '../../server/warehouse/acq-notion-sync';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-notion-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Build a minimal Notion page object with realistic property structure. */
function makePage(overrides: {
  id?: string;
  address?: string;
  county?: string;
  state?: string;
  market?: string;
  sf?: number;
  yearBuilt?: number;
  owner?: string;
  status?: string;
} = {}): object {
  return {
    id: overrides.id ?? 'page-id-0001',
    properties: {
      Name: {
        type: 'title',
        title: overrides.address !== undefined
          ? [{ plain_text: overrides.address }]
          : [],
      },
      County: {
        type: 'rich_text',
        rich_text: overrides.county !== undefined
          ? [{ plain_text: overrides.county }]
          : [],
      },
      State: {
        type: 'select',
        select: overrides.state !== undefined ? { name: overrides.state } : null,
      },
      Market: {
        type: 'select',
        select: overrides.market !== undefined ? { name: overrides.market } : null,
      },
      'Rentable SF': {
        type: 'number',
        number: overrides.sf !== undefined ? overrides.sf : null,
      },
      'Year Built': {
        type: 'number',
        number: overrides.yearBuilt !== undefined ? overrides.yearBuilt : null,
      },
      Owner: {
        type: 'rich_text',
        rich_text: overrides.owner !== undefined
          ? [{ plain_text: overrides.owner }]
          : [],
      },
      Status: {
        type: 'select',
        select: overrides.status !== undefined ? { name: overrides.status } : null,
      },
    },
  };
}

/** Build a mock fetchImpl that returns the given pages (single page, no pagination). */
function mockFetch(pages: object[]): FetchLike {
  return async (_url, _init) => {
    const body = JSON.stringify({ results: pages, has_more: false, next_cursor: null });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** Build a mock fetchImpl that returns pages across two API calls (pagination). */
function mockFetchPaginated(page1: object[], page2: object[], cursorValue = 'cursor-abc'): FetchLike {
  let called = 0;
  return async (_url, init) => {
    called++;
    const body_obj = init?.body ? JSON.parse(init.body as string) as { start_cursor?: string } : {};
    if (called === 1 || !body_obj.start_cursor) {
      return new Response(
        JSON.stringify({ results: page1, has_more: true, next_cursor: cursorValue }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ results: page2, has_more: false, next_cursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

describe('syncNotionPipeline — insert path', () => {
  it('inserts all pages across two Notion API calls (pagination)', async () => {
    const db = freshDb();
    const page1 = [
      makePage({ id: 'p-001', address: '100 Main St' }),
      makePage({ id: 'p-002', address: '200 Oak Ave' }),
    ];
    const page2 = [
      makePage({ id: 'p-003', address: '300 Elm Rd' }),
    ];
    const result = await syncNotionPipeline(db, 'tok', {
      databaseId: 'test-db-id',
      fetchImpl: mockFetchPaginated(page1, page2),
    });

    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it('candidate ids are deal:<notionPageId>', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'test-db-id',
      fetchImpl: mockFetch([makePage({ id: 'abc-123' })]),
    });
    const row = db.prepare('SELECT id, source FROM acq_candidates WHERE notion_deal_id = ?')
      .get('abc-123') as { id: string; source: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe('deal:abc-123');
    expect(row!.source).toBe('notion-pipeline');
  });
});

describe('syncNotionPipeline — upsert idempotency', () => {
  it('second sync: inserted:0, updated:N; row count unchanged', async () => {
    const db = freshDb();
    const pages = [
      makePage({ id: 'p-001' }),
      makePage({ id: 'p-002' }),
    ];
    const fetch1 = mockFetch(pages);
    const fetch2 = mockFetch(pages);

    const r1 = await syncNotionPipeline(db, 'tok', { databaseId: 'db', fetchImpl: fetch1 });
    expect(r1.inserted).toBe(2);
    expect(r1.updated).toBe(0);

    const r2 = await syncNotionPipeline(db, 'tok', { databaseId: 'db', fetchImpl: fetch2 });
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(2);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe('syncNotionPipeline — field mapping', () => {
  it('maps Name/County/State/Market/SF/YearBuilt/Owner correctly', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([
        makePage({
          id: 'map-test',
          address: '123 Main St',
          county: 'Franklin',
          state: 'OH',
          market: 'established',
          sf: 42000,
          yearBuilt: 1998,
          owner: 'Smith LLC',
        }),
      ]),
    });
    const row = db.prepare(
      'SELECT address, county, state, market, rentable_sf, year_built, owner_name FROM acq_candidates WHERE id = ?',
    ).get('deal:map-test') as {
      address: string;
      county: string;
      state: string;
      market: string;
      rentable_sf: number;
      year_built: number;
      owner_name: string;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.address).toBe('123 Main St');
    expect(row!.county).toBe('Franklin');
    expect(row!.state).toBe('OH');
    expect(row!.market).toBe('established');
    expect(row!.rentable_sf).toBe(42000);
    expect(row!.year_built).toBe(1998);
    expect(row!.owner_name).toBe('Smith LLC');
  });

  it('unknown market maps to null', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'mkt-null', market: 'Mars' })]),
    });
    const row = db.prepare('SELECT market FROM acq_candidates WHERE id = ?').get('deal:mkt-null') as
      { market: string | null } | undefined;
    expect(row?.market).toBeNull();
  });
});

describe('syncNotionPipeline — status no-clobber', () => {
  it('does not downgrade a locally-acquired candidate back to active on sync', async () => {
    const db = freshDb();
    // First sync: insert as active
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'clobber-test', status: 'Active' })]),
    });
    // Manually advance status to 'acquired'
    db.prepare("UPDATE acq_candidates SET status = 'acquired' WHERE id = 'deal:clobber-test'").run();

    // Second sync: Notion still says Active — must NOT downgrade
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'clobber-test', status: 'Active' })]),
    });

    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?').get('deal:clobber-test') as
      { status: string } | undefined;
    expect(row?.status).toBe('acquired');
  });

  // 2026-07-24 (integrity sweep M1/L1, twin-writer gap closed on refute-review): this UPDATE
  // used to lock only acquired/passed. An archived candidate was silently reactivated by the
  // very next Notion resync — the exact defect class this describe block exists to guard, just
  // missing one status. Mirrors the equivalent test in acq-hubspot-sync.test.ts.
  it('does not resurrect a human-archived candidate back to active on sync', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'archive-test', status: 'Active' })]),
    });
    db.prepare("UPDATE acq_candidates SET status = 'archived', updated_at = '2026-07-10 09:00:00' WHERE id = 'deal:archive-test'").run();

    // Notion still says Active — must NOT reactivate, and updated_at must NOT move (nothing
    // persisted actually changed: status stays locked, address/etc are unchanged).
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'archive-test', status: 'Active' })]),
    });

    const row = db.prepare('SELECT status, updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:archive-test') as { status: string; updated_at: string };
    expect(row.status).toBe('archived');
    expect(row.updated_at).toBe('2026-07-10 09:00:00');
  });

  // 2026-07-24 (M1): the old UPDATE bumped updated_at UNCONDITIONALLY on every resync — worse
  // than the pre-fix HubSpot gate. A resync with no real Notion-side change must not touch it.
  it('a no-op resync (nothing changed) does not bump updated_at', async () => {
    const db = freshDb();
    const page = makePage({ id: 'noop-test', address: '123 Main St', status: 'Active' });
    await syncNotionPipeline(db, 'tok', { databaseId: 'db', fetchImpl: mockFetch([page]) });
    db.prepare("UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00' WHERE id = 'deal:noop-test'").run();

    await syncNotionPipeline(db, 'tok', { databaseId: 'db', fetchImpl: mockFetch([page]) });

    const row = db.prepare('SELECT updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:noop-test') as { updated_at: string };
    expect(row.updated_at).toBe('2000-01-01 00:00:00');
  });

  it('does bump updated_at when a Notion-side field genuinely changed', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'real-change', address: '123 Main St', status: 'Active' })]),
    });
    db.prepare("UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00' WHERE id = 'deal:real-change'").run();

    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'real-change', address: '456 Oak Ave', status: 'Active' })]),
    });

    const row = db.prepare('SELECT address, updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:real-change') as { address: string; updated_at: string };
    expect(row.address).toBe('456 Oak Ave');
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });
});

describe('syncNotionPipeline — error isolation', () => {
  it('per-page error goes to errors[] while good pages still insert', async () => {
    const db = freshDb();
    const goodPage = makePage({ id: 'good-page' });
    // A page whose properties will cause an extraction error when we call db.prepare with bad data
    // Simplest: inject a page that triggers a db write error by passing an id that would cause issues.
    // Instead, test via a malformed page that has no properties.
    const badPage = { id: 'bad-page', properties: null }; // null properties causes an extraction throw

    const result = await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([goodPage, badPage]),
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/bad-page/);
    // Good page was still inserted
    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('syncNotionPipeline — Notion API failure', () => {
  it('throws when Notion returns non-2xx on the first page', async () => {
    const db = freshDb();
    const failFetch: FetchLike = async () =>
      new Response('Unauthorized', { status: 401 });

    await expect(
      syncNotionPipeline(db, 'tok', { databaseId: 'db', fetchImpl: failFetch }),
    ).rejects.toThrow('401');
  });
});

describe('syncNotionPipeline — spine isolation', () => {
  it('CRITICAL: ledger_entries count is 0 after notion sync (Spine B untouched)', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'sp-01' }), makePage({ id: 'sp-02' })]),
    });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('import_batches count is 0 after notion sync (Spine B untouched)', async () => {
    const db = freshDb();
    await syncNotionPipeline(db, 'tok', {
      databaseId: 'db',
      fetchImpl: mockFetch([makePage({ id: 'sp-03' })]),
    });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
