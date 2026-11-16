// @vitest-environment node
//
// tests/unit/notion-writeback.test.ts
//
// Direction 1 — syncCapitalActionsToNotion() unit tests.
// All tests use a mock fetchImpl (never hits network).
//
// Contract under test:
//   - property match (by title, case/whitespace-insensitive) → PATCH page, counted synced
//   - no Notion page match → counted skipped (NOT an error, never throws)
//   - per-page Notion API error → counted in errors[], never throws; other pages still sync
//   - ensures "Capital Action" + "Priority Score" properties exist (PATCH database) before writing
//   - result validates against the NotionSyncResult contract
import { describe, expect, it, vi } from 'vitest';
import {
  syncCapitalActionsToNotion,
  buildCapitalWritebackEntries,
  type CapitalActionInput,
  type FetchLike,
} from '../../server/notion/capital-writeback';
import type { AllocationVerdict, PortfolioAllocation } from '../../src/contracts/capital';
import type { CapitalAllocationEntry } from '../../src/contracts/capital-allocation';
import { NotionSyncResult } from '../../src/contracts/notion-writeback';

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(overrides: Partial<CapitalActionInput> = {}): CapitalActionInput {
  return {
    propertyName: overrides.propertyName ?? '123 Main St',
    allocationAction: overrides.allocationAction === undefined ? 'improve' : overrides.allocationAction,
    priorityScore: overrides.priorityScore ?? 72,
  };
}

