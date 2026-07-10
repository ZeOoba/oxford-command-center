// @vitest-environment node
//
// tests/unit/acq-hubspot-sync.test.ts
//
// Phase 4 — syncHubSpotPipeline() unit tests.
// All tests use in-memory SQLite + a mock fetchImpl (never hits network).
// SPINE ISOLATION: after any sync, ledger_entries and import_batches stay at 0.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { syncHubSpotPipeline } from '../../server/warehouse/acq-hubspot-sync';
import type { FetchLike } from '../../server/warehouse/acq-hubspot-sync';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-hubspot-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Build a minimal HubSpot deal object with realistic property structure. */
function makeDeal(overrides: {
  id?: string;
  dealname?: string;
  dealstage?: string;
} = {}): object {
  return {
    id: overrides.id ?? 'deal-0001',
    properties: {
      dealname: overrides.dealname ?? null,
      dealstage: overrides.dealstage ?? null,
      pipeline: '885606973',
      createdate: null,
      hs_lastmodifieddate: null,
    },
  };
}

/** Build a mock fetchImpl that returns the given deals (single page, no pagination). */
function mockFetch(deals: object[]): FetchLike {
  return async (_url, _init) => {
    const body = JSON.stringify({ results: deals });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** Build a mock fetchImpl that returns deals across two API calls (pagination). */
function mockFetchPaginated(page1: object[], page2: object[], afterValue = 'after-abc'): FetchLike {
  let called = 0;
  return async (_url, init) => {
    called++;
    const bodyObj = init?.body ? JSON.parse(init.body as string) as { after?: string } : {};
    if (called === 1 || !bodyObj.after) {
      return new Response(
        JSON.stringify({ results: page1, paging: { next: { after: afterValue } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ results: page2 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

describe('syncHubSpotPipeline — insert path', () => {
  it('inserts all deals across two HubSpot API calls (pagination)', async () => {
    const db = freshDb();
    const page1 = [
      makeDeal({ id: 'd-001', dealname: '100 Main St' }),
      makeDeal({ id: 'd-002', dealname: '200 Oak Ave' }),
    ];
    const page2 = [
      makeDeal({ id: 'd-003', dealname: '300 Elm Rd' }),
    ];
    const result = await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetchPaginated(page1, page2),
    });

    expect(result.inserted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it('candidate ids are deal:hubspot:<dealId>, namespaced apart from Notion ids', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'abc-123', dealname: '6150 Avery Road' })]),
    });
    const row = db.prepare('SELECT id, source, address FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:abc-123') as { id: string; source: string; address: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe('deal:hubspot:abc-123');
    expect(row!.source).toBe('hubspot-pipeline');
    expect(row!.address).toBe('6150 Avery Road');
  });
});

describe('syncHubSpotPipeline — upsert idempotency', () => {
  it('second sync: inserted:0, updated:N; row count unchanged', async () => {
    const db = freshDb();
    const deals = [
      makeDeal({ id: 'd-001', dealname: 'A' }),
      makeDeal({ id: 'd-002', dealname: 'B' }),
    ];
    const fetch1 = mockFetch(deals);
    const fetch2 = mockFetch(deals);

    const r1 = await syncHubSpotPipeline(db, 'tok', { fetchImpl: fetch1 });
    expect(r1.inserted).toBe(2);
    expect(r1.updated).toBe(0);

    const r2 = await syncHubSpotPipeline(db, 'tok', { fetchImpl: fetch2 });
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(2);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe('syncHubSpotPipeline — dealstage → status mapping', () => {
  it('maps every in-flight stage (Sourced/Screened/LOI/Under Contract/DD/Closing) to active', async () => {
    const db = freshDb();
    const stages = ['1331037317', '1331037318', '1331037319', '1331037321', '1331037320', '1331048767'];
    const deals = stages.map((stage, i) => makeDeal({ id: `stage-${i}`, dealname: `Deal ${i}`, dealstage: stage }));
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch(deals) });

    for (let i = 0; i < stages.length; i++) {
      const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
        .get(`deal:hubspot:stage-${i}`) as { status: string } | undefined;
      expect(row?.status).toBe('active');
    }
  });

  it('maps Closed Won (1331037322) to acquired', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'won-1', dealname: 'Closed Deal', dealstage: '1331037322' })]),
    });
    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:won-1') as { status: string } | undefined;
    expect(row?.status).toBe('acquired');
  });

  it('maps Closed Lost (1331037323) to passed', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'lost-1', dealname: 'Dead Deal', dealstage: '1331037323' })]),
    });
    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:lost-1') as { status: string } | undefined;
    expect(row?.status).toBe('passed');
  });

  it('missing/unknown dealstage defaults to active', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'unknown-1', dealname: 'No Stage' })]),
    });
    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:unknown-1') as { status: string } | undefined;
    expect(row?.status).toBe('active');
  });
});

