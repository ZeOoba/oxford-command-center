import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Deal } from '../../src/contracts/index';
import { mapNotionPage, mergeDeals, loadDeals, dealsDegradationFlag, hasDealsPipelineFailure } from '../../server/sources/notion-deals';
import { SEED_DEALS } from '../../src/data/seed-deals';

// The join-key describes that used to live here — aliases, locality-suffix matching, collisions,
// corroboration, and the four refute rounds' regressions — were retired with the name join on
// 2026-08-12. tests/unit/deal-id-join.test.ts covers the id join that replaced them.

const page = (over: Record<string, unknown> = {}) => ({
  properties: {
    'Deal Name': { type: 'title', title: [{ plain_text: 'Maple Logistics' }] },
    Address: { type: 'rich_text', rich_text: [{ plain_text: '123 Main, Columbus' }] },
    Market: { type: 'select', select: { name: 'Cincinnati OH' } },
    'Total SF': { type: 'number', number: 50000 },
    'Purchase Price': { type: 'number', number: 6000000 },
    'Going-In Cap Rate': { type: 'number', number: 7.5 }, // percent → 0.075
    'Levered IRR': { type: 'number', number: 0.18 }, // decimal → unchanged
    'Equity Multiple': { type: 'number', number: 2.4 },
    Stage: { type: 'select', select: { name: 'Under Contract' } },
    Lender: { type: 'rich_text', rich_text: [{ plain_text: 'Symetra' }] },
    'Deal Owner': { type: 'rich_text', rich_text: [{ plain_text: 'Gabriel' }] },
    'Next Action': { type: 'rich_text', rich_text: [{ plain_text: 'Order PCA' }] },
    ...over,
  },
});

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

afterEach(() => {
  delete process.env.NOTION_CONFIDENTIAL_NAME_PATTERNS;
});

describe('mapNotionPage', () => {
  it('maps a Notion page to a Deal with stage/market/rate normalization', () => {
    const d = mapNotionPage(page())!;
    expect(d.name).toBe('Maple Logistics');
    expect(d.market).toBe('Cincinnati OH'); // in the Market enum as of 2026-08-12 (was 'Other')
    expect(d.stage).toBe('Due Diligence'); // "Under Contract" → Due Diligence
    expect(d.sf).toBe(50000);
    expect(d.capRate).toBeCloseTo(0.075, 4); // 7.5 normalized to a decimal
    expect(d.irr).toBeCloseTo(0.18, 4); // already a decimal — unchanged
    expect(d.confidential).toBe(false); // no patterns configured
  });

  it('flags a Notion-only deal confidential when its name matches a configured pattern', () => {
    process.env.NOTION_CONFIDENTIAL_NAME_PATTERNS = 'atlas';
    const d = mapNotionPage(page({ 'Deal Name': { type: 'title', title: [{ plain_text: 'Project Atlas' }] } }))!;
    expect(d.confidential).toBe(true);
  });

  it('returns null for a row with no Deal Name', () => {
    expect(mapNotionPage({ properties: { 'Deal Name': { type: 'title', title: [] } } })).toBeNull();
  });

  it('an UNKNOWN Notion stage label still maps to Candidate for display (schema-drift tolerated at this layer)', () => {
    // A renamed/added select option maps to 'Candidate' for display; this layer no longer needs a
    // confidential guard for it — mergeDeals defaults EVERY unmatched deal confidential regardless
    // of stage (2026-07-16 policy widening), which subsumes the schema-drift case. See
    // notion-deals.test.ts "fail-closed on unflagged unmatched Notion deals".
    const d = mapNotionPage(page({ Stage: { type: 'select', select: { name: 'PSA Executed' } } }))!;
    expect(d.stage).toBe('Candidate');
  });

  it('maps Target Close Date to targetCloseDate (ISO date)', () => {
    const d = mapNotionPage(page({ 'Target Close Date': { type: 'date', date: { start: '2026-06-15' } } }))!;
    expect(d.targetCloseDate).toBe('2026-06-15');
  });

  it('targetCloseDate is null when the Notion date is empty', () => {
    expect(mapNotionPage(page())!.targetCloseDate).toBeNull();
  });
});

