// tests/unit/calibration-ledger.test.ts
//
// Append-only calibration ledger: derivation of ratio / variance from $/unit, confidence-tier transitions as rows are
// appended, per-component median / min / max, mean suppression below n=5, exclusion rules, promotion from the pending
// file, the read-only proposal matcher, and the committed seed data.
import { costGolden, isSynthetic } from './golden-helpers';
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
  isPlaceholder,
  normalizeVendor,
  placeholdersFor,
  scopeFamily,
  sameQuoteDocument,
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
import { resolveProperty, type ParsedRegister } from '../../scripts/import-pca-register';

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
    contractor_source: { vendor: 'Zenith', doc_date: '2026-01-01', status: 'BID', source_file: 'q.pdf', source_date: '2026-01-01', price_basis: 'CONTRACTOR_QUOTE' },
    scope_note: 'test',
    added_at: '2026-10-13',
    ...over,
  });
}
const withId = (n: number, over: Partial<CalibrationObservation> = {}) => obs({ obs_id: `x:roof_epdm:v${n}:2026-01-01`, ...over });

describe('ratio and variance — derived from $/unit, never stored', () => {
  it('ratio = contractor ÷ PCA, variance = ratio − 1', () => {
    const o = obs({ pca_unit_cost: 8, contractor_unit_cost: 3.1 });
    expect(ratio(o)).toBeCloseTo(0.3875, 3);
    expect(variancePct(o)).toBeCloseTo(-0.6125, 3);
    expect(variancePct(obs({ pca_unit_cost: 5, contractor_unit_cost: 13.25 }))).toBeCloseTo(1.65, 6);
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
    // A different quote document from the proposal (same-document twins are refused; see the issue #474 block below).
    const ledger = [obs({ contractor_source: { ...obs().contractor_source, vendor: 'Other Roofer' } })];
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
    const real = obs({ obs_id: 'banwick:real', supersedes: ['banwick:placeholder'] });
    const agg = aggregateByComponent([placeholder, real]);
    expect(agg[0]!.n).toBe(1);
    expect(agg[0]!.points[0]!.obsId).toBe('banwick:real');
    expect(exclusionFor(placeholder, supersededMap([placeholder, real]))).toMatch(/superseded by banwick:real/);
    expect(exclusionFor(placeholder)).toBeNull(); // the stored row itself is untouched
    expect(supersededMap([real, placeholder]).size).toBe(0); // a row can only supersede an EARLIER id
    const pend = { ...proposal(), obs_id: 'x:new', supersedes: ['nope'] };
    expect(() => promoteProposal([placeholder], [pend], 'x:new', '2026-10-14')).toThrow(/not in the ledger/);
  });

  it('a $0 Actual Total does not mask the real Quoted Total', () => {
    const rt = (v: string) => ({ type: 'rich_text', rich_text: [{ plain_text: v }] });
    const props = { 'Record (title)': rt('EPDM roof replacement'), Property: rt('2800-2826 Banwick'), UOM: rt('SF'), 'Doc Date': rt('2026-04-01'), Qty: { type: 'number', number: 31500 }, 'Actual Total': { type: 'number', number: 0 }, 'Quoted Total': { type: 'number', number: 258300 }, Vendor: rt('Acme'), 'Record Type': rt('Quote'), Status: rt('Open') } as never;
    const q = notionQuote(props, 'wb')!;
    expect(q.totalUsd).toBe(258300);
    expect(q.isActual).toBe(false);
  });

  it('supersedes: promote can set it, refuses a target on a different property / component, and propose flags placeholder rows', () => {
    const placeholder = obs({ obs_id: 'banwick:placeholder', property: '2800-2826 Banwick', component: 'roof_epdm', contractor_source: { ...obs().contractor_source, vendor: 'Unidentified roofer (low)', doc_date: '2026' } });
    const other = obs({ obs_id: 'elsewhere:x', property: 'Elsewhere', component: 'roof_tpo' });
    const prop = { ...proposal(), obs_id: 'banwick:real', property: '2800-2826 Banwick', component: 'roof_epdm' as const };
    const ok = promoteProposal([placeholder, other], [prop], 'banwick:real', '2026-10-14', ['banwick:placeholder']);
    expect(ok.promoted.supersedes).toEqual(['banwick:placeholder']);
    expect(aggregateByComponent(ok.ledger).find((g) => g.component === 'roof_epdm')!.n).toBe(1);
    expect(() => promoteProposal([placeholder, other], [prop], 'banwick:real', '2026-10-14', ['elsewhere:x'])).toThrow(/different property/);
    const pcaLine: PcaLine = { propertyKey: 'banwick', component: 'roof_epdm', unit: 'SF', unitCost: 3.5, qty: 31500, consultant: 'Example Consultants', reportDate: '2026-02-16', reportId: 'R01', status: 'CURRENT', sourceFile: 'f' };
    const q: QuoteLine = { propertyKey: 'banwick', propertyLabel: '2800-2826 Banwick', component: 'roof_epdm', unit: 'SF', qty: 31500, totalUsd: 258300, isActual: false, vendor: 'Acme', docDate: '2026-03-30', status: 'BID', superseded: false, title: 't', sourceFile: 's' };
    const [p] = proposePairs([pcaLine], [q], { ledger: [placeholder], pending: [] }, '2026-10-14', 't');
    expect(p!.scope_note).toMatch(/--supersedes banwick:placeholder|--supersedes <obs_id>/);
    expect(p!.scope_note).toContain('banwick:placeholder');
  });

  it('proposal output does not depend on input order: pickPca ties and same-obs_id quotes resolve deterministically', () => {
    const a: PcaLine = { propertyKey: 'p', component: 'roof_tpo', unit: 'SF', unitCost: 12, qty: null, consultant: 'c', reportDate: '2025-03-01', reportId: 'R1', status: 'CURRENT', sourceFile: 'a' };
    const b: PcaLine = { ...a, unitCost: 4, reportId: 'R2', sourceFile: 'b' };
    const mk = (over: Partial<QuoteLine>): QuoteLine => ({ propertyKey: 'p', propertyLabel: 'P', component: 'roof_tpo', unit: 'SF', qty: 1000, totalUsd: 9000, isActual: false, vendor: 'V', docDate: '2025-06-01', status: 'BID', superseded: false, title: 't', sourceFile: 's', ...over });
    const run = (pca: PcaLine[], quotes: QuoteLine[]) => JSON.stringify(proposePairs(pca, quotes, { ledger: [], pending: [] }, '2026-10-14', 't'));
    expect(run([a, b], [mk({})])).toBe(run([b, a], [mk({})]));
    const sup = mk({ superseded: true, totalUsd: 5000 });
    const live = mk({ totalUsd: 9000 });
    expect(run([a], [sup, live])).toBe(run([a], [live, sup]));
    expect(JSON.parse(run([a], [sup, live]))[0].include_in_stats).toBe(true); // the live quote wins
  });

  it('one real quote can retire BOTH Banwick range rows; a retired row is never retired twice; re-running a half-finished --supersedes promote heals', () => {
    const lo = obs({ obs_id: 'b:lo', property: 'Banwick', component: 'roof_epdm' });
    const hi = obs({ obs_id: 'b:hi', property: 'Banwick', component: 'roof_epdm' });
    const prop = { ...proposal(), obs_id: 'b:real', property: 'Banwick', component: 'roof_epdm' as const };
    const done = promoteProposal([lo, hi], [prop], 'b:real', '2026-10-14', ['b:lo', 'b:hi']);
    expect(aggregateByComponent(done.ledger).find((g) => g.component === 'roof_epdm')!.n).toBe(1);
    const second = { ...prop, obs_id: 'b:real2' };
    expect(() => promoteProposal(done.ledger, [second], 'b:real2', '2026-10-15', ['b:lo'])).toThrow(/already superseded/);
    // crash between ledger write and pending write: the identical command heals instead of stranding the pending row
    const healed = promoteProposal(done.ledger, [prop], 'b:real', '2026-10-20', ['b:lo', 'b:hi']);
    expect(healed.ledger).toEqual(done.ledger);
    expect(healed.pending).toEqual([]);
  });

  it('proposePairs: quotes tying on vendor/date/total but differing in qty resolve the same whichever order they arrive', () => {
    const a: PcaLine = { propertyKey: 'p', component: 'roof_tpo', unit: 'SF', unitCost: 12, qty: null, consultant: 'c', reportDate: '2025-03-01', reportId: 'R1', status: 'CURRENT', sourceFile: 'a' };
    const mk = (qty: number): QuoteLine => ({ propertyKey: 'p', propertyLabel: 'P', component: 'roof_tpo', unit: 'SF', qty, totalUsd: 9000, isActual: false, vendor: 'V', docDate: '2025-06-01', status: 'BID', superseded: false, title: 't', sourceFile: 's' });
    const skipped: unknown[] = [];
    const fwd = JSON.stringify(proposePairs([a], [mk(1000), mk(1500)], { ledger: [], pending: [] }, '2026-10-14', 't', (d) => skipped.push(d)));
    const rev = JSON.stringify(proposePairs([a], [mk(1500), mk(1000)], { ledger: [], pending: [] }, '2026-10-14', 't'));
    expect(fwd).toBe(rev);
    expect(skipped).toHaveLength(1); // the dropped twin is reported, not silent
  });

  it('a quote dropped because only its slugified vendor collides is still reported (punctuation variants of one vendor)', () => {
    const a: PcaLine = { propertyKey: 'p', component: 'roof_epdm', unit: 'SF', unitCost: 12, qty: null, consultant: 'c', reportDate: '2025-03-01', reportId: 'R1', status: 'CURRENT', sourceFile: 'a' };
    const mk = (vendor: string, qty: number): QuoteLine => ({ propertyKey: 'p', propertyLabel: 'P', component: 'roof_epdm', unit: 'SF', qty, totalUsd: 9000, isActual: false, vendor, docDate: '2026-05-01', status: 'BID', superseded: false, title: 't', sourceFile: 's' });
    for (const quotes of [[mk('Zenith Roofing, Inc.', 1000), mk('Zenith Roofing Inc', 1500)], [mk('Zenith Roofing Inc', 1500), mk('Zenith Roofing, Inc.', 1000)]]) {
      const skipped: unknown[] = [];
      expect(proposePairs([a], quotes, { ledger: [], pending: [] }, '2026-10-14', 't', (d) => skipped.push(d))).toHaveLength(1);
      expect(skipped).toHaveLength(1);
    }
  });

  it('supersedes tolerates null / a bare string / missing on read, ignores argument order on recovery, and a non-counting row cannot retire counted ones', () => {
    const base = JSON.parse(JSON.stringify(obs()));
    expect(CalibrationObservation.parse({ ...base, supersedes: null }).supersedes).toEqual([]);
    expect(CalibrationObservation.parse({ ...base, supersedes: 'x' }).supersedes).toEqual(['x']);
    expect(CalibrationObservation.parse(base).supersedes).toEqual([]);
    const lo = obs({ obs_id: 'b:lo', property: 'Banwick', component: 'roof_epdm' });
    const hi = obs({ obs_id: 'b:hi', property: 'Banwick', component: 'roof_epdm' });
    const prop = { ...proposal(), obs_id: 'b:real', property: 'Banwick', component: 'roof_epdm' as const };
    const done = promoteProposal([lo, hi], [prop], 'b:real', '2026-10-14', ['b:hi', 'b:lo']);
    expect(promoteProposal(done.ledger, [prop], 'b:real', '2026-10-20', ['b:lo', 'b:hi']).ledger).toEqual(done.ledger);
    const noQty = { ...prop, obs_id: 'b:noqty', qty: null };
    expect(() => promoteProposal([lo, hi], [noQty], 'b:noqty', '2026-10-14', ['b:lo', 'b:hi'])).toThrow(/cannot supersede/);
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
    propertyKey: 'e-livingston', component: 'roof_other', unit: 'SF', unitCost: 7.5, qty: 3150, consultant: 'AEI', reportDate: '2025-01-22', reportId: 'R04', status: 'DRAFT', sourceFile: 'wb > Components',
  }];
  const quote = (over: Partial<QuoteLine> = {}): QuoteLine => ({
    propertyKey: 'e-livingston', propertyLabel: '3875-3883 E Livingston', component: 'roof_other', unit: 'SF', qty: 3040, totalUsd: 19456, isActual: false, vendor: 'Yarrow', docDate: '2024-12-09',
    status: 'BID', superseded: false, title: 'back bldg re-roof (Yarrow)', sourceFile: 'wb > Quotes_Actuals', ...over,
  });

  it('reports (instead of silently dropping) a second scope from the same vendor document', () => {
    const two = [...pca, { ...pca[0]!, component: 'paving_overlay' as const, unit: 'SF' as const, reportId: 'R04b' }];
    const skipped: Array<{ obsId: string; keptObsId: string }> = [];
    const out = proposePairs(two, [quote(), quote({ component: 'paving_overlay', title: 'lot overlay (Yarrow)' })], { ledger: [], pending: [] }, '2026-10-13', 't', (d) => skipped.push(d));
    expect(out).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    // Deterministic (component order, not input order): paving_overlay sorts first and is kept; the roof scope is reported, never silent.
    expect(skipped[0]!.obsId).toContain('roof_other');
    expect(skipped[0]!.keptObsId).toContain('paving_overlay');
  });

  describe('#474 pickPca: multi-roof ambiguity and quote-vs-PCA vintage', () => {
    const line = (over: Partial<PcaLine>): PcaLine => ({ propertyKey: 'p', component: 'roof_tpo', unit: 'SF', unitCost: 9, qty: 30000, consultant: 'c', reportDate: '2025-03-01', reportId: 'R1', status: 'CURRENT', sourceFile: 'wb > Components (R1 north roof)', ...over });
    const q = (over: Partial<QuoteLine> = {}): QuoteLine => ({ propertyKey: 'p', propertyLabel: 'P', component: 'roof_tpo', unit: 'SF', qty: 20000, totalUsd: 200000, isActual: false, vendor: 'V', docDate: '2025-06-01', status: 'BID', superseded: false, title: 'roof', sourceFile: 's', ...over });
    const run = (pcaLines: PcaLine[], quote: QuoteLine) => proposePairs(pcaLines, [quote], { ledger: [], pending: [] }, '2026-10-14', 't')[0]!;

    it('several roof sections with different unit costs in one report: no guess - pca_unit_cost stays null and the candidates are listed', () => {
      const north = line({});
      const south = line({ unitCost: 15, qty: 12000, sourceFile: 'wb > Components (R1 south roof)' });
      for (const lines of [[north, south], [south, north]]) {
        const p = run(lines, q());
        expect(p.pca_unit_cost).toBeNull();
        expect(p.contractor_unit_cost).toBe(10);
        expect(p.scope_note).toContain('north roof');
        expect(p.scope_note).toContain('south roof');
        expect(p.scope_note).toMatch(/ambiguous|several/i);
      }
    });

    it('...unless the quote quantity matches exactly one section, which is then the pairing', () => {
      const north = line({});
      const south = line({ unitCost: 15, qty: 12000, sourceFile: 'wb > Components (R1 south roof)' });
      const p = run([north, south], q({ qty: 12000, totalUsd: 150000 }));
      expect(p.pca_unit_cost).toBe(15);
      expect(p.scope_note).not.toMatch(/ambiguous/i);
    });

    it('one report cited at two date precisions (workbook vs Notion) is still one report: its sections stay ambiguous', () => {
      const wb = line({});
      const notion = line({ reportDate: '2025-03', unitCost: 15, qty: 12000, sourceFile: 'notion south' });
      expect(run([wb, notion], q()).pca_unit_cost).toBeNull();
    });

    it('a STALE earlier PCA does not shadow a live report dated after the quote', () => {
      const stale = line({ reportId: 'R0', reportDate: '2015-08-12', unitCost: 4, status: 'STALE' });
      const live = line({ reportId: 'R2', reportDate: '2026-04-07', unitCost: 14 });
      const p = run([stale, live], q({ docDate: '2025-06-01' }));
      expect(p.pca_unit_cost).toBe(14);
      expect(p.scope_note).toMatch(/dated after the quote/i);
    });

    it('sections with the same unit cost are not ambiguous', () => {
      expect(run([line({}), line({ qty: 12000, sourceFile: 'other' })], q()).pca_unit_cost).toBe(9);
    });

    it('pairs with the newest PCA dated on or before the quote, not a later report that may describe the finished work', () => {
      const old = line({ reportId: 'R1', reportDate: '2024-03-10', unitCost: 8 });
      const later = line({ reportId: 'R2', reportDate: '2026-04-07', unitCost: 14, sourceFile: 'later' });
      for (const lines of [[old, later], [later, old]]) {
        const p = run(lines, q({ docDate: '2025-06-01' }));
        expect(p.pca_unit_cost).toBe(8);
        expect(p.scope_note).not.toMatch(/after the quote/i);
      }
    });

    it('a same-month PCA counts as on-or-before (partial dates compare at the precision both state)', () => {
      const p = run([line({ reportDate: '2025-06', unitCost: 8 }), line({ reportId: 'R2', reportDate: '2026-04-07', unitCost: 14 })], q({ docDate: '2025-06-20' }));
      expect(p.pca_unit_cost).toBe(8);
    });

    it('when every PCA postdates the quote it still pairs (the earliest one) but the note says so', () => {
      const a = line({ reportId: 'R1', reportDate: '2026-04-07', unitCost: 14 });
      const b = line({ reportId: 'R2', reportDate: '2027-01-15', unitCost: 20, sourceFile: 'b' });
      const p = run([b, a], q({ docDate: '2025-06-01' }));
      expect(p.pca_unit_cost).toBe(14);
      expect(p.scope_note).toMatch(/dated after the quote/i);
    });
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
    const out = proposePairs(two, [quote({ component: 'paving_overlay', title: 'lot overlay (Yarrow)' })], { ledger: [], pending: [first!] }, '2026-10-13', 't', (d) => skipped.push(d));
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
    expect(p!.contractor_unit_cost).toBeCloseTo(6.4, 2);
    expect(p!.pca_unit_cost).toBe(7.5);
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
    const asLedger = [obs({ property: '3875-3883 E Livingston', contractor_unit_cost: 19456 / 3040, contractor_source: { vendor: 'Yarrow', doc_date: '2024-12-09', status: 'BID', source_file: 'q', source_date: '2024-12-09', price_basis: 'CONTRACTOR_QUOTE' } })];
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
      reports: [{ reportId: 'R04', propertyKey: 'e-livingston', consultant: 'AEI', reportDate: '2025-01-22', usabilityClass: 'draft' }],
      components: [
        { reportId: 'R04', system: '3883 mod-bit roof replacement', uom: 'SF', unitCost: 7.5, qty: 3150 },
        { reportId: 'R04', system: 'Roof repair allowance', uom: 'LS', unitCost: 1500, qty: 1 },
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
    const page = { properties: { 'Record (title)': { title: [{ plain_text: 'Test re-roof EPDM (Acme)' }] }, Property: { rich_text: [{ plain_text: '3520 E Fulton St' }] }, UOM: { select: { name: 'SF' } }, 'Doc Date': { date: { start: '2026-03-19' } }, Qty: { number: 38400 }, 'Quoted Total': { number: 259200 }, Vendor: { rich_text: [{ plain_text: 'Acme' }] }, 'Record Type': { select: { name: 'Estimate' } }, Status: { select: { name: 'Quoted' } } } };
    const fakeFetch = async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method });
      return { ok: true, status: 200, json: async () => ({ results: [page], has_more: false }), text: async () => '' };
    };
    const r = await fetchNotionLines({ token: 't', quotesDs: 'q1', componentsDs: 'c1' }, fakeFetch);
    expect(calls.every((c) => c.method === 'POST' && /\/data_sources\/(q1|c1)\/query$/.test(c.url))).toBe(true);
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]).toMatchObject({ propertyKey: 'e-fulton', component: 'roof_epdm', qty: 38400, vendor: 'Acme', status: 'BID' });
  });

  it('notionQuote rejects rows without a unit, date or property', () => {
    expect(notionQuote({}, 'Quotes_Actuals')).toBeNull();
  });
});