describe('syncHubSpotPipeline — test/preflight name-skip filter', () => {
  it('skips deals whose name starts with "_Preflight"', async () => {
    const db = freshDb();
    const result = await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([
        makeDeal({ id: 'pf-1', dealname: '_Preflight_H3_Test_Deal_20260416' }),
        makeDeal({ id: 'real-1', dealname: 'Real Deal' }),
      ]),
    });
    expect(result.inserted).toBe(1);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(1);
    const skipped = db.prepare('SELECT id FROM acq_candidates WHERE id = ?').get('deal:hubspot:pf-1');
    expect(skipped).toBeUndefined();
  });

  it('skips deals whose name starts with "_Test"', async () => {
    const db = freshDb();
    const result = await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'test-1', dealname: '_Test_Deal' })]),
    });
    expect(result.inserted).toBe(0);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe('syncHubSpotPipeline — status no-clobber', () => {
  it('does not downgrade a locally-acquired candidate back to active on re-sync', async () => {
    const db = freshDb();
    // First sync: insert as active (Sourced)
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'clobber-test', dealname: 'X', dealstage: '1331037317' })]),
    });
    // Manually advance status to 'acquired'
    db.prepare("UPDATE acq_candidates SET status = 'acquired' WHERE id = 'deal:hubspot:clobber-test'").run();

    // Second sync: HubSpot still says Sourced (active) — must NOT downgrade
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'clobber-test', dealname: 'X', dealstage: '1331037317' })]),
    });

    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:clobber-test') as { status: string } | undefined;
    expect(row?.status).toBe('acquired');
  });

  it('does not resurrect a locally-passed candidate back to active on re-sync', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'passed-test', dealname: 'Y', dealstage: '1331037318' })]),
    });
    db.prepare("UPDATE acq_candidates SET status = 'passed' WHERE id = 'deal:hubspot:passed-test'").run();

    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'passed-test', dealname: 'Y', dealstage: '1331037318' })]),
    });

    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:passed-test') as { status: string } | undefined;
    expect(row?.status).toBe('passed');
  });
});

describe('syncHubSpotPipeline — error isolation', () => {
  it('per-deal error goes to errors[] while good deals still insert', async () => {
    const db = freshDb();
    const goodDeal = makeDeal({ id: 'good-deal', dealname: 'Good Deal' });
    // A deal with null properties triggers an extraction throw (mirrors the Notion sync test).
    const badDeal = { id: 'bad-deal', properties: null };

    const result = await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([goodDeal, badDeal]),
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/bad-deal/);
    // Good deal was still inserted
    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('syncHubSpotPipeline — HubSpot API failure', () => {
  it('throws when HubSpot returns non-2xx on the first page', async () => {
    const db = freshDb();
    const failFetch: FetchLike = async () =>
      new Response('Unauthorized', { status: 401 });

    await expect(
      syncHubSpotPipeline(db, 'tok', { fetchImpl: failFetch }),
    ).rejects.toThrow('401');
  });
});

describe('syncHubSpotPipeline — cross-system id namespace', () => {
  it('a HubSpot deal and a Notion page can coexist without colliding on id', async () => {
    const db = freshDb();
    // Simulate a Notion-sourced row already present (as syncNotionPipeline would leave it).
    db.prepare(`
      INSERT INTO acq_candidates (id, source, address, status, notion_deal_id)
      VALUES ('deal:same-id', 'notion-pipeline', 'Notion Address', 'active', 'same-id')
    `).run();

    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'same-id', dealname: 'HubSpot Address' })]),
    });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM acq_candidates').get() as { n: number }).n;
    expect(count).toBe(2);
    const notionRow = db.prepare('SELECT address FROM acq_candidates WHERE id = ?').get('deal:same-id') as { address: string };
    const hubspotRow = db.prepare('SELECT address FROM acq_candidates WHERE id = ?').get('deal:hubspot:same-id') as { address: string };
    expect(notionRow.address).toBe('Notion Address');
    expect(hubspotRow.address).toBe('HubSpot Address');
  });
});

describe('syncHubSpotPipeline — spine isolation', () => {
  it('CRITICAL: ledger_entries count is 0 after hubspot sync (Spine B untouched)', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'sp-01' }), makeDeal({ id: 'sp-02' })]),
    });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('import_batches count is 0 after hubspot sync (Spine B untouched)', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'sp-03' })]),
    });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM import_batches').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
