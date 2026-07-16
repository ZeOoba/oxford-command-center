import { describe, it, expect, afterEach } from 'vitest';
import type { Deal } from '../../src/contracts/index';
import { mapNotionPage, mergeDeals, parseNameAliases } from '../../server/sources/notion-deals';

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

  it('an UNKNOWN Notion stage label flags the deal confidential (schema-drift fail-closed)', () => {
    // A renamed/added select option maps to 'Candidate' for display — the one class the
    // active-stage default ignores — so the mapper itself must fail closed on unmapped labels.
    const d = mapNotionPage(page({ Stage: { type: 'select', select: { name: 'PSA Executed' } } }))!;
    expect(d.stage).toBe('Candidate'); // display mapping unchanged
    expect(d.confidential).toBe(true); // but never bakes public on schema drift
  });

  it('a KNOWN stage label does not trigger the schema-drift flag', () => {
    const d = mapNotionPage(page())!; // 'Under Contract' — mapped
    expect(d.confidential).toBe(false);
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

describe('mergeDeals — fail-closed on unflagged active-stage Notion-only deals (I9)', () => {
  // Before I9 the ONLY confidential guard for a Notion-only deal was the optional
  // NOTION_CONFIDENTIAL_NAME_PATTERNS env regex (empty by default) — a new confidential deal
  // entered in Notion but not the seed baked UNFLAGGED. Active-stage (LOI through Closing)
  // unmatched deals now default confidential; to make one public, add it to seed-deals.ts
  // with confidential: false (the seed stays the source of truth).
  it('an unmatched active-stage Notion deal defaults confidential — no env pattern required', () => {
    const out = mergeDeals([], [deal({ id: 'notion-q', name: 'Quiet Acquisition', stage: 'LOI/PSA', confidential: false })]);
    expect(out[0]!.confidential).toBe(true);
  });

  it('covers Due Diligence and Closing; a pre-LOI Candidate keeps the keyword-guard result', () => {
    const out = mergeDeals([], [
      deal({ id: 'n1', name: 'DD Deal', stage: 'Due Diligence', confidential: false }),
      deal({ id: 'n2', name: 'Closing Deal', stage: 'Closing', confidential: false }),
      deal({ id: 'n3', name: 'Early Candidate', stage: 'Candidate', confidential: false }),
      deal({ id: 'n4', name: 'Done Deal', stage: 'Closed', confidential: false }),
    ]);
    expect(out.find((d) => d.id === 'n1')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n2')!.confidential).toBe(true);
    expect(out.find((d) => d.id === 'n3')!.confidential).toBe(false); // pre-LOI: keyword guard only
    expect(out.find((d) => d.id === 'n4')!.confidential).toBe(false); // closed: public per Invariant 3
  });

  it('a seed-matched active deal still takes the seed flag — public-by-seed stays possible', () => {
    const out = mergeDeals(
      [deal({ id: 's1', name: 'Known Public Deal', stage: 'LOI/PSA', confidential: false })],
      [deal({ id: 'n1', name: 'Known Public Deal', stage: 'LOI/PSA', confidential: false })],
    );
    expect(out.find((d) => d.id === 's1')!.confidential).toBe(false);
    expect(out).toHaveLength(1);
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
