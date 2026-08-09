import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Deal } from '../../src/contracts/index';
import { mapNotionPage, mergeDeals, parseNameAliases, loadDeals, dealsDegradationFlag, hasDealsPipelineFailure } from '../../server/sources/notion-deals';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { findNearDuplicateNames } from '../../server/sources/deal-name';

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
  confidential: false, estimatedFields: [], ...o,
});

afterEach(() => {
  delete process.env.NOTION_CONFIDENTIAL_NAME_PATTERNS;
});

describe('mapNotionPage', () => {
  it('maps a Notion page to a Deal with stage/market/rate normalization', () => {
    const d = mapNotionPage(page())!;
    expect(d.name).toBe('Maple Logistics');
    expect(d.market).toBe('Other'); // Cincinnati OH → Other (not in our Market enum)
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
    deal({ id: 'seed-atlas', name: 'Project Atlas Industrial', stage: 'Due Diligence', confidential: true, shortName: 'Atlas' }),
    deal({ id: 'seed-banwick', name: 'Banwick Refi', stage: 'Candidate', confidential: false }),
  ];
  const notion = [
    deal({ id: 'notion-atlas', name: 'Project Atlas Industrial', stage: 'Closing', estPrice: 18_500_000, confidential: false }),
    deal({ id: 'notion-new', name: 'New Columbus Flex', stage: 'Candidate', confidential: false }),
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
      deal({ id: 'n1', name: 'DD Deal', stage: 'Due Diligence', confidential: false }),
      deal({ id: 'n2', name: 'Closing Deal', stage: 'Closing', confidential: false }),
      deal({ id: 'n3', name: 'Early Candidate', stage: 'Candidate', confidential: false }),
      deal({ id: 'n4', name: 'Done Deal', stage: 'Closed', confidential: false }),
    ]);
    expect(out.find((d) => d.id === 'n1')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n2')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n3')!.confidential).toBe(true); // widened: pre-LOI no longer public-by-default
    expect(out.find((d) => d.id === 'n4')!.confidential).toBe(true); // widened: closing no longer auto-publishes
  });

  it('a seed-matched deal still takes the seed flag — public-by-seed escape hatch unchanged', () => {
    const out = mergeDeals(
      [deal({ id: 's1', name: 'Known Public Deal', stage: 'LOI/PSA', confidential: false })],
      [deal({ id: 'n1', name: 'Known Public Deal', stage: 'LOI/PSA', confidential: false })],
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
      [deal({ id: 's1', name: 'Was Candidate', stage: 'Candidate', confidential: false })],
      [deal({ id: 'n1', name: 'Was Candidate', stage: 'Due Diligence', confidential: false })],
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
        deal({ id: 's1', name: 'Already Confidential', stage: 'Candidate', confidential: true }),
        deal({ id: 's2', name: 'Still Prospecting', stage: 'Candidate', confidential: false }),
      ],
      [
        deal({ id: 'n1', name: 'Already Confidential', stage: 'Due Diligence', confidential: false }),
        deal({ id: 'n2', name: 'Still Prospecting', stage: 'Candidate', confidential: false }),
      ],
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('mergeDeals — name aliases (dedup a deal named differently in Notion)', () => {
  const seed = [deal({ id: 'seed-cedar', name: 'Cedar Industrial Park', stage: 'Due Diligence', confidential: true, shortName: 'Cedar' })];
  // Same real deal, different name in Notion → would NOT match by name.
  const notion = [deal({ id: 'notion-cedar', name: 'Cedar Park Acquisition', stage: 'Closing', estPrice: 12_000_000 })];

  it('double-lists without an alias (the cosmetic duplicate)', () => {
    const out = mergeDeals(seed, notion, new Map());
    expect(out).toHaveLength(2); // seed copy + Notion extra
  });

  it('merges into the single seed record when an alias maps the names', () => {
    const aliases = parseNameAliases('Cedar Park Acquisition=>Cedar Industrial Park');
    const out = mergeDeals(seed, notion, aliases);
    expect(out).toHaveLength(1); // deduped
    const d = out[0]!;
    expect(d.id).toBe('seed-cedar'); // seed identity kept
    expect(d.confidential).toBe(true); // flag preserved
    expect(d.shortName).toBe('Cedar');
    expect(d.stage).toBe('Closing'); // live field won
    expect(d.estPrice).toBe(12_000_000);
  });
});

describe('mergeDeals — locality-suffix join key (regression: 2026-08-04 duplicate deal rows)', () => {
  // Notion names pipeline rows "<Deal Name> — <City>, <ST>"; the seed uses the bare name. Nothing
  // bridged the two, so the seed row AND the Notion row both shipped — contradicting each other on
  // stage/next-action, and disagreeing on redaction (the unmatched Notion copy defaulted
  // confidential:true while the seed copy stayed public).
  it('merges a Notion row carrying the "— City, ST" tail into its seed record', () => {
    const out = mergeDeals(
      [deal({ id: 'pendleton', name: 'Pendleton Trade Center', shortName: 'Pendleton TC', sf: 35_000, stage: 'Candidate', nextAction: 'LOI decision required', confidential: false })],
      [deal({ id: 'notion-pendleton', name: 'Pendleton Trade Center — Indianapolis, IN', stage: 'Dead', nextAction: 'PASSED — formally passed 3/26.' })],
      new Map(), // no aliases configured — the key itself must do this
    );
    expect(out).toHaveLength(1); // was 2 before the fix
    const d = out[0]!;
    expect(d.id).toBe('pendleton'); // seed identity kept
    expect(d.shortName).toBe('Pendleton TC');
    expect(d.sf).toBe(35_000); // seed value survives (Notion's was null)
    expect(d.stage).toBe('Dead'); // live state wins
    expect(d.nextAction).toBe('PASSED — formally passed 3/26.');
    expect(d.confidential).toBe(false); // seed flag preserved — no phantom confidential twin
  });

  it('does not merge two genuinely different deals that share a locality', () => {
    const out = mergeDeals(
      [deal({ id: 's-470', name: '470 McCormick Blvd' })],
      [deal({ id: 'n-511', name: '511 Industrial Mile Road — Columbus, OH' })],
      new Map(),
    );
    expect(out).toHaveLength(2);
  });

  it('still merges on an exact name match (no regression to the plain path)', () => {
    const out = mergeDeals(
      [deal({ id: 's1', name: '1333 Research Road', confidential: false })],
      [deal({ id: 'n1', name: '1333 Research Road', stage: 'Dead' })],
      new Map(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.stage).toBe('Dead');
  });
});

describe('mergeDeals — join-key collision must never silently drop a deal (review 2026-08-04)', () => {
  // The locality tail is exactly how Notion disambiguates same-named assets across metros, so
  // stripping it makes two rows collide on one key. Building `notionByKey` with `new Map(...)`
  // kept only the LAST row, and because a matching seed row put that key into `usedKeys`, neither
  // colliding row reached `extras` — one real deal vanished from the snapshot with no flag, and the
  // survivor wore the other's economics under the seed's public confidential flag. That was a
  // REGRESSION: pre-fix, neither row matched the bare seed name, so all three survived as visible
  // duplicates. Loud duplicates beat silent data loss.
  const seed = [deal({ id: 'seed-ebp', name: 'Enterprise Business Park', confidential: false })];
  const notion = [
    deal({ id: 'n-cols', name: 'Enterprise Business Park — Columbus, OH', estPrice: 1_000_000, status: 'LOI out' }),
    deal({ id: 'n-indy', name: 'Enterprise Business Park — Indianapolis, IN', estPrice: 9_000_000, status: 'Dead' }),
  ];

  it('keeps every colliding row instead of collapsing them into one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeDeals(seed, notion, new Map());
    expect(out).toHaveLength(3); // was 1 before the fix — two deals lost
    expect(out.map((d) => d.id).sort()).toEqual(['n-cols', 'n-indy', 'seed-ebp']);
    warn.mockRestore();
  });

  it('holds colliding rows OUT of the seed merge, so they keep the fail-closed confidential default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeDeals(seed, notion, new Map());
    // The public seed row is untouched — it did not absorb a colliding deal's economics.
    const s = out.find((d) => d.id === 'seed-ebp')!;
    expect(s.estPrice).toBeNull();
    expect(s.confidential).toBe(false);
    // Both Notion rows land as extras and default confidential.
    expect(out.find((d) => d.id === 'n-cols')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n-indy')!.confidential).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('join-key collision'));
    warn.mockRestore();
  });

  it('leaves the surviving rows detectable, so the gate blocks rather than shipping them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeDeals(seed, notion, new Map());
    expect(findNearDuplicateNames(out.map((d) => d.name), new Set()).length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('a locality tail after a real name segment does not over-strip into the parent deal', () => {
    // "Foo — Bldg A - Indianapolis, IN" must strip only the locality, keeping "— Bldg A" as the
    // building-level discriminator; otherwise a building merges into its parent.
    const out = mergeDeals(
      [deal({ id: 'seed-ptc', name: 'Pendleton Trade Center', confidential: false })],
      [deal({ id: 'n-bldg', name: 'Pendleton Trade Center — Bldg A - Indianapolis, IN', estPrice: 1_000_000 })],
      new Map(),
    );
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.id === 'seed-ptc')!.estPrice).toBeNull();
  });
});

describe('parseNameAliases', () => {
  it('parses ;/newline-separated "from=>to" pairs, normalized and case-insensitive', () => {
    const m = parseNameAliases('A Deal => Seed One;  Other=>Seed Two\nbad-line-no-arrow');
    expect(m.get('a deal')).toBe('seed one');
    expect(m.get('other')).toBe('seed two');
    expect(m.size).toBe(2);
  });

  it('returns an empty map for blank/unset input', () => {
    expect(parseNameAliases('').size).toBe(0);
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