describe('committed seed data', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'data', 'calibration', name), 'utf-8')) as unknown;
  const ledger = parseLedger(read('observations.json'));

  it('parses against the strict schema with unique obs_ids (quote-document uniqueness: see the issue #474 block)', () => {
    expect(new Set(ledger.map((o) => o.obs_id)).size).toBe(ledger.length);
    expect(() => parsePending(read('calibration_pending.json'))).not.toThrow();
  });

  it('seeds every payload calibration pair, with Banwick as one row per quote (not a midpoint)', () => {
    const props = ledger.map((o) => o.property);
    expect(props).toEqual(expect.arrayContaining(['55 New Plant Ct', '3540 E Fifth Ave', '3875-3883 E Livingston', '3520 E Fulton St', '2800-2826 Banwick']));
    const banwick = ledger.filter((o) => o.property === '2800-2826 Banwick');
    // two rows (a low and a high quote), never one midpoint; values come from the (synthetic) fixture
    expect(banwick).toHaveLength(2);
    const [lo, hi] = banwick.map((o) => o.contractor_unit_cost ?? 0).sort((a, b) => a - b);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(hi!);
    expect(banwick.every((o) => o.contractor_source.status === 'BID')).toBe(true);
  });

  it('payload variances reproduce from $/unit and equal the value lock (data/cost-seg/golden.local.json)', () => {
    const by = (p: string) => ledger.find((o) => o.property === p)!;
    const G = costGolden().calibration;
    for (const p of ['55 New Plant Ct', '3540 E Fifth Ave', '3875-3883 E Livingston', '3520 E Fulton St']) {
      expect(G[p], p).toBeDefined();
      expect(variancePct(by(p))).toBeCloseTo(G[p]!.variancePct!, 10);
      expect(ratio(by(p))).toBeCloseTo(G[p]!.ratio!, 10);
    }
    // the stale-PCA rows read as savings and the Fulton quote as a multiple. That direction is a rank
    // between two real amounts, which the synthetic copy deliberately does not keep (its unit costs
    // are independent seeded draws), so it is asserted on the real file only.
    if (!isSynthetic('data/calibration/observations.json')) {
      expect(variancePct(by('55 New Plant Ct'))).toBeLessThan(0);
      expect(ratio(by('3520 E Fulton St'))).toBeGreaterThan(1);
    }
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

describe('quote-document dedupe against the committed ledger (issue #474)', () => {
  const read = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'data', 'calibration', name), 'utf-8')) as unknown;
  // The committed ledger is synthetic (vendors aliased), so the two quote-document rows these tests
  // are about are constructed here with a made-up vendor, replacing their committed counterparts;
  // the rest of the committed ledger (incl. the Banwick placeholder pair) is used as-is.
  const QR = { status: 'BID', source_file: 'q', price_basis: 'CONTRACTOR_QUOTE' } as const;
  const fultonRow = obs({
    obs_id: 'e-fulton:roof_epdm:zenith-roofing:2026-03', property: '3520 E Fulton St', qty: 38400, pca_unit_cost: 9, contractor_unit_cost: 6.75,
    contractor_source: { ...QR, vendor: 'Zenith Roofing', doc_date: '2026-03', source_date: '2026-03' },
  });
  const newPlantRow = obs({
    obs_id: 'new-plant:roof_epdm:qr-example:2016-11', property: '55 New Plant Ct', qty: 19800, pca_unit_cost: 5, contractor_unit_cost: 2.35,
    pca_source: { consultant: 'c', report_date: '2016-06', source_file: 'f', source_date: '2016-06', price_basis: 'PCA_CONSULTANT_ESTIMATE', status: 'STALE' },
    contractor_source: { ...QR, status: 'EXECUTED', vendor: 'Q.R. Example Inc', doc_date: '2016-11-08', source_date: '2016-11-08' },
  });
  const ledger = [
    ...parseLedger(read('observations.json')).filter((o) => o.property !== '3520 E Fulton St' && o.property !== '55 New Plant Ct'),
    fultonRow,
    newPlantRow,
  ];
  const KEPT = fultonRow.obs_id; // hand-written row: obs_id date truncated to YYYY-MM
  const pcaLine: PcaLine = { propertyKey: 'e-fulton', component: 'roof_epdm', unit: 'SF', unitCost: 9, qty: null, consultant: 'c', reportDate: '2025-02-11', reportId: 'R1', status: 'CURRENT', sourceFile: 'a' };
  const fulton = (over: Partial<QuoteLine> = {}): QuoteLine => ({
    propertyKey: 'e-fulton', propertyLabel: '3520 E Fulton St', component: 'roof_epdm', unit: 'SF', qty: 38400, totalUsd: 259200, isActual: false,
    vendor: 'Zenith Roofing', docDate: '2026-03-19', status: 'BID', superseded: false, title: 't', sourceFile: 's', ...over,
  });
  const keyOf = (label: string) => resolveProperty(label, new Set()).key;

  it.each([
    ['a property-label alias', { propertyLabel: '3520 E. Fulton St' }],
    ['a vendor-suffix variant', { vendor: 'Zenith Roofing, Inc.' }],
    ['both at once', { propertyLabel: '3520 E. Fulton Street', vendor: 'ZENITH ROOFING LLC' }],
  ])('proposePairs skips the Fulton quote re-read with %s, and reports it against the ledger row', (_label, over) => {
    const skipped: Array<{ obsId: string; keptObsId: string }> = [];
    const out = proposePairs([pcaLine], [fulton(over)], { ledger, pending: [] }, '2026-10-15', 't', (d) => skipped.push(d));
    expect(out).toHaveLength(0);
    expect(skipped).toEqual([expect.objectContaining({ keptObsId: KEPT })]);
  });

  it('the onDuplicate payload names the dropped and kept vendor, property and contractor unit cost', () => {
    const skipped: unknown[] = [];
    proposePairs([pcaLine], [fulton({ vendor: 'Zenith Roofing, Inc.' })], { ledger, pending: [] }, '2026-10-15', 't', (d) => skipped.push(d));
    expect(skipped[0]).toMatchObject({
      obsId: 'e-fulton:roof_epdm:zenith-roofing-inc:2026-03-19', keptObsId: KEPT,
      vendor: 'Zenith Roofing, Inc.', keptVendor: 'Zenith Roofing', property: '3520 E Fulton St', keptProperty: '3520 E Fulton St',
      contractorUnitCost: 6.75, keptContractorUnitCost: 6.75,
    });
  });

  it('a ledger row dated only YYYY-MM still matches a quote dated inside that month', () => {
    const monthOnly = obs({ obs_id: 'e-fulton:roof_epdm:zenith-roofing:2026-03', property: '3520 E Fulton St', contractor_source: { vendor: 'Zenith Roofing', doc_date: '2026-03', status: 'BID', source_file: 'q', source_date: '2026-03', price_basis: 'CONTRACTOR_QUOTE' } });
    expect(proposePairs([pcaLine], [fulton()], { ledger: [monthOnly], pending: [] }, '2026-10-15', 't')).toHaveLength(0);
    // ...but a different month from the same vendor is a different document.
    expect(proposePairs([pcaLine], [fulton({ docDate: '2026-04-02' })], { ledger: [monthOnly], pending: [] }, '2026-10-15', 't')).toHaveLength(1);
  });

  it.each([
    ['Q.R. Example Inc', 'Q. R. Example, Inc.'],
    ['Q.R. Example Inc', 'Q R Example'],
    ['Zenith & Sons Roofing', 'Zenith and Sons Roofing Co.'],
    ["O'Brien Roofing", 'OBrien Roofing LLC'],
    ['Zenith Roofing', 'Zenith Roofing, Inc'],
  ])('normalizeVendor treats %s and %s as one vendor', (a, b) => {
    expect(normalizeVendor(a)).toBe(normalizeVendor(b));
  });

  it('normalizeVendor still separates genuinely different vendors', () => {
    expect(normalizeVendor('Zenith Roofing')).not.toBe(normalizeVendor('Zenith Roofing Supply'));
    expect(normalizeVendor('Co-op Roofing')).not.toBe(normalizeVendor('Roofing'));
  });

  it('the spaced-initials variant of the committed New Plant row is caught by propose and promote', () => {
    const np: PcaLine = { ...pcaLine, propertyKey: 'new-plant' };
    const q = fulton({ propertyKey: 'new-plant', propertyLabel: '55 New Plant Ct.', vendor: 'Q. R. Example, Inc.', docDate: '2016-11-08' });
    const skipped: Array<{ keptObsId: string }> = [];
    expect(proposePairs([np], [q], { ledger, pending: [] }, '2026-10-15', 't', (d) => skipped.push(d))).toHaveLength(0);
    expect(skipped[0]!.keptObsId).toBe('new-plant:roof_epdm:qr-example:2016-11');
    const { added_at: _a, ...base } = ledger.find((o) => o.obs_id === 'new-plant:roof_epdm:qr-example:2016-11')!;
    const dup: CalibrationProposal = { ...base, obs_id: 'new-plant:roof_epdm:q-r-example-inc:2016-11-08', property: '55 New Plant Ct.', contractor_source: { ...base.contractor_source, vendor: 'Q. R. Example, Inc.' }, proposed_at: '2026-10-15', proposed_from: 't' };
    expect(() => promoteProposal(ledger, [dup], dup.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/same quote document/);
  });

  it('promoteProposal refuses re-promoting a quote document whose ledger row was already superseded', () => {
    const kept = ledger.find((o) => o.obs_id === KEPT)!;
    const revision = { ...kept, obs_id: 'e-fulton:roof_epdm:zenith-roofing:2026-09-01', contractor_source: { ...kept.contractor_source, doc_date: '2026-09-01', source_date: '2026-09-01' }, supersedes: [KEPT] };
    const withRevision = [...ledger, revision];
    expect(supersededMap(withRevision).get(KEPT)).toBe(revision.obs_id);
    const { added_at: _a, ...base } = kept;
    const again: CalibrationProposal = { ...base, obs_id: 'e-fulton:roof_epdm:zenith-roofing-inc:2026-03-19', property: '3520 E. Fulton St', contractor_source: { ...base.contractor_source, vendor: 'Zenith Roofing, Inc.' }, proposed_at: '2026-10-15', proposed_from: 't' };
    expect(() => promoteProposal(withRevision, [again], again.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/same quote document.*2026-03/);
  });

  it('the committed ledger + pending hold no two rows for one quote document (alias- and precision-aware) unless one supersedes the other', () => {
    const rows = [...ledger, ...parsePending(read('calibration_pending.json'))];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (b.supersedes.includes(a.obs_id)) continue;
        expect(sameQuoteDocument(a, b, keyOf), `${a.obs_id} vs ${b.obs_id}`).toBe(false);
      }
    }
  });

  describe('placeholder rows (no identified vendor) are guarded at promote', () => {
    const low = ledger.find((o) => o.obs_id === 'banwick:roof_epdm:quote-low:2026')!;
    const real = (vendor: string, date: string, id: string): CalibrationProposal => {
      const { added_at: _a, ...base } = low;
      return { ...base, obs_id: id, contractor_source: { ...base.contractor_source, vendor, doc_date: date, source_date: date }, proposed_at: '2026-10-15', proposed_from: 't' };
    };

    it('isPlaceholder recognises the committed Banwick range rows and nothing else', () => {
      expect(ledger.filter(isPlaceholder).map((o) => o.obs_id).sort()).toEqual(['banwick:roof_epdm:quote-high:2026', 'banwick:roof_epdm:quote-low:2026']);
    });

    it("round 4: one predicate — an unidentified vendor (incl. propose's own 'Unknown vendor' fallback) is a placeholder; a year-only date alone is not", () => {
      const v = (vendor: string, doc_date = '2026-06-01') => ({ contractor_source: { ...low.contractor_source, vendor, doc_date } });
      expect(isPlaceholder(v('Unidentified roofer (low end of quote range)'))).toBe(true);
      expect(isPlaceholder(v('Unknown vendor'))).toBe(true);
      expect(isPlaceholder(v('Acme Roofing', '2026'))).toBe(false);
      expect(isPlaceholder(v('Unknown Roofing Co'))).toBe(false); // a real firm whose name starts with "Unknown"
    });

    it('rounds 4-5: no promote order of {range low, range high, real year-only quote, Unknown-vendor quote} ever counts one document twice', () => {
      const LOWID = 'banwick:roof_epdm:quote-low:2026';
      const HIGHID = 'banwick:roof_epdm:quote-high:2026';
      const without = ledger.filter((o) => o.obs_id !== LOWID && o.obs_id !== HIGHID);
      const asProposal = (o: (typeof ledger)[number]): CalibrationProposal => {
        const { added_at: _a, ...rest } = o;
        return { ...rest, proposed_at: '2026-10-15', proposed_from: 't' };
      };
      const items = [
        asProposal(ledger.find((o) => o.obs_id === LOWID)!), asProposal(ledger.find((o) => o.obs_id === HIGHID)!),
        real('Acme Roofing Co', '2026', 'banwick:roof_epdm:acme-roofing:2026'), real('Unknown vendor', '2026-06-15', 'banwick:roof_epdm:unknown-vendor:2026-06-15'),
      ];
      const perms = (xs: CalibrationProposal[]): CalibrationProposal[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
      const orders = perms(items);
      expect(orders).toHaveLength(24);
      for (const order of orders) {
        let l = without;
        for (const p of order) {
          try { l = promoteProposal(l, [p], p.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf }).ledger; } catch { /* refused: the guard's job */ }
        }
        const retired = supersededMap(l);
        const counted = l.filter((o) => o.property === '2800-2826 Banwick' && includedInStats(o, retired));
        const label = order.map((p) => p.obs_id).join(' > ');
        // One quote document, one observation: what counts is EITHER exactly one real quote OR exactly one vendor-less
        // stand-in, where the hand-entered range pair (same 'Unidentified' stem, same date) is one stand-in.
        // Judged from the vendor strings themselves, not by isPlaceholder (the predicate under test).
        const kinds = new Set(counted.map((o) => {
          const v = o.contractor_source.vendor;
          return /^unidentified/i.test(v) ? `range@${o.contractor_source.doc_date}` : /^unknown vendor$/i.test(v.trim()) ? `unknown:${o.obs_id}` : `real:${o.obs_id}`;
        }));
        expect(kinds.size, `${label} -> ${[...kinds].join(', ')}`).toBe(1);
      }
    });

    it("round 5: an 'Unknown vendor' quote is refused beside the committed 'Unidentified roofer' range (not a range partner)", () => {
      const unknown = real('Unknown vendor', '2026-06-15', 'banwick:roof_epdm:unknown-vendor:2026-06-15');
      expect(() => promoteProposal(ledger, [unknown], unknown.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder.*quote-(low|high):2026/);
      expect(() => promoteProposal(ledger, [unknown], unknown.obs_id, '2026-10-15', ['banwick:roof_epdm:quote-low:2026', 'banwick:roof_epdm:quote-high:2026'], { propertyKeyOf: keyOf })).not.toThrow();
    });

    it('round 6: a range is a PAIR — a third same-date Unidentified row is refused beside the Banwick low/high', () => {
      const third = real('Unidentified roofer (mid estimate)', '2026', 'banwick:roof_epdm:unidentified-mid:2026');
      expect(() => promoteProposal(ledger, [third], third.obs_id, '2026-10-16', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder/);
      const bare = real('Unidentified', '2026', 'banwick:roof_epdm:unidentified:2026');
      expect(() => promoteProposal(ledger, [bare], bare.obs_id, '2026-10-16', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder/);
    });

    describe('round 6: scope families follow the classifier (seal_stripe is paving; a hand-entered "other" row meets every family)', () => {
      const { added_at: _x, ...lowRest } = low;
      const pavingPh = (vendor: string, id: string) =>
        CalibrationObservation.parse({ ...lowRest, obs_id: id, property: '100 Main St', component: 'paving_overlay', unit: 'SF', contractor_source: { ...low.contractor_source, vendor, doc_date: '2026', source_date: '2026' }, added_at: '2026-10-01' });
      const pavLedger = [pavingPh('Unidentified paver (low end)', 'main:paving_overlay:lo:2026'), pavingPh('Unidentified paver (high end)', 'main:paving_overlay:hi:2026')];
      const realQuote = (component: 'seal_stripe' | 'other' | 'hvac', id: string): CalibrationProposal => ({ ...real('Zenith Paving', '2026-03-02', id), property: '100 Main St', component, unit: 'SF' });

      it.each([['seal_stripe' as const], ['other' as const]])('a real %s quote is refused beside a paving_overlay placeholder range', (component) => {
        const q = realQuote(component, `main:${component}:zenith-paving:2026-03-02`);
        expect(() => promoteProposal(pavLedger, [q], q.obs_id, '2026-10-16', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder.*main:paving_overlay/);
        expect(placeholdersFor(pavLedger, { property: '100 Main St', component }, keyOf).map((o) => o.obs_id).sort()).toEqual(['main:paving_overlay:hi:2026', 'main:paving_overlay:lo:2026']);
      });

      it('an unrelated family (hvac) at the same property is not blocked', () => {
        const q = realQuote('hvac', 'main:hvac:zenith-paving:2026-03-02');
        expect(() => promoteProposal(pavLedger, [q], q.obs_id, '2026-10-16', undefined, { propertyKeyOf: keyOf })).not.toThrow();
      });

      it('scopeFamily is the one family function cost-seg also uses', () => {
        expect(scopeFamily('seal_stripe')).toBe('paving');
        expect(scopeFamily('paving_full_depth')).toBe('paving');
        expect(scopeFamily('roof_other')).toBe('roof');
        expect(scopeFamily('hvac')).toBe('hvac');
      });
    });

    it("round 5: isPlaceholder trims both alternatives (' Unidentified roofer' is still a placeholder)", () => {
      expect(isPlaceholder({ contractor_source: { ...low.contractor_source, vendor: '  Unidentified roofer' } })).toBe(true);
    });

    it("round 4: a quote first proposed as 'Unknown vendor' blocks the same quote later promoted under its real vendor", () => {
      const without = ledger.filter((o) => !o.obs_id.startsWith('banwick:'));
      const unknown = real('Unknown vendor', '2026-06-01', 'banwick:roof_epdm:unknown-vendor:2026-06-01');
      const l = promoteProposal(without, [unknown], unknown.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf }).ledger;
      const named = real('Acme Roofing', '2026-06-01', 'banwick:roof_epdm:acme-roofing:2026-06-01');
      expect(() => promoteProposal(l, [named], named.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder.*unknown-vendor/);
      expect(() => promoteProposal(l, [named], named.obs_id, '2026-10-15', [unknown.obs_id], { propertyKeyOf: keyOf })).not.toThrow();
    });

    it('round 4: a non-counting placeholder does not block a real quote (it adds nothing to n)', () => {
      const without = ledger.filter((o) => !o.obs_id.startsWith('banwick:'));
      const { added_at: _a, ...lowRest } = low;
      const noQtyPh = CalibrationObservation.parse({ ...lowRest, obs_id: 'banwick:roof_epdm:ph-noqty:2026', qty: null, added_at: '2026-10-01' });
      const named = real('Acme Roofing', '2026-06-01', 'banwick:roof_epdm:acme-roofing:2026-06-01');
      expect(() => promoteProposal([...without, noQtyPh], [named], named.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).not.toThrow();
    });

    it('round 4: an identified year-only quote is a real quote, so a dated quote for another roof section is NOT steered into superseding it', () => {
      const without = ledger.filter((o) => !o.obs_id.startsWith('banwick:'));
      const acme = real('Acme Roofing', '2026', 'banwick:roof_epdm:acme-roofing:2026');
      const l = promoteProposal(without, [acme], acme.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf }).ledger;
      const beta = { ...real('Beta Roofing', '2026-04-02', 'banwick:roof_tpo:beta-roofing:2026-04-02'), component: 'roof_tpo' as const };
      expect(() => promoteProposal(l, [beta], beta.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).not.toThrow();
      expect(() => promoteProposal(l, [beta], beta.obs_id, '2026-10-15', [acme.obs_id], { propertyKeyOf: keyOf })).toThrow(/different property \/ component/);
    });

    it('a real counted quote cannot be promoted next to its scope placeholders: roof_epdm never reaches USABLE by double counting', () => {
      const acme = real('Acme Roofing', '2026-06-01', 'banwick:roof_epdm:acme:2026-06-01');
      expect(() => promoteProposal(ledger, [acme], acme.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/placeholder.*banwick:roof_epdm:quote-(high|low):2026/);
      // Replacing the placeholders is the intended path; the count stays at 3 (2 placeholders out, 1 real quote in).
      const done = promoteProposal(ledger, [acme], acme.obs_id, '2026-10-15', ['banwick:roof_epdm:quote-low:2026', 'banwick:roof_epdm:quote-high:2026'], { propertyKeyOf: keyOf });
      expect(aggregateByComponent(done.ledger).find((a) => a.component === 'roof_epdm')).toMatchObject({ n: 2, tier: 'LIMITED' });
      // An explicit, placeholder-specific override still exists for a genuinely separate document.
      expect(() => promoteProposal(ledger, [acme], acme.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf, allowBesidePlaceholder: true })).not.toThrow();
      // Round 5: the same-document override does NOT also switch off the placeholder guard.
      expect(() => promoteProposal(ledger, [acme], acme.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf, allowDuplicateDocument: true })).toThrow(/placeholder/);
    });

    it('a row that does not count (no qty) may be promoted beside a placeholder — it adds nothing to n', () => {
      const noQty = { ...real('Acme Roofing', '2026-06-01', 'banwick:roof_epdm:acme-noqty:2026-06-01'), qty: null };
      expect(() => promoteProposal(ledger, [noQty], noQty.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).not.toThrow();
    });

    it('a placeholder pair (range low + high) can still be entered: a placeholder does not block another placeholder', () => {
      const { added_at: _a, ...base } = ledger.find((o) => o.obs_id === 'banwick:roof_epdm:quote-high:2026')!;
      const without = ledger.filter((o) => o.obs_id !== 'banwick:roof_epdm:quote-high:2026');
      const hi: CalibrationProposal = { ...base, proposed_at: '2026-10-15', proposed_from: 't' };
      expect(() => promoteProposal(without, [hi], hi.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).not.toThrow();
    });

    const LOW = 'banwick:roof_epdm:quote-low:2026';
    const HIGH = 'banwick:roof_epdm:quote-high:2026';
    const promote = (l: typeof ledger, p: CalibrationProposal, sup?: string[], allow = false) =>
      promoteProposal(l, [p], p.obs_id, '2026-10-15', sup, { propertyKeyOf: keyOf, allowBesidePlaceholder: allow });

    it('round 3: superseding only ONE of the placeholder pair is refused (the other would keep counting)', () => {
      const acme = real('Acme Roofing', '2026-06-01', 'banwick:roof_epdm:acme:2026-06-01');
      expect(() => promote(ledger, acme, [LOW])).toThrow(/placeholder.*quote-high/);
      expect(() => promote(ledger, acme, [HIGH])).toThrow(/placeholder.*quote-low/);
      expect(() => promote(ledger, acme, [LOW, HIGH])).not.toThrow();
    });

    it('round 3: an identified vendor with a year-only date is not exempt — it is a real quote beside the placeholders', () => {
      const yearOnly = real('Acme Roofing', '2026', 'banwick:roof_epdm:acme:2026');
      expect(() => promote(ledger, yearOnly)).toThrow(/placeholder/);
    });

    it('round 3: the guard is symmetric — a counted placeholder cannot be promoted beside a counted real quote either', () => {
      const without = ledger.filter((o) => o.obs_id !== LOW && o.obs_id !== HIGH);
      const able = real('Zenith Roofing', '2026-03-19', 'banwick:roof_epdm:zenith:2026-03-19');
      const afterReal = promote(without, able).ledger;
      const { added_at: _a, ...lowBase } = ledger.find((o) => o.obs_id === LOW)!;
      const lowP: CalibrationProposal = { ...lowBase, proposed_at: '2026-10-15', proposed_from: 't' };
      expect(() => promote(afterReal, lowP)).toThrow(/real quote.*banwick:roof_epdm:zenith:2026-03-19/);
      expect(() => promote(afterReal, lowP, undefined, true)).not.toThrow();
    });

    it('round 3: a reclassified scope (roof_other vs roof_epdm) still meets the roof placeholders', () => {
      const other = { ...real('Acme Roofing', '2026-06-01', 'banwick:roof_other:acme:2026-06-01'), component: 'roof_other' as const };
      expect(() => promote(ledger, other)).toThrow(/placeholder/);
    });

    it('round 3: propose flags the same placeholders for a reclassified roof scope', () => {
      const pcaOther: PcaLine = { ...pcaLine, propertyKey: 'banwick', component: 'roof_other' };
      const q = fulton({ propertyKey: 'banwick', propertyLabel: '2800-2826 Banwick', component: 'roof_other', vendor: 'Acme Roofing', docDate: '2026-06-01' });
      const [p] = proposePairs([pcaOther], [q], { ledger, pending: [] }, '2026-10-15', 't');
      expect(p!.scope_note).toMatch(/quote-low:2026.*quote-high:2026|quote-high:2026.*quote-low:2026/);
    });

    it('a placeholder on a different scope family does not block', () => {
      const paving = { ...real('Acme Paving', '2026-06-01', 'banwick:paving_overlay:acme:2026-06-01'), component: 'paving_overlay' as const };
      expect(() => promoteProposal(ledger, [paving], paving.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).not.toThrow();
    });
  });

  it('a different vendor at the same property and date is still proposed', () => {
    expect(proposePairs([pcaLine], [fulton({ vendor: 'Zenith Roofing Supply' })], { ledger, pending: [] }, '2026-10-15', 't')).toHaveLength(1);
  });

  it('promoteProposal refuses a row that is the same quote document as a live ledger row, unless overridden', () => {
    const { added_at: _a, ...base } = ledger.find((o) => o.obs_id === KEPT)!;
    const dup: CalibrationProposal = {
      ...base, obs_id: 'e-fulton:roof_epdm:zenith-roofing-inc:2026-03-19', property: '3520 E. Fulton St',
      contractor_source: { ...base.contractor_source, vendor: 'Zenith Roofing, Inc.' }, proposed_at: '2026-10-15', proposed_from: 't',
    };
    expect(() => promoteProposal(ledger, [dup], dup.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/same quote document.*e-fulton:roof_epdm:zenith-roofing:2026-03/);
    // Default normalization (no resolver) still catches the punctuation-only label variant.
    expect(() => promoteProposal(ledger, [dup], dup.obs_id, '2026-10-15')).toThrow(/same quote document/);
    const r = promoteProposal(ledger, [dup], dup.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf, allowDuplicateDocument: true });
    expect(r.ledger).toHaveLength(ledger.length + 1);
  });

  it('promoteProposal: a resolver alias the default slug cannot see is caught with the resolver', () => {
    const { added_at: _a, ...base } = ledger.find((o) => o.obs_id === KEPT)!;
    const dup: CalibrationProposal = { ...base, obs_id: 'e-fulton:alias', property: 'E Fulton bldg (3520)', proposed_at: '2026-10-15', proposed_from: 't' };
    expect(() => promoteProposal(ledger, [dup], dup.obs_id, '2026-10-15', undefined, { propertyKeyOf: keyOf })).toThrow(/same quote document/);
  });

  it('promoteProposal: a row that supersedes the matching ledger row is a replacement, not a duplicate', () => {
    const { added_at: _a, ...base } = ledger.find((o) => o.obs_id === KEPT)!;
    const repl: CalibrationProposal = { ...base, obs_id: 'e-fulton:roof_epdm:zenith-roofing:2026-03-19', proposed_at: '2026-10-15', proposed_from: 't' };
    expect(() => promoteProposal(ledger, [repl], repl.obs_id, '2026-10-15', [KEPT], { propertyKeyOf: keyOf })).not.toThrow();
  });
});

describe('supersededMap: only a counting row retires others (issue #474 LOW)', () => {
  it('a ledger row that does not count itself does not retire counted rows in the aggregate', () => {
    const lo = obs({ obs_id: 'b:lo', contractor_source: { vendor: 'Lo', doc_date: '2026-01-01', status: 'BID', source_file: 'q', source_date: '2026-01-01', price_basis: 'CONTRACTOR_QUOTE' } });
    const noQty = obs({ obs_id: 'b:noqty', qty: null, supersedes: ['b:lo'] }); // hand-edited into the ledger, bypassing promote
    expect(supersededMap([lo, noQty]).has('b:lo')).toBe(false);
    expect(aggregateByComponent([lo, noQty]).find((a) => a.component === 'roof_epdm')!.n).toBe(1);
  });
});
