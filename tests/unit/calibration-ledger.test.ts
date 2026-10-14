// tests/unit/calibration-ledger.test.ts
//
// Append-only calibration ledger: derivation of ratio / variance from $/unit, confidence-tier transitions as rows are
// appended, per-component median / min / max, mean suppression below n=5, exclusion rules, promotion from the pending
// file, the read-only proposal matcher, and the committed seed data.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CalibrationObservation,
  aggregateByComponent,
  classifyComponent,
  exclusionFor,
  supersededMap,
  includedInStats,
  latestObservation,
  median,
  pairKey,
  parseLedger,
  parsePending,
  promoteProposal,
  ratio,
  tierFor,
  underwritingUse,
  variancePct,
  type CalibrationProposal,
} from '../../src/analytics/calibration-ledger';
import {
  contractorStatus,
  fetchNotionLines,
  linesFromRegister,
  notionComponent,
  notionQuote,
  proposePairs,
  type PcaLine,
  type QuoteLine,
} from '../../scripts/calibration-propose';
import type { ParsedRegister } from '../../scripts/import-pca-register';

function obs(over: Partial<CalibrationObservation> = {}): CalibrationObservation {
  return CalibrationObservation.parse({
    obs_id: 'x:roof_epdm:a:2026-01-01',
    property: 'Test Property',
    component: 'roof_epdm',
    unit: 'SF',
    qty: 10000,
    pca_unit_cost: 4,
    pca_source: { consultant: 'CBRE', report_date: '2025-04', source_file: 'f.xlsx', source_date: '2025-04', price_basis: 'PCA_CONSULTANT_ESTIMATE', status: 'CURRENT' },
    contractor_unit_cost: 8,
    contractor_source: { vendor: 'Able', doc_date: '2026-01-01', status: 'BID', source_file: 'q.pdf', source_date: '2026-01-01', price_basis: 'CONTRACTOR_QUOTE' },
    scope_note: 'test',
    added_at: '2026-10-13',
    ...over,
  });
}
const withId = (n: number, over: Partial<CalibrationObservation> = {}) => obs({ obs_id: `x:roof_epdm:v${n}:2026-01-01`, ...over });

describe('ratio and variance — derived from $/unit, never stored', () => {
  it('ratio = contractor ÷ PCA, variance = ratio − 1', () => {
    const o = obs({ pca_unit_cost: 7, contractor_unit_cost: 2.8526 });
    expect(ratio(o)).toBeCloseTo(0.4075, 3);
    expect(variancePct(o)).toBeCloseTo(-0.5925, 3);
    expect(variancePct(obs({ pca_unit_cost: 4, contractor_unit_cost: 12.5 }))).toBeCloseTo(2.125, 6);
  });

  it('is null when either unit cost is missing or the PCA cost is zero', () => {
    expect(ratio(obs({ contractor_unit_cost: null }))).toBeNull();
    expect(ratio(obs({ pca_unit_cost: null }))).toBeNull();
    expect(ratio(obs({ pca_unit_cost: 0 }))).toBeNull();
    expect(variancePct(obs({ contractor_unit_cost: null }))).toBeNull();
  });

  it('the schema rejects a stored ratio or variance_pct (strict)', () => {
    const base = JSON.parse(JSON.stringify(obs())) as Record<string, unknown>;
    expect(() => CalibrationObservation.parse({ ...base, ratio: 2 })).toThrow();
    expect(() => CalibrationObservation.parse({ ...base, variance_pct: 1 })).toThrow();
  });

  it('every source block must carry file, date, price basis and status (provenance in the data)', () => {
    const base = JSON.parse(JSON.stringify(obs())) as { pca_source: Record<string, unknown> };
    delete base.pca_source.source_file;
    expect(() => CalibrationObservation.parse(base)).toThrow();
  });

  it('the PCA source can only be a PCA_CONSULTANT_ESTIMATE basis (firewall)', () => {
    const base = JSON.parse(JSON.stringify(obs())) as { pca_source: Record<string, unknown> };
    base.pca_source.price_basis = 'CONTRACTOR_QUOTE';
    expect(() => CalibrationObservation.parse(base)).toThrow();
  });
});