describe('mergeDeals — seed is the confidential-flag source of truth', () => {
  const seed = [
    deal({ id: 'seed-atlas', name: 'Project Atlas Industrial', notionDealId: 'DEAL-1', stage: 'Due Diligence', confidential: true, shortName: 'Atlas' }),
    deal({ id: 'seed-banwick', name: 'Banwick Refi', notionDealId: 'DEAL-2', stage: 'Candidate', confidential: false }),
  ];
  const notion = [
    deal({ id: 'notion-atlas', name: 'Project Atlas Industrial', notionDealId: 'DEAL-1', stage: 'Closing', estPrice: 18_500_000, confidential: false }),
    deal({ id: 'notion-new', name: 'New Columbus Flex', notionDealId: 'DEAL-3', stage: 'Candidate', confidential: false }),
  ];
  const out = mergeDeals(seed, notion);

  it('a matched deal keeps the seed id + confidential flag but takes live fields', () => {
    const a = out.find((d) => d.name === 'Project Atlas Industrial')!;
    expect(a.id).toBe('seed-atlas'); // seed id preserved
    expect(a.confidential).toBe(true); // NEVER lost — the bake redaction still catches it
    expect(a.stage).toBe('Closing'); // live field won
    expect(a.estPrice).toBe(18_500_000);
  });

  it('retains seed-only deals and appends Notion-only deals', () => {
    expect(out.find((d) => d.name === 'Banwick Refi')).toBeDefined();
    expect(out.find((d) => d.name === 'New Columbus Flex')).toBeDefined();
    expect(out).toHaveLength(3);
  });
});

describe('mergeDeals — fail-closed on unflagged unmatched Notion deals (I9, widened 2026-07-16)', () => {
  // Before I9 the ONLY confidential guard for a Notion-only deal was the optional
  // NOTION_CONFIDENTIAL_NAME_PATTERNS env regex (empty by default) — a new confidential deal
  // entered in Notion but not the seed baked UNFLAGGED. I9 initially defaulted only active-stage
  // (LOI-Closing) unmatched deals confidential; Gabriel widened this 2026-07-16 (policy review)
  // to EVERY unmatched deal regardless of stage — a pre-LOI Candidate is already identifying
  // (address/price/lender) and an unmatched deal reaching 'Closed Won' must not auto-flip public
  // (surviving NDA/price-confidentiality risk). To make an unmatched deal public, add it to
  // seed-deals.ts with confidential: false (the seed stays the source of truth).
  it('an unmatched Notion deal defaults confidential regardless of stage — no env pattern required', () => {
    const out = mergeDeals([], [
      deal({ id: 'n1', name: 'DD Deal', notionDealId: 'DEAL-11', stage: 'Due Diligence', confidential: false }),
      deal({ id: 'n2', name: 'Closing Deal', notionDealId: 'DEAL-12', stage: 'Closing', confidential: false }),
      deal({ id: 'n3', name: 'Early Candidate', notionDealId: 'DEAL-13', stage: 'Candidate', confidential: false }),
      deal({ id: 'n4', name: 'Done Deal', notionDealId: 'DEAL-14', stage: 'Closed', confidential: false }),
    ]);
    expect(out.find((d) => d.id === 'n1')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n2')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n3')!.confidential).toBe(true); // widened: pre-LOI no longer public-by-default
    expect(out.find((d) => d.id === 'n4')!.confidential).toBe(true); // widened: closing no longer auto-publishes
  });

  it('a seed-matched deal still takes the seed flag — public-by-seed escape hatch unchanged', () => {
    const out = mergeDeals(
      [deal({ id: 's1', name: 'Known Public Deal', notionDealId: 'DEAL-20', stage: 'LOI/PSA', confidential: false })],
      [deal({ id: 'n1', name: 'Known Public Deal', notionDealId: 'DEAL-20', stage: 'LOI/PSA', confidential: false })],
    );
    expect(out.find((d) => d.id === 's1')!.confidential).toBe(false);
    expect(out).toHaveLength(1);
  });
});

