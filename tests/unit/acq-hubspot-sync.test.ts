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
      fetchImpl: mockFetch([makeDeal({ id: 'abc-123', dealname: '200 Example Pkwy' })]),
    });
    const row = db.prepare('SELECT id, source, address FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:abc-123') as { id: string; source: string; address: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe('deal:hubspot:abc-123');
    expect(row!.source).toBe('hubspot-pipeline');
    expect(row!.address).toBe('200 Example Pkwy');
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

describe('syncHubSpotPipeline — content_hash gates updated_at', () => {
  it('does not bump updated_at on a resync when nothing actually changed', async () => {
    const db = freshDb();
    const deal = makeDeal({ id: 'gate-1', dealname: 'Unchanged Deal', dealstage: '1331037317' });

    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });
    db.prepare("UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00' WHERE id = 'deal:hubspot:gate-1'").run();

    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    const row = db.prepare('SELECT updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:gate-1') as { updated_at: string };
    expect(row.updated_at).toBe('2000-01-01 00:00:00');
  });

  it('does bump updated_at when the synced data actually changed', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'gate-2', dealname: 'Old Name', dealstage: '1331037317' })]),
    });
    db.prepare("UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00' WHERE id = 'deal:hubspot:gate-2'").run();

    // HubSpot-side dealname change → address changes → content_hash mismatch → real bump.
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'gate-2', dealname: 'New Name', dealstage: '1331037317' })]),
    });

    const row = db.prepare('SELECT updated_at, address FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:gate-2') as { updated_at: string; address: string };
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
    expect(row.address).toBe('New Name');
  });

  // CONTRACT CHANGE 2026-07-24 (M1). This case previously asserted that a legacy row with a
  // NULL content_hash BUMPS updated_at on the next resync — an artifact of gating on the stored
  // hash, which made the migration itself look like an edit to every row. updated_at is now
  // gated on whether a PERSISTED column actually changed, so backfilling the hash is correctly
  // invisible: nothing about the row changed, so its edit timestamp must not move. Strictly
  // better — it removes a one-time mass phantom-bump that migration 025 would otherwise cause.
  it('backfilling a NULL content_hash is NOT an edit — updated_at stays put', async () => {
    const db = freshDb();
    const deal = makeDeal({ id: 'gate-3', dealname: 'Legacy Deal', dealstage: '1331037317' });
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });
    db.prepare(
      "UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00', content_hash = NULL WHERE id = 'deal:hubspot:gate-3'",
    ).run();

    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    const row = db.prepare('SELECT updated_at, content_hash FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:gate-3') as { updated_at: string; content_hash: string | null };
    expect(row.updated_at).toBe('2000-01-01 00:00:00');
    // …but the fingerprint is still backfilled for audit/debug use.
    expect(row.content_hash).not.toBeNull();
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

  it('missing dealstage (null) defaults to active', async () => {
    const db = freshDb();
    await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'unknown-1', dealname: 'No Stage' })]),
    });
    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:unknown-1') as { status: string } | undefined;
    expect(row?.status).toBe('active');
  });

  // Adversarial review (2026-07-10): the test above only exercised the null-dealstage branch,
  // never the true "unrecognized non-null code" fallback -- a distinct code path (mapDealStage's
  // `HUBSPOT_STAGE_STATUS[stage] ?? 'active'`) that a green suite previously gave false confidence
  // was covered. HubSpot pipelines are user-editable; a newly-added terminal stage would silently
  // default to 'active' with zero observability. Fixed to surface the gap in result.errors[].
  it('unrecognized non-null dealstage code defaults to active AND is surfaced in errors[]', async () => {
    const db = freshDb();
    const result = await syncHubSpotPipeline(db, 'tok', {
      fetchImpl: mockFetch([makeDeal({ id: 'future-1', dealname: 'New Stage Deal', dealstage: '9999999999' })]),
    });
    const row = db.prepare('SELECT status FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:future-1') as { status: string } | undefined;
    expect(row?.status).toBe('active');
    expect(result.errors.some((e) => e.includes('future-1') && e.includes('9999999999'))).toBe(true);
  });
});