describe('confidence tier — recomputed as rows are appended', () => {
  it('tierFor: 0 NONE · 1 THIN · 2–4 LIMITED · 5+ USABLE', () => {
    expect([0, 1, 2, 4, 5, 9].map(tierFor)).toEqual(['NONE', 'THIN', 'LIMITED', 'LIMITED', 'USABLE', 'USABLE']);
  });

  it('transitions THIN → LIMITED → USABLE as observations are appended, with no code change', () => {
    const ledger = [withId(1)];
    const tiers = [aggregateByComponent(ledger)[0]!.tier];
    ledger.push(withId(2));
    tiers.push(aggregateByComponent(ledger)[0]!.tier);
    ledger.push(withId(3), withId(4));
    tiers.push(aggregateByComponent(ledger)[0]!.tier); // n=4
    ledger.push(withId(5));
    tiers.push(aggregateByComponent(ledger)[0]!.tier); // n=5
    expect(tiers).toEqual(['THIN', 'LIMITED', 'LIMITED', 'USABLE']);
  });

  it('THIN and LIMITED are "directional only"; USABLE is not', () => {
    const one = aggregateByComponent([withId(1)])[0]!;
    const five = aggregateByComponent([1, 2, 3, 4, 5].map((n) => withId(n)))[0]!;
    expect(one.directionalOnly).toBe(true);
    expect(five.directionalOnly).toBe(false);
  });
});