/** A Notion page stub with a title property named "Property Name". */
function notionPage(id: string, title: string): object {
  return {
    id,
    properties: {
      'Property Name': { type: 'title', title: [{ plain_text: title }] },
    },
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Build a mock Notion API fetchImpl.
 *  - PATCH /databases/{id}      → 200 (ensure-properties step)
 *  - POST  /databases/{id}/query→ 200 with the supplied pages (single page, no pagination)
 *  - PATCH /pages/{id}          → 200 (page update) unless the page id is in failPageIds
 */
function mockNotion(
  pages: object[],
  opts: { failPageIds?: Set<string>; calls?: RecordedCall[] } = {},
): FetchLike {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    opts.calls?.push({ url, method, body });

    // Ensure-properties: PATCH the database
    if (method === 'PATCH' && /\/databases\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ id: 'db' }), { status: 200 });
    }
    // Query pages
    if (method === 'POST' && /\/databases\/[^/]+\/query$/.test(url)) {
      return new Response(
        JSON.stringify({ results: pages, has_more: false, next_cursor: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Page update
    if (method === 'PATCH' && /\/pages\/([^/]+)$/.test(url)) {
      const pageId = url.match(/\/pages\/([^/]+)$/)![1]!;
      if (opts.failPageIds?.has(pageId)) {
        return new Response('Conflict', { status: 409 });
      }
      return new Response(JSON.stringify({ id: pageId }), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  };
}

const DB = 'test-property-db';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('syncCapitalActionsToNotion — match + write', () => {
  it('matches an entry to a Notion page by title and writes both properties (synced)', async () => {
    const calls: RecordedCall[] = [];
    const pages = [notionPage('page-1', '123 Main St')];
    const result = await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: mockNotion(pages, { calls }),
    });

    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // The page PATCH carried both Capital Action (select) and Priority Score (number).
    const pagePatch = calls.find((c) => c.method === 'PATCH' && /\/pages\//.test(c.url));
    expect(pagePatch).toBeDefined();
    const props = (pagePatch!.body as { properties: Record<string, unknown> }).properties;
    expect(props['Capital Action']).toEqual({ select: { name: 'improve' } });
    expect(props['Priority Score']).toEqual({ number: 72 });
  });

  it('ensures the Capital Action + Priority Score properties exist before writing (PATCH database)', async () => {
    const calls: RecordedCall[] = [];
    await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: mockNotion([notionPage('page-1', '123 Main St')], { calls }),
    });
    const dbPatch = calls.find((c) => c.method === 'PATCH' && /\/databases\/[^/]+$/.test(c.url));
    expect(dbPatch).toBeDefined();
    const props = (dbPatch!.body as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('Capital Action');
    expect(props).toHaveProperty('Priority Score');
  });

  it('matches case-insensitively and ignoring surrounding whitespace', async () => {
    const pages = [notionPage('page-1', '  123 MAIN st ')];
    const result = await syncCapitalActionsToNotion(
      [entry({ propertyName: '123 Main St' })],
      'tok',
      { databaseId: DB, asOf: '2026-06-22', fetchImpl: mockNotion(pages) },
    );
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe('syncCapitalActionsToNotion — no-match path', () => {
  it('counts an entry with no matching Notion page as skipped (not an error)', async () => {
    const pages = [notionPage('page-1', 'Some Other Property')];
    const result = await syncCapitalActionsToNotion(
      [entry({ propertyName: '999 Nowhere Rd' })],
      'tok',
      { databaseId: DB, asOf: '2026-06-22', fetchImpl: mockNotion(pages) },
    );
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('skips an entry whose propertyName is null', async () => {
    const pages = [notionPage('page-1', '123 Main St')];
    const result = await syncCapitalActionsToNotion(
      [{ propertyName: null, allocationAction: 'hold', priorityScore: 10 }],
      'tok',
      { databaseId: DB, asOf: '2026-06-22', fetchImpl: mockNotion(pages) },
    );
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});

describe('syncCapitalActionsToNotion — error isolation (fail-open)', () => {
  it('a per-page write failure goes to errors[] and never throws; other pages still sync', async () => {
    const pages = [
      notionPage('page-good', 'Good Property'),
      notionPage('page-bad', 'Bad Property'),
    ];
    const result = await syncCapitalActionsToNotion(
      [
        entry({ propertyName: 'Good Property' }),
        entry({ propertyName: 'Bad Property' }),
      ],
      'tok',
      {
        databaseId: DB,
        asOf: '2026-06-22',
        fetchImpl: mockNotion(pages, { failPageIds: new Set(['page-bad']) }),
      },
    );
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/Bad Property|page-bad/);
  });

  it('a query-stage Notion API failure returns errors, never throws', async () => {
    const failQuery: FetchLike = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH' && /\/databases\/[^/]+$/.test(url)) {
        return new Response('{}', { status: 200 });
      }
      return new Response('Server Error', { status: 500 });
    };
    const result = await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: failQuery,
    });
    expect(result.synced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('never rejects even if fetch itself throws', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: throwingFetch,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.synced).toBe(0);
  });
});

describe('syncCapitalActionsToNotion — pagination', () => {
  it('drains multiple Notion query pages to find a match on a later page', async () => {
    const page2 = [notionPage('page-2', 'Second Page Property')];
    let called = 0;
    const paginated: FetchLike = async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH' && /\/databases\/[^/]+$/.test(url)) return new Response('{}', { status: 200 });
      if (method === 'POST' && /\/query$/.test(url)) {
        called++;
        if (called === 1) {
          return new Response(
            JSON.stringify({ results: [notionPage('page-1', 'First')], has_more: true, next_cursor: 'c1' }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ results: page2, has_more: false, next_cursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
    };
    const result = await syncCapitalActionsToNotion(
      [entry({ propertyName: 'Second Page Property' })],
      'tok',
      { databaseId: DB, asOf: '2026-06-22', fetchImpl: paginated },
    );
    expect(result.synced).toBe(1);
    expect(called).toBe(2);
  });
});

describe('syncCapitalActionsToNotion — contract + guards', () => {
  it('result validates against NotionSyncResult and echoes asOf', async () => {
    const result = await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: mockNotion([notionPage('page-1', '123 Main St')]),
    });
    expect(() => NotionSyncResult.parse(result)).not.toThrow();
    expect(result.asOf).toBe('2026-06-22');
  });

  it('throws only when the token is missing (a configuration error, surfaced by the route as 400)', async () => {
    await expect(
      syncCapitalActionsToNotion([entry()], '', {
        databaseId: DB,
        asOf: '2026-06-22',
        fetchImpl: mockNotion([]),
      }),
    ).rejects.toThrow(/token/i);
  });

  it('empty entries → synced:0 skipped:0 errors:0 (no Notion calls past ensure-properties)', async () => {
    const calls: RecordedCall[] = [];
    const result = await syncCapitalActionsToNotion([], 'tok', {
      databaseId: DB,
      asOf: '2026-06-22',
      fetchImpl: mockNotion([], { calls }),
    });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    // No page query needed when there are no entries.
    expect(calls.some((c) => /\/query$/.test(c.url))).toBe(false);
  });
});

// Keep vi referenced (avoids unused-import lint if helpers change).
void vi;


// ── Audit 2026-10-13 G5: the 5-way allocation engine is the single writeback vocabulary ────────
describe('syncCapitalActionsToNotion — 5-way allocation vocabulary (audit 2026-10-13 G5)', () => {
  it('writes the 5-way AllocationAction value to the Capital Action select', async () => {
    const calls: RecordedCall[] = [];
    await syncCapitalActionsToNotion([entry({ allocationAction: 'refinance' })], 'tok', {
      databaseId: DB, asOf: '2026-10-13', fetchImpl: mockNotion([notionPage('page-1', '123 Main St')], { calls }),
    });
    const pagePatch = calls.find((c) => c.method === 'PATCH' && /\/pages\//.test(c.url))!;
    const props = (pagePatch.body as { properties: Record<string, unknown> }).properties;
    expect(props['Capital Action']).toEqual({ select: { name: 'refinance' } });
  });

  it('declares every 5-way option AND keeps the legacy options so existing rows are not broken', async () => {
    const calls: RecordedCall[] = [];
    await syncCapitalActionsToNotion([entry()], 'tok', {
      databaseId: DB, asOf: '2026-10-13', fetchImpl: mockNotion([notionPage('page-1', '123 Main St')], { calls }),
    });
    const dbPatch = calls.find((c) => c.method === 'PATCH' && /\/databases\/[^/]+$/.test(c.url))!;
    const action = (dbPatch.body as { properties: Record<string, { select: { options: Array<{ name: string }> } }> })
      .properties['Capital Action']!;
    const names = action.select.options.map((o) => o.name);
    for (const n of ['buy', 'hold', 'sell', 'refinance', 'improve']) expect(names).toContain(n);
    for (const n of ['invest', 'monitor', 'disposition-candidate']) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length); // no duplicate option names
  });

  // Refute wf_c69b93c5-c15 (ruling 2026-11-13): an advisory verdict (e.g. improve on the unratified
  // capex proxy) must never land in the operational register as a bare, final Capital Action.
  it('writes an advisory verdict as "<action> (advisory)", never the bare action, and declares those options', async () => {
    const calls: RecordedCall[] = [];
    await syncCapitalActionsToNotion([{ ...entry({ allocationAction: 'improve' }), advisory: true }], 'tok', {
      databaseId: DB, asOf: '2026-11-13', fetchImpl: mockNotion([notionPage('page-1', '123 Main St')], { calls }),
    });
    const pagePatch = calls.find((c) => c.method === 'PATCH' && /\/pages\//.test(c.url))!;
    const props = (pagePatch.body as { properties: Record<string, unknown> }).properties;
    expect(props['Capital Action']).toEqual({ select: { name: 'improve (advisory)' } });
    const dbPatch = calls.find((c) => c.method === 'PATCH' && /\/databases\/[^/]+$/.test(c.url))!;
    const names = (dbPatch.body as { properties: Record<string, { select: { options: Array<{ name: string }> } }> })
      .properties['Capital Action']!.select.options.map((o) => o.name);
    for (const n of ['buy', 'hold', 'sell', 'refinance', 'improve']) expect(names).toContain(`${n} (advisory)`);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a property with no allocation verdict (null action) is skipped — never written with a guessed value', async () => {
    const calls: RecordedCall[] = [];
    const result = await syncCapitalActionsToNotion([entry({ allocationAction: null })], 'tok', {
      databaseId: DB, asOf: '2026-10-13', fetchImpl: mockNotion([notionPage('page-1', '123 Main St')], { calls }),
    });
    // Refute H5: counted SEPARATELY — the matched Notion page keeps its prior (now stale) Capital
    // Action / Priority Score, which the sync result must surface rather than fold into 'skipped'.
    expect(result.skippedNoVerdict).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.synced).toBe(0);
    expect(calls.some((c) => c.method === 'PATCH' && /\/pages\//.test(c.url))).toBe(false);
    expect(() => NotionSyncResult.parse(result)).not.toThrow();
    expect(NotionSyncResult.parse(result).skippedNoVerdict).toBe(1);
  });

  it('a no-verdict property with no matching Notion page is a plain skip (nothing stale in Notion)', async () => {
    const result = await syncCapitalActionsToNotion([entry({ propertyName: 'Nowhere', allocationAction: null })], 'tok', {
      databaseId: DB, asOf: '2026-10-13', fetchImpl: mockNotion([notionPage('page-1', '123 Main St')]),
    });
    expect(result.skipped).toBe(1);
    expect(result.skippedNoVerdict).toBe(0);
  });
});

describe('buildCapitalWritebackEntries — joins the 5-way verdict to the report (audit 2026-10-13 G5)', () => {
  const verdict = (propertyId: string, action: AllocationVerdict['action'], advisoryOnly = false) =>
    ({ propertyId, propertyName: propertyId, action, advisoryOnly } as unknown as AllocationVerdict);
  const reportEntry = (propertyId: string, capitalAction: CapitalAllocationEntry['capitalAction'], priorityScore: number) =>
    ({ propertyId, propertyName: `Name ${propertyId}`, capitalAction, priorityScore } as unknown as CapitalAllocationEntry);

  it('uses the allocation engine action (not the legacy 4-way capitalAction) and the report priorityScore', () => {
    const portfolio = {
      verdicts: [verdict('p1', 'hold'), verdict('p2', 'sell'), verdict('pipeline:cand-1', 'buy')],
    } as unknown as PortfolioAllocation;
    const out = buildCapitalWritebackEntries(portfolio, [
      reportEntry('p1', 'invest', 71.4),                 // legacy says invest — engine says hold
      reportEntry('p2', 'disposition-candidate', 40),
      reportEntry('p3', 'monitor', 12),                  // no allocation verdict
    ]);
    expect(out).toEqual([
      { propertyName: 'Name p1', allocationAction: 'hold', priorityScore: 71.4, advisory: false },
      { propertyName: 'Name p2', allocationAction: 'sell', priorityScore: 40, advisory: false },
      { propertyName: 'Name p3', allocationAction: null, priorityScore: 12, advisory: false },
    ]);
  });

  it('carries the verdict advisoryOnly flag into the writeback entry (ruling 2026-11-13)', () => {
    const portfolio = { verdicts: [verdict('p1', 'improve', true)] } as unknown as PortfolioAllocation;
    expect(buildCapitalWritebackEntries(portfolio, [reportEntry('p1', 'invest', 50)])[0]!.advisory).toBe(true);
  });

  it('never writes the portfolio-level pipeline buy verdict onto an owned property', () => {
    const portfolio = { verdicts: [verdict('pipeline:p1', 'buy')] } as unknown as PortfolioAllocation;
    const out = buildCapitalWritebackEntries(portfolio, [reportEntry('p1', 'hold', 50)]);
    expect(out[0]!.allocationAction).toBeNull();
  });
});