describe('syncHubSpotPipeline — cross-page duplicate deal (order-independence)', () => {
  // Adversarial review (2026-07-10): without a stable sort + dedup, HubSpot's offset-based
  // pagination could return the same deal on two pages, and the old code processed it twice --
  // INSERT then UPDATE -- resolving status (absorbing CASE, first-terminal-write-wins) and address
  // (unconditional overwrite, last-write-wins) from DIFFERENT occurrences of the SAME duplicated
  // deal. That made the persisted output depend on drain/page order for the identical input set.
  // Fixed via Map-dedup (last occurrence wins) before the upsert loop.
  it('a deal id returned twice across pages resolves consistently regardless of order (dedup, not order-dependent)', async () => {
    const db1 = freshDb();
    const wonThenLost = mockFetchPaginated(
      [makeDeal({ id: 'dup-1', dealname: 'A', dealstage: '1331037322' })],  // page 1: Closed Won
      [makeDeal({ id: 'dup-1', dealname: 'B', dealstage: '1331037323' })],  // page 2 (same id): Closed Lost
    );
    const r1 = await syncHubSpotPipeline(db1, 'tok', { fetchImpl: wonThenLost });
    const row1 = db1.prepare('SELECT status, address FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:dup-1') as { status: string; address: string } | undefined;

    const db2 = freshDb();
    const lostThenWon = mockFetchPaginated(
      [makeDeal({ id: 'dup-1', dealname: 'B', dealstage: '1331037323' })],  // page 1: Closed Lost
      [makeDeal({ id: 'dup-1', dealname: 'A', dealstage: '1331037322' })],  // page 2 (same id): Closed Won
    );
    const r2 = await syncHubSpotPipeline(db2, 'tok', { fetchImpl: lostThenWon });
    const row2 = db2.prepare('SELECT status, address FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:dup-1') as { status: string; address: string } | undefined;

    // The bug being fixed was NOT "order must not matter" (dedup is legitimately last-occurrence-
    // wins, which does depend on drain order -- HubSpot's own concurrent-edit semantics make that
    // unavoidable) -- it was that status and address could resolve from TWO DIFFERENT occurrences
    // of the same duplicated deal (status via the absorbing UPDATE...CASE, address via an
    // unconditional overwrite), producing an incoherent, mismatched pair. Map-dedup fixes that by
    // ensuring status and address always come from the SAME (last) occurrence -- a coherent pair
    // -- in EVERY permutation, and each distinct deal is counted exactly once.
    expect(row1?.status).toBe('passed'); // db1's last occurrence is the Closed-Lost(B) row
    expect(row1?.address).toBe('B');     // address matches the SAME occurrence status came from
    expect(row2?.status).toBe('acquired'); // db2's last occurrence is the Closed-Won(A) row
    expect(row2?.address).toBe('A');       // address matches the SAME occurrence status came from
    expect(r1.inserted + r1.updated).toBe(1); // exactly one distinct deal, never double-counted
    expect(r2.inserted + r2.updated).toBe(1);
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
    // Raw exception text (JS internals / SQLite table names) must not reach the 200 response body.
    expect(result.errors[0]).toMatch(/could not be processed/);
    expect(result.errors[0]).not.toMatch(/TypeError|Cannot read|Cannot convert/);
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

// ── M1/L1: the updated_at gate must reflect PERSISTED state ──────────────────────────────
//
// 2026-07-24 integrity sweep. The original gate compared the STORED content_hash against the
// INCOMING hash — a fingerprint of the last sync's input, not of the row as it actually stands.
// acq_candidates has a real third writer (PATCH /acq/candidates/:id/status, api.ts), which
// changes status without touching content_hash. So "hash unchanged" did NOT imply "this UPDATE
// writes nothing": the sync could revert a human's edit while FREEZING updated_at at the
// human's timestamp — destroying the only audit trace and misattributing the row. The gate now
// compares the row's actual persisted values against the values the UPDATE will resolve to.

describe('syncHubSpotPipeline — updated_at gate reflects persisted state (M1)', () => {
  /** Simulate the PATCH /acq/candidates/:id/status endpoint: status + updated_at, no hash. */
  function patchStatus(db: WarehouseDb, id: string, status: string, at: string): void {
    db.prepare('UPDATE acq_candidates SET status = ?, updated_at = ? WHERE id = ?').run(status, at, id);
  }

  it('a human-archived candidate is not resurrected to active by the next resync', async () => {
    const db = freshDb();
    const deal = makeDeal({ id: 'm1-1', dealname: '123 Main St', dealstage: '1331037317' });
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    patchStatus(db, 'deal:hubspot:m1-1', 'archived', '2026-07-10 09:00:00');
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    const row = db.prepare('SELECT status, updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:m1-1') as { status: string; updated_at: string };
    // The human decision stands — a sync is not authoritative over a local lifecycle call.
    expect(row.status).toBe('archived');
    // Nothing persisted changed, so the timestamp legitimately stays put.
    expect(row.updated_at).toBe('2026-07-10 09:00:00');
  });

  it('when a resync genuinely rewrites a drifted column, updated_at bumps (no frozen timestamp)', async () => {
    const db = freshDb();
    const deal = makeDeal({ id: 'm1-2', dealname: '456 Oak Ave', dealstage: '1331037317' });
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    // Out-of-band edit that leaves content_hash stale relative to the real columns.
    db.prepare("UPDATE acq_candidates SET address = 'MANUALLY CORRECTED', updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run('deal:hubspot:m1-2');

    // Resync with UNCHANGED HubSpot data: the stored hash still matches the incoming hash, so
    // the old gate kept updated_at — even though this UPDATE reverts `address` back to canon.
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([deal]) });

    const row = db.prepare('SELECT address, updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:m1-2') as { address: string; updated_at: string };
    expect(row.address).toBe('456 Oak Ave');
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('L1: a status-locked row whose HubSpot stage merely shifts does not phantom-bump updated_at', async () => {
    const db = freshDb();
    // Closed Lost → persisted status 'passed' (a locked terminal state).
    const lost = makeDeal({ id: 'm1-3', dealname: '789 Pine Rd', dealstage: '1331037323' });
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([lost]) });
    db.prepare("UPDATE acq_candidates SET updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run('deal:hubspot:m1-3');

    // HubSpot stage moves between two NON-terminal stages. status stays locked at 'passed' and
    // address is unchanged, so NOTHING persisted changes — the timestamp must not move.
    const reopened = makeDeal({ id: 'm1-3', dealname: '789 Pine Rd', dealstage: '1331037319' });
    await syncHubSpotPipeline(db, 'tok', { fetchImpl: mockFetch([reopened]) });

    const row = db.prepare('SELECT status, updated_at FROM acq_candidates WHERE id = ?')
      .get('deal:hubspot:m1-3') as { status: string; updated_at: string };
    expect(row.status).toBe('passed');
    expect(row.updated_at).toBe('2000-01-01 00:00:00');
  });
});