describe('aggregates per component', () => {
  const ledger = [
    withId(1, { contractor_unit_cost: 4 }), // ratio 1
    withId(2, { contractor_unit_cost: 8 }), // 2
    withId(3, { contractor_unit_cost: 12 }), // 3
    obs({ obs_id: 'x:roof_tpo:a:1', component: 'roof_tpo', contractor_unit_cost: 6 }), // 1.5
  ];

  it('n, median, min, max and the individual points', () => {
    const epdm = aggregateByComponent(ledger).find((a) => a.component === 'roof_epdm')!;
    expect(epdm.n).toBe(3);
    expect(epdm.medianRatio).toBe(2);
    expect(epdm.minRatio).toBe(1);
    expect(epdm.maxRatio).toBe(3);
    expect(epdm.points.map((p) => p.ratio)).toEqual([1, 2, 3]);
  });

  it('keeps components separate — there is no portfolio-wide factor', () => {
    const aggs = aggregateByComponent(ledger);
    expect(aggs.map((a) => a.component)).toEqual(['roof_tpo', 'roof_epdm']);
    expect(Object.keys(aggs[0]!)).not.toContain('portfolioFactor');
  });

  it('median of an even count averages the middle two', () => {
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('mean is suppressed below n=5 and shown at n=5', () => {
    const four = aggregateByComponent([1, 2, 3, 4].map((n) => withId(n, { contractor_unit_cost: 4 * n })))[0]!;
    expect(four.meanRatio).toBeNull();
    const five = aggregateByComponent([1, 2, 3, 4, 5].map((n) => withId(n, { contractor_unit_cost: 4 * n })))[0]!;
    expect(five.meanRatio).toBe(3);
  });
});

describe('exclusion from stats', () => {
  it('a row with null qty is excluded (not guessed)', () => {
    const o = obs({ qty: null });
    expect(includedInStats(o)).toBe(false);
    expect(exclusionFor(o)).toMatch(/quantity/);
  });

  it('include_in_stats=false is excluded and keeps its reviewer reason', () => {
    const o = obs({ include_in_stats: false, exclusion_reason: 'different scope' });
    expect(includedInStats(o)).toBe(false);
    expect(exclusionFor(o)).toBe('different scope');
  });

  it('a row whose PCA estimate comes from a stale (pre-2024) report is excluded — whatever include_in_stats says', () => {
    const stale = obs({ pca_source: { ...obs().pca_source, status: 'STALE' }, include_in_stats: true });
    expect(includedInStats(stale)).toBe(false);
    expect(exclusionFor(stale)).toMatch(/stale/);
    expect(includedInStats(obs({ pca_source: { ...obs().pca_source, status: 'DRAFT' } }))).toBe(true);
  });

  it('the stale guard checks the report DATE too — a row mislabelled CURRENT with a 2016 report date is still excluded', () => {
    const sneaky = obs({ pca_source: { ...obs().pca_source, status: 'CURRENT', report_date: '2016-10' } });
    expect(includedInStats(sneaky)).toBe(false);
    expect(includedInStats(obs({ pca_source: { ...obs().pca_source, status: 'CURRENT', report_date: '2024-01' } }))).toBe(true);
  });

  it('lump-sum rows cannot be normalized to $/unit and are excluded', () => {
    expect(includedInStats(obs({ unit: 'LS' }))).toBe(false);
  });

  it('excluded rows do not count toward n or the tier but are still counted as excluded', () => {
    const agg = aggregateByComponent([withId(1), withId(2, { qty: null }), withId(3, { include_in_stats: false })])[0]!;
    expect(agg.n).toBe(1);
    expect(agg.excluded).toBe(2);
    expect(agg.tier).toBe('THIN');
  });

  it('a component whose rows are all excluded reports n=0 / NONE', () => {
    const agg = aggregateByComponent([withId(1, { qty: null })])[0]!;
    expect([agg.n, agg.tier, agg.medianRatio]).toEqual([0, 'NONE', null]);
  });
});

describe('what changed + underwriting use', () => {
  it('latestObservation is the most recently added row', () => {
    const l = [withId(1, { added_at: '2026-10-01' }), withId(2, { added_at: '2026-10-13' }), withId(3, { added_at: '2026-10-05' })];
    expect(latestObservation(l)?.obs_id).toBe(withId(2).obs_id);
    expect(latestObservation([])).toBeNull();
  });

  it('underwritingUse lists only components with n ≥ 5 as usable', () => {
    const l = [1, 2, 3, 4, 5].map((n) => withId(n));
    l.push(obs({ obs_id: 'x:roof_tpo:a:1', component: 'roof_tpo' }));
    const use = underwritingUse(aggregateByComponent(l));
    expect(use.usable).toEqual(['roof_epdm']);
    expect(use.notUsable).toEqual(['roof_tpo']);
    expect(underwritingUse(aggregateByComponent([withId(1)])).note).toMatch(/directional only/);
  });
});

describe('promotion: pending → observation', () => {
  const proposal = (): CalibrationProposal => {
    const { added_at: _a, ...rest } = obs({ obs_id: 'p:roof_tpo:v:2026' });
    return { ...rest, proposed_at: '2026-10-13', proposed_from: 'workbook:test.xlsx' } as CalibrationProposal;
  };

  it('appends the proposal to the ledger and removes it from pending', () => {
    const ledger = [obs()];
    const r = promoteProposal(ledger, [proposal()], 'p:roof_tpo:v:2026', '2026-10-14');
    expect(r.ledger).toHaveLength(2);
    expect(r.ledger[1]!.obs_id).toBe('p:roof_tpo:v:2026');
    expect(r.ledger[1]!.added_at).toBe('2026-10-14');
    expect(r.pending).toHaveLength(0);
    expect(ledger).toHaveLength(1); // input not mutated
    expect(r.ledger[0]).toBe(ledger[0]); // existing rows untouched (append-only)
  });

  it('a later row that supersedes an earlier one stops it counting without editing it; an unknown target is refused', () => {
    const placeholder = obs({ obs_id: 'banwick:placeholder' });
    const real = obs({ obs_id: 'banwick:real', supersedes: 'banwick:placeholder' });
    const agg = aggregateByComponent([placeholder, real]);
    expect(agg[0]!.n).toBe(1);
    expect(agg[0]!.points[0]!.obsId).toBe('banwick:real');
    expect(exclusionFor(placeholder, supersededMap([placeholder, real]))).toMatch(/superseded by banwick:real/);
    expect(exclusionFor(placeholder)).toBeNull(); // the stored row itself is untouched
    expect(supersededMap([real, placeholder]).size).toBe(0); // a row can only supersede an EARLIER id
    const pend = { ...proposal(), obs_id: 'x:new', supersedes: 'nope' };
    expect(() => promoteProposal([placeholder], [pend], 'x:new', '2026-10-14')).toThrow(/not in the ledger/);
  });

  it('a $0 Actual Total does not mask the real Quoted Total', () => {
    const rt = (v: string) => ({ type: 'rich_text', rich_text: [{ plain_text: v }] });
    const props = { 'Record (title)': rt('EPDM roof replacement'), Property: rt('2800-2826 Banwick'), UOM: rt('SF'), 'Doc Date': rt('2026-04-01'), Qty: { type: 'number', number: 24000 }, 'Actual Total': { type: 'number', number: 0 }, 'Quoted Total': { type: 'number', number: 252000 }, Vendor: rt('Acme'), 'Record Type': rt('Quote'), Status: rt('Open') } as never;
    const q = notionQuote(props, 'wb')!;
    expect(q.totalUsd).toBe(252000);
    expect(q.isActual).toBe(false);
  });

  it('refuses to promote when two pending proposals share an obs_id (never picks by array order)', () => {
    const a = proposal();
    const b = { ...proposal(), pca_unit_cost: (proposal().pca_unit_cost ?? 0) + 1 };
    for (const pending of [[a, b], [b, a]]) {
      expect(() => promoteProposal([], pending, a.obs_id, '2026-10-14')).toThrow(/share obs_id/);
    }
  });

  it('is explicit — an unknown obs_id is refused and nothing changes', () => {
    expect(() => promoteProposal([obs()], [proposal()], 'nope', '2026-10-14')).toThrow(/no pending proposal/);
  });

  it('heals a half-finished promote: identical row already in the ledger just clears pending', () => {
    const first = promoteProposal([], [proposal()], proposal().obs_id, '2026-10-14');
    const healed = promoteProposal(first.ledger, [proposal()], proposal().obs_id, '2026-10-20');
    expect(healed.ledger).toEqual(first.ledger); // untouched, original added_at kept
    expect(healed.pending).toEqual([]);
  });

  it('a $0 contractor unit cost is excluded from stats, not counted as a ratio-0 point', () => {
    const z = obs({ contractor_unit_cost: 0 });
    expect(ratio(z)).toBeNull();
    expect(includedInStats(z)).toBe(false);
  });

  it('refuses a duplicate obs_id (append-only)', () => {
    const dup = { ...proposal(), obs_id: obs().obs_id, pca_unit_cost: (obs().pca_unit_cost ?? 0) + 1 }; // differing row: never overwritten
    expect(() => promoteProposal([obs()], [dup], obs().obs_id, '2026-10-14')).toThrow(/already exists/);
  });

  it('a promoted row with a null qty still lands but is excluded from stats', () => {
    const p = { ...proposal(), qty: null };
    const r = promoteProposal([], [p], p.obs_id, '2026-10-14');
    expect(includedInStats(r.promoted)).toBe(false);
  });
});

describe('proposal matcher (read-only)', () => {
  const pca: PcaLine[] = [{
    propertyKey: 'e-livingston', component: 'roof_other', unit: 'SF', unitCost: 12, qty: 2400, consultant: 'AEI', reportDate: '2025-04-10', reportId: 'R04', status: 'DRAFT', sourceFile: 'wb > Components',
  }];
  const quote = (over: Partial<QuoteLine> = {}): QuoteLine => ({
    propertyKey: 'e-livingston', propertyLabel: '3875-3883 E Livingston', component: 'roof_other', unit: 'SF', qty: 2376, totalUsd: REDACTED-AMT, isActual: false, vendor: 'Walker', docDate: '2025-03-26',
    status: 'BID', superseded: false, title: 'back bldg re-roof (Walker)', sourceFile: 'wb > Quotes_Actuals', ...over,
  });

  it('reports (instead of silently dropping) a second scope from the same vendor document', () => {
    const two = [...pca, { ...pca[0]!, component: 'paving_overlay' as const, unit: 'SF' as const, reportId: 'R04b' }];
    const skipped: Array<{ obsId: string; keptObsId: string }> = [];
    const out = proposePairs(two, [quote(), quote({ component: 'paving_overlay', title: 'lot overlay (Walker)' })], { ledger: [], pending: [] }, '2026-10-13', 't', (d) => skipped.push(d));
    expect(out).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.obsId).toContain('paving_overlay');
  });

  it('a negative or $0 contractor total (credit / placeholder) yields a null price, not a crash or a ratio', () => {
    for (const totalUsd of [0, -500]) {
      const [p] = proposePairs(pca, [quote({ totalUsd })], { ledger: [], pending: [] }, '2026-10-13', 't');
      expect(p!.contractor_unit_cost).toBeNull();
    }
  });

  it('reports a second scope that collapses against a row already on file from an earlier run', () => {
    const two = [...pca, { ...pca[0]!, component: 'paving_overlay' as const, unit: 'SF' as const, reportId: 'R04b' }];
    const [first] = proposePairs(two, [quote()], { ledger: [], pending: [] }, '2026-10-12', 't');
    const skipped: Array<{ obsId: string; keptObsId: string }> = [];
    const out = proposePairs(two, [quote({ component: 'paving_overlay', title: 'lot overlay (Walker)' })], { ledger: [], pending: [first!] }, '2026-10-13', 't', (d) => skipped.push(d));
    expect(out).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('a Notion component whose Usability says stale is STALE (not CURRENT), so it is excluded from stats', () => {
    const rt = (v: string) => ({ type: 'rich_text', rich_text: [{ plain_text: v }] });
    const props = { 'Report ID': rt('R09'), Property: rt('3875-3883 E Livingston'), System: rt('EPDM roof'), UOM: rt('SF'), 'Unit cost $/UOM': { type: 'number', number: 9 }, 'Report Date': rt('2025-03-01'), Usability: rt('Stale - superseded') } as never;
    expect(notionComponent(props)!.status).toBe('STALE');
  });

  it('pairs on property + component and normalizes the contractor total to $/unit', () => {
    const [p] = proposePairs(pca, [quote()], { ledger: [], pending: [] }, '2026-10-13', 'workbook:t');
    expect(p!.contractor_unit_cost).toBeCloseTo(12.58, 2);
    expect(p!.pca_unit_cost).toBe(12);
    expect(p!.pca_source.status).toBe('DRAFT');
    expect(p!.contractor_source.status).toBe('BID');
    expect(p!.include_in_stats).toBe(true);
  });

  it('does not pair across components or properties', () => {
    expect(proposePairs(pca, [quote({ component: 'roof_tpo' })], { ledger: [], pending: [] }, '2026-10-13', 't')).toHaveLength(0);
    expect(proposePairs(pca, [quote({ propertyKey: 'banwick' })], { ledger: [], pending: [] }, '2026-10-13', 't')).toHaveLength(0);
  });

  it('skips a quote already in the ledger or pending — no duplicates', () => {
    const first = proposePairs(pca, [quote()], { ledger: [], pending: [] }, '2026-10-13', 't');
    expect(proposePairs(pca, [quote()], { ledger: [], pending: first }, '2026-10-13', 't')).toHaveLength(0);
    const asLedger = [obs({ property: '3875-3883 E Livingston', contractor_unit_cost: REDACTED-AMT / 2376, contractor_source: { vendor: 'Walker', doc_date: '2025-03-26', status: 'BID', source_file: 'q', source_date: '2025-03-26', price_basis: 'CONTRACTOR_QUOTE' } })];
    expect(proposePairs(pca, [quote()], { ledger: asLedger, pending: [] }, '2026-10-13', 't')).toHaveLength(0);
  });

  it('a superseded quote is proposed but pre-excluded', () => {
    const [p] = proposePairs(pca, [quote({ superseded: true })], { ledger: [], pending: [] }, '2026-10-13', 't');
    expect(p!.include_in_stats).toBe(false);
    expect(p!.exclusion_reason).toMatch(/superseded/);
  });

  it('a quote with no stated qty gets a null qty (and is excluded later), never a guess', () => {
    const [p] = proposePairs(pca, [quote({ qty: null })], { ledger: [], pending: [] }, '2026-10-13', 't');
    expect(p!.qty).toBeNull();
    expect(p!.contractor_unit_cost).toBeNull();
  });

  it('maps record status: Completed → EXECUTED, Awarded/Contract → SIGNED, else BID', () => {
    expect(contractorStatus('Proposal', 'Completed')).toBe('EXECUTED');
    expect(contractorStatus('Contract', 'Awarded')).toBe('SIGNED');
    expect(contractorStatus('Quote', 'Quoted')).toBe('BID');
  });

  it('classifyComponent routes free text to the enum', () => {
    expect(classifyComponent('Firestone 60-mil TPO')).toBe('roof_tpo');
    expect(classifyComponent('EPDM roof replacement')).toBe('roof_epdm');
    expect(classifyComponent('Paving mill & overlay')).toBe('paving_overlay');
    expect(classifyComponent('Seal & stripe')).toBe('seal_stripe');
    expect(classifyComponent('Lobby carpet')).toBe('other');
  });

  it('linesFromRegister keeps only per-unit SF/SY/LF lines and drops lump sums', () => {
    const parsed = {
      reports: [{ reportId: 'R04', propertyKey: 'e-livingston', consultant: 'AEI', reportDate: '2025-04-10', usabilityClass: 'draft' }],
      components: [
        { reportId: 'R04', system: '3883 mod-bit roof replacement', uom: 'SF', unitCost: 12, qty: 2400 },
        { reportId: 'R04', system: 'Roof repair allowance', uom: 'LS', unitCost: 2000, qty: 1 },
      ],
      quotes: [],
    } as unknown as ParsedRegister;
    const { pca: lines } = linesFromRegister(parsed, 'wb.xlsx');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ component: 'roof_other', status: 'DRAFT', unit: 'SF' });
  });
});

describe('Notion source — read-only, degrades without a token', () => {
  it('is skipped (no network call) when the token or data-source ids are missing', async () => {
    let called = false;
    const r = await fetchNotionLines({}, async () => { called = true; throw new Error('should not be called'); });
    expect(called).toBe(false);
    expect(r.skipped).toMatch(/Notion source skipped/);
  });

  it('only issues POST queries to /data_sources/<id>/query — never a write', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const page = { properties: { 'Record (title)': { title: [{ plain_text: 'Test re-roof EPDM (Acme)' }] }, Property: { rich_text: [{ plain_text: '3520 E Fulton St' }] }, UOM: { select: { name: 'SF' } }, 'Doc Date': { date: { start: '2026-05-07' } }, Qty: { number: 52500 }, 'Quoted Total': { number: REDACTED-AMT }, Vendor: { rich_text: [{ plain_text: 'Acme' }] }, 'Record Type': { select: { name: 'Estimate' } }, Status: { select: { name: 'Quoted' } } } };
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      return { ok: true, status: 200, json: async () => ({ results: [page], has_more: false }), text: async () => '' };
    };
    const r = await fetchNotionLines({ token: 't', quotesDs: 'q1', componentsDs: 'c1' }, fakeFetch);
    expect(calls.every((c) => c.method === 'POST' && /\/data_sources\/(q1|c1)\/query$/.test(c.url))).toBe(true);
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]).toMatchObject({ propertyKey: 'e-fulton', component: 'roof_epdm', qty: 52500, vendor: 'Acme', status: 'BID' });
  });

  it('notionQuote rejects rows without a unit, date or property', () => {
    expect(notionQuote({}, 'Quotes_Actuals')).toBeNull();
  });
});