describe('mergeDeals — seed staleness tripwire (policy item 3, 2026-07-16)', () => {
  // A seed-matched deal keeps its seed confidential:false forever, even as the live stage
  // advances into an active acquisition stage — intended (the escape hatch), but a one-way
  // ratchet toward public with no visibility. Non-blocking: logs, never flips the flag or throws.
  it('warns when a seed-matched public deal advances into an active stage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeDeals(
      [deal({ id: 's1', name: 'Was Candidate', notionDealId: 'DEAL-31', stage: 'Candidate', confidential: false })],
      [deal({ id: 'n1', name: 'Was Candidate', notionDealId: 'DEAL-31', stage: 'Due Diligence', confidential: false })],
    );
    expect(out.find((d) => d.id === 's1')!.confidential).toBe(false); // flag unchanged
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Due Diligence'));
    warn.mockRestore();
  });

  it('does not warn when the deal is already confidential, or stays at a non-active stage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeDeals(
      [
        deal({ id: 's1', name: 'Already Confidential', notionDealId: 'DEAL-32', stage: 'Candidate', confidential: true }),
        deal({ id: 's2', name: 'Still Prospecting', notionDealId: 'DEAL-33', stage: 'Candidate', confidential: false }),
      ],
      [
        deal({ id: 'n1', name: 'Already Confidential', notionDealId: 'DEAL-32', stage: 'Due Diligence', confidential: false }),
        deal({ id: 'n2', name: 'Still Prospecting', notionDealId: 'DEAL-33', stage: 'Candidate', confidential: false }),
      ],
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * 2026-08-09 seed-fallback regression. loadDeals() used to swallow a live-fetch failure and return
 * SEED_DEALS with no signal, so a transient `fetch failed` silently replaced the live pipeline with
 * seed placeholders (deals 20 → 6, counterparties 15 → 14) while the run still exited 0. The
 * scheduled ora-lease-snapshot-refresh task's material-change gate read that wipe as real portfolio
 * movement and — under the 2026-08-09 auto-push directive — would have pushed it to origin/main.
 * The degradation must be REPORTABLE so parse.ts can raise an error-severity dataQuality flag and
 * evaluateReconciliationGate (PR #252) refuses the write in both CLI writers.
 */
describe('loadDeals degradation reporting', () => {
  const originalToken = process.env.NOTION_TOKEN;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
    delete process.env.NOTION_DEALS_DATA_SOURCE;
  });

  it('reports degraded="fetch-failed" (not a silent seed substitution) when the live fetch throws', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const out = await loadDeals();
    expect(out.degraded?.reason).toBe('fetch-failed');
    expect(out.degraded?.detail).toContain('fetch failed');
    expect(out.deals).toEqual(SEED_DEALS); // still degrades gracefully for the live server
  });

  it('reports degraded="empty-result" when a configured token returns zero deals', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ results: [], has_more: false }), text: async () => '',
    }));
    const out = await loadDeals();
    expect(out.degraded?.reason).toBe('empty-result');
    expect(out.deals).toEqual(SEED_DEALS);
  });

  it('reports degraded="not-configured" (NOT an error) when no token is set', async () => {
    delete process.env.NOTION_TOKEN;
    const out = await loadDeals();
    expect(out.degraded?.reason).toBe('not-configured');
    expect(out.deals).toEqual(SEED_DEALS);
  });

  it('keeps BOTH rows when two live titles are identical but the Deal IDs differ', async () => {
    // The determinism lens' HIGH. fetchNotionDeals keyed its dedupe map on `notion-${slug(name)}`,
    // so row EXISTENCE was a function of the NAME, last-write-wins over Notion's return order —
    // upstream of every guard in mergeDeals. A pure permutation of the API page order flipped which
    // row survived, and the destroyed one appeared in neither `merged` nor `extras`: a confidential
    // live row gone, zero flags, exit clean. Keying on the Deal ID is what the id join makes
    // possible. Asserted in BOTH orders, because one order passing proves nothing here.
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    const row = (title: string, n: number) =>
      page({
        'Deal Name': { type: 'title', title: [{ plain_text: title }] },
        'Deal ID': { type: 'unique_id', unique_id: { prefix: 'DEAL', number: n } },
      });

    for (const results of [
      [row('E Fulton St — Columbus, OH', 7), row('E. Fulton St — Columbus, OH', 21)],
      [row('E. Fulton St — Columbus, OH', 21), row('E Fulton St — Columbus, OH', 7)],
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results, has_more: false }),
        text: async () => '',
      }));
      const out = await loadDeals();
      const ids = out.deals.map((d) => d.notionDealId).filter(Boolean).sort();
      expect(ids).toEqual(['DEAL-21', 'DEAL-7']);
      expect(out.deals.filter((d) => d.notionDealId).every((d) => d.confidential)).toBe(true);
    }
  });

  it('surfaces merge Deal-ID flags on DealsLoad so the reconciliation gate can act on them', async () => {
    // Live rows the joiner had to refuse: the flag must ESCAPE the adapter, not just reach the log.
    // Here they carry no Deal ID at all, which is what a renamed or unshared "Deal ID" column looks
    // like from this side — the join refuses rather than falling back to the names.
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          page({ 'Deal Name': { type: 'title', title: [{ plain_text: 'Collide Park — Columbus, OH' }] } }),
          page({ 'Deal Name': { type: 'title', title: [{ plain_text: 'Collide Park — Louisville, KY' }] } }),
        ],
        has_more: false,
      }),
      text: async () => '',
    }));

    const out = await loadDeals();

    expect(out.flags.some((f) => f.field === 'notionDealId' && f.severity === 'error')).toBe(true);
    // …and both rows survive, defaulting confidential — a refusal never drops a deal.
    expect(out.deals.filter((d) => d.name.startsWith('Collide Park'))).toHaveLength(2);
    expect(out.deals.filter((d) => d.name.startsWith('Collide Park')).every((d) => d.confidential)).toBe(true);
  });

  it('reports degraded=null on a healthy live fetch', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [page()], has_more: false }),
      text: async () => '',
    }));
    const out = await loadDeals();
    expect(out.degraded).toBeNull();
    expect(out.deals.length).toBeGreaterThan(0);
  });

  /**
   * 2026-08-11 integrity sweep, L5. fetchNotionDeals paginates `for (let i = 0; i < 5; i++)` at 100
   * rows/page, so a data source past 500 rows was silently truncated even while `has_more` was still
   * true. That is the same movement-gate false signal as the 2026-08-09 incident at smaller
   * amplitude: a reduced deal set, no degradation, exit 0, past both CLI gates AND Brain.persist.
   * A truncated fetch is a data-LOSING degradation and must be reported as one.
   */
  it('reports a degradation when the pagination cap is hit while has_more is still true', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    // Every page claims there is more — i.e. the source is larger than the cap can walk.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [page()], has_more: true, next_cursor: 'c' }),
      text: async () => '',
    }));

    const out = await loadDeals();

    expect(out.degraded).not.toBeNull();
    expect(out.degraded?.detail).toMatch(/truncat|pagination|cap/i);
    // Must fall back to seed rather than publish a partial set as authoritative.
    expect(out.deals).toEqual(SEED_DEALS);
    // And it must map to an error-severity flag so both CLI gates refuse the write.
    expect(dealsDegradationFlag(out.degraded, 6)?.severity).toBe('error');
  });

  it('does NOT report a degradation when pagination completes within the cap', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
      ok: true,
      // Two pages then done — well inside the cap.
      json: async () => ({ results: [page()], has_more: ++call < 2, next_cursor: 'c' }),
      text: async () => '',
    })));

    const out = await loadDeals();

    expect(out.degraded).toBeNull();
  });
});