describe('committed seed data', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'data', 'calibration', name), 'utf-8')) as unknown;
  const ledger = parseLedger(read('observations.json'));

  it('parses against the strict schema with unique obs_ids and no duplicate quote documents', () => {
    expect(new Set(ledger.map((o) => o.obs_id)).size).toBe(ledger.length);
    expect(new Set(ledger.map(pairKey)).size).toBe(ledger.length);
    expect(() => parsePending(read('calibration_pending.json'))).not.toThrow();
  });

  it('seeds every payload calibration pair, with Banwick as one row per quote (not a midpoint)', () => {
    const props = ledger.map((o) => o.property);
    expect(props).toEqual(expect.arrayContaining(['55 New Plant Ct', '3540 E Fifth Ave', '3875-3883 E Livingston', '3520 E Fulton St', '2800-2826 Banwick']));
    const banwick = ledger.filter((o) => o.property === '2800-2826 Banwick');
    expect(banwick.map((o) => o.contractor_unit_cost).sort()).toEqual([10.5, 12.5]);
    expect(banwick.every((o) => o.contractor_source.status === 'BID')).toBe(true);
  });

  it('payload variances reproduce from $/unit (New Plant ≈ −59%, E Fifth ≈ −59%, Livingston ≈ +3%, Fulton 3.1×)', () => {
    const by = (p: string) => ledger.find((o) => o.property === p)!;
    expect(variancePct(by('55 New Plant Ct'))).toBeCloseTo(-0.5925, 2);
    expect(variancePct(by('3540 E Fifth Ave'))).toBeCloseTo(-0.5856, 2);
    expect(variancePct(by('3875-3883 E Livingston'))).toBeCloseTo(0.028, 2);
    expect(ratio(by('3520 E Fulton St'))).toBeCloseTo(3.125, 3);
  });

  it('every seed row has a stated qty and provenance; the only exclusions are the stale-PCA rows (New Plant 2016, E Fifth 2021)', () => {
    for (const o of ledger) {
      expect(o.qty).not.toBeNull();
      expect(o.pca_source.price_basis).toBe('PCA_CONSULTANT_ESTIMATE');
    }
    const excluded = ledger.filter((o) => !includedInStats(o)).map((o) => o.property).sort();
    expect(excluded).toEqual(['3540 E Fifth Ave', '55 New Plant Ct']);
  });

  it('component tiers today: roof_epdm n=3 LIMITED, roof_tpo n=1 THIN — nothing is USABLE', () => {
    const aggs = aggregateByComponent(ledger);
    expect(aggs.find((a) => a.component === 'roof_epdm')).toMatchObject({ n: 3, excluded: 1, tier: 'LIMITED', meanRatio: null });
    expect(aggs.find((a) => a.component === 'roof_tpo')).toMatchObject({ n: 1, excluded: 1, tier: 'THIN', meanRatio: null });
    expect(underwritingUse(aggs).usable).toEqual([]);
  });
});