describe('dealsDegradationFlag', () => {
  it('raises an ERROR-severity flag for fetch-failed so the reconciliation gate refuses the write', () => {
    const f = dealsDegradationFlag({ reason: 'fetch-failed', detail: 'fetch failed' }, 6)!;
    expect(f.severity).toBe('error');
    expect(f.entity).toBe('deals');
    expect(f.issue).toContain('6'); // the seed count that would have been written
  });

  it('raises an ERROR-severity flag for empty-result', () => {
    expect(dealsDegradationFlag({ reason: 'empty-result', detail: 'x' }, 6)!.severity).toBe('error');
  });

  it('returns null for not-configured — an unconfigured dev server must keep working unflagged', () => {
    expect(dealsDegradationFlag({ reason: 'not-configured', detail: 'x' }, 6)).toBeNull();
  });

  it('returns null when there is no degradation', () => {
    expect(dealsDegradationFlag(null, 20)).toBeNull();
  });
});

/**
 * The live server is a THIRD writer of portfolio.json (Brain.persist), and it deliberately does not
 * run evaluateReconciliationGate -- it appends flags and keeps serving, which is right for a UI but
 * would re-introduce the seed wipe on the shared git-tracked mirror whenever a server happens to be
 * refreshing during a Notion outage. Brain.persist consults this predicate so it can keep serving
 * the degraded snapshot in memory while declining to poison the mirror.
 */
describe('hasDealsPipelineFailure', () => {
  it('detects the error-severity deals-pipeline flag', () => {
    const flag = dealsDegradationFlag({ reason: 'fetch-failed', detail: 'x' }, 6)!;
    expect(hasDealsPipelineFailure([flag])).toBe(true);
  });

  it('ignores unrelated error flags — only the deals-pipeline failure blocks the mirror write', () => {
    expect(hasDealsPipelineFailure([{ entity: 'cash', field: 'balance', issue: 'x', severity: 'error' }])).toBe(false);
  });

  it('ignores a warn-severity deals flag', () => {
    expect(hasDealsPipelineFailure([{ entity: 'deals', field: 'pipeline', issue: 'x', severity: 'warn' }])).toBe(false);
  });

  it('is false for an empty flag set', () => {
    expect(hasDealsPipelineFailure([])).toBe(false);
  });
});
