// tests/unit/cost-seg.test.ts
//
// Module 10 — Cost Segregation Property Data. A second source type next to the PCA reports: engineering takeoffs and
// RSMeans / Marshall & Swift modeled pricing for tax classification. Never a condition assessment, never a reserve,
// near-term, intensity or calibration input; quantities reach calibration only as pending candidates a human promotes.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COST_SEG_PROPERTY_MAP,
  CostSegFact,
  allocationSum,
  bridgeCostSegQuantities,
  compareQuantity,
  crossCheck,
  decidingValues,
  sameProperty,
  isUnverified,
  parseCostSeg,
  pcaComparators,
  sourceKind,
  specSheet,
  studyRegister,
  type CostSegFactT,
} from '../../src/analytics/cost-seg';
import { CalibrationObservation, CalibrationProposal, aggregateByComponent, parseLedger, promoteProposal } from '../../src/analytics/calibration-ledger';
import { applyPcaOverlay, nearTermRollup } from '../../src/analytics/pca-intelligence';
import { RawExtraction, ReportMeta, SpecFact, stampReport } from '../../src/analytics/building-specs';
import { PCA_ISSUES } from '../../src/modules/property-condition/pca-overlay';

const ds = parseCostSeg(JSON.parse(readFileSync(join(process.cwd(), 'data', 'cost-seg', 'cost-seg.json'), 'utf-8')));

const fact = (over: Record<string, unknown> = {}) => ({
  property: '1100 Rarig Ave', study_id: 'CS-RAR', component: 'roof', attribute: 'roofing_area', value: 21000, unit: 'SF', as_of: '2024-08-26',
  consultant: 'ELB', report_date: '2024-08-26', source_type: 'COST_SEG', price_basis: 'COST_SEG_MODELED_RSMEANS_M&S',
  source_file: 'Business/1100 Rarig/x.pdf', source_page: null, ocr: false, confidence: 'STATED', note: null, ...over,
});

describe('schema — identity, basis firewall', () => {
  it('requires study_id and as_of on every fact', () => {
    expect(() => CostSegFact.parse(fact())).not.toThrow();
    expect(() => CostSegFact.parse({ ...fact(), study_id: undefined })).toThrow();
    expect(() => CostSegFact.parse({ ...fact(), as_of: undefined })).toThrow();
    expect(() => CostSegFact.parse(fact({ study_id: 'CS-XXX' }))).toThrow();
  });

  it('price_basis is its own enum value — PCA estimates and contractor prices are rejected', () => {
    for (const basis of ['PCA_CONSULTANT_ESTIMATE', 'CONTRACTOR_QUOTE', 'CONTRACTOR_ACTUAL']) {
      expect(() => CostSegFact.parse(fact({ price_basis: basis }))).toThrow();
    }
    expect(() => CostSegFact.parse(fact({ source_type: 'PCA' }))).toThrow();
  });

  it('a cost seg basis cannot be used as a calibration source (firewall the other way)', () => {
    const base = {
      obs_id: 'x', property: 'p', component: 'roof_epdm', unit: 'SF', qty: 1000, pca_unit_cost: 4,
      pca_source: { consultant: 'c', report_date: '2025-01', source_file: 'f', source_date: '2025-01', price_basis: 'PCA_CONSULTANT_ESTIMATE', status: 'CURRENT' },
      contractor_unit_cost: 8,
      contractor_source: { vendor: 'v', doc_date: '2025-02', status: 'BID', source_file: 'f', source_date: '2025-02', price_basis: 'CONTRACTOR_QUOTE' },
      scope_note: '', added_at: '2026-10-13',
    };
    expect(() => CalibrationObservation.parse(base)).not.toThrow();
    expect(() => CalibrationObservation.parse({ ...base, pca_source: { ...base.pca_source, price_basis: 'COST_SEG_MODELED_RSMEANS_M&S' } })).toThrow();
    expect(() => CalibrationObservation.parse({ ...base, contractor_source: { ...base.contractor_source, price_basis: 'COST_SEG_MODELED_RSMEANS_M&S' } })).toThrow();
  });

  it('a cost seg fact cannot be loaded into the module-9 (PCA condition) fact store', () => {
    const asSpec = { ...fact(), property_label: 'x', report_id: 'R1', report_vintage: 'CURRENT', report_date: '2024-08-26' };
    expect(() => SpecFact.parse(asSpec)).toThrow(); // extra keys study_id / source_type / price_basis are rejected (strict)
  });
});

describe('committed dataset', () => {
  it('has 222 facts, 6 studies, 14 discrepancies, every fact a COST_SEG fact on the modeled basis', () => {
    expect(ds.facts).toHaveLength(222);
    expect(Object.keys(ds.studies).sort()).toEqual(['CS-BWY', 'CS-FIS', 'CS-LIV', 'CS-NWD', 'CS-RAR', 'CS-RDB']);
    expect(ds.discrepancies.map((d) => d.id)).toEqual(Array.from({ length: 14 }, (_, i) => `D${i + 1}`));
    expect(ds.facts.every((f) => f.source_type === 'COST_SEG' && f.price_basis === 'COST_SEG_MODELED_RSMEANS_M&S')).toBe(true);
  });

  it('class allocations tie to the study totals', () => {
    const expected: Record<string, number> = { 'CS-RAR': 1537638.0, 'CS-BWY': 4227743, 'CS-RDB': 12897738, 'CS-NWD': 3559012, 'CS-LIV': 621600, 'CS-FIS': 1372750.0 };
    for (const [id, total] of Object.entries(expected)) {
      const s = ds.studies[id]!;
      expect(s.total).toBe(total);
      expect(allocationSum(s)).toBeCloseTo(total, 2);
    }
    expect(ds.studies['CS-NWD']!.alloc['9yr_ads']).toBe(2936); // Northwood includes ADS 9-yr property
  });

  it('studyRegister recomputes the tie from the allocation (not from the stored flag) and keeps the QC result', () => {
    const reg = studyRegister(ds);
    expect(reg).toHaveLength(6);
    expect(reg.every((r) => r.ties && r.qcOk)).toBe(true);
    const noQc = structuredClone(ds);
    noQc.qc = [];
    expect(studyRegister(noQc).every((r) => r.qcOk === false)).toBe(true); // no QC evidence is not a pass
    const broken = structuredClone(ds);
    const liv = broken.studies['CS-LIV']!;
    liv.alloc['39yr'] = (liv.alloc['39yr'] ?? 0) + 1;
    expect(studyRegister(broken).find((r) => r.studyId === 'CS-LIV')!.ties).toBe(false);
  });

  it('Fishel 5-yr and 15-yr line items re-sum to the stated class totals (QC block)', () => {
    const q = (name: string) => ds.qc.find((c) => c.check === name)!;
    expect(q('FIS 5yr detail')).toMatchObject({ computed: 98458.1, expected: 98458.1, ok: true });
    expect(q('FIS 15yr detail')).toMatchObject({ computed: 161132.77, expected: 161132.77, ok: true });
    expect(ds.studies['CS-FIS']!.alloc['5yr']).toBe(98458.1);
    expect(ds.studies['CS-FIS']!.alloc['15yr']).toBe(161132.77);
  });

  it('Livingston: 3883 roof surfaces sum to 9,040 SF and GBA 9,040 + 2,240 = 11,280 SF', () => {
    const liv = ds.facts.filter((f) => f.study_id === 'CS-LIV' && f.component === 'roof');
    const v = (a: string) => liv.find((f) => f.attribute === a)!.value as number;
    expect(v('3883_aluminum_corrugated_panel') + v('3883_asphalt_shingles')).toBe(9040);
    expect(v('3875_EPDM_fully_adhered')).toBe(2240);
    expect(9040 + 2240).toBe(11280);
    expect(ds.facts.find((f) => f.study_id === 'CS-LIV' && f.attribute === 'gross_building_area')!.value).toBe(11280);
    // The roof is three surfaces — never one blended roof fact.
    expect(liv.filter((f) => /^(3883|3875)_/.test(f.attribute))).toHaveLength(3);
  });

  it('Northwood CMU wall per building is 10,368 SF (720 LF x 14.4 ft) after the OCR digit correction, not the seed 19,368', () => {
    const f = ds.facts.find((x) => x.study_id === 'CS-NWD' && x.attribute === 'CMU_wall_per_building')!;
    expect(f.value).toBe(10368);
    expect(720 * 14.4).toBeCloseTo(10368, 6);
    expect(f.note).toMatch(/Corrected 2026-10-13/);
  });

  it('proposal-sourced figures cite the proposal / contract, not the study', () => {
    for (const a of ['land_allocation_per_proposal', 'proposal_estimated_basis']) {
      for (const f of ds.facts.filter((x) => x.attribute === a)) expect(f.source_file).toMatch(/Proposal|Contract/i);
    }
  });

  it('every QC check in the dataset passes', () => {
    expect(ds.qc.every((c) => c.ok)).toBe(true);
  });
});

describe('derived / OCR / unverified flags', () => {
  it('Northwood is OCR-derived: door counts and per-building roof area are DERIVED + ocr', () => {
    const nwd = ds.facts.filter((f) => f.study_id === 'CS-NWD');
    const doors = nwd.find((f) => f.attribute === 'overhead_sectional_10x10')!;
    const roof = nwd.find((f) => f.attribute === 'roofing_area_per_building')!;
    for (const f of [doors, roof]) expect([f.confidence, f.ocr]).toEqual(['DERIVED', true]);
    expect(nwd.every((f) => f.ocr)).toBe(true); // the whole Northwood study is a scan (OCR pp.1-93 of 129)
    expect(ds.studies['CS-NWD']!.ocr).toBe(true);
    expect(ds.facts.filter((f) => f.confidence === 'DERIVED')).toHaveLength(10);
  });

  it('Fishel building facts from the property notes are labelled PROPERTY_NOTES, not the study', () => {
    const fis = ds.facts.filter((f) => f.study_id === 'CS-FIS');
    expect(fis.some((f) => sourceKind(f) === 'PROPERTY_NOTES')).toBe(true);
    expect(sourceKind(fis.find((f) => f.component === 'modeled_cost_allocation')!)).toBe('STUDY');
    expect(sourceKind(ds.facts.find((f) => f.study_id === 'CS-RAR')!)).toBe('STUDY');
  });

  it('Fishel carries dollars only for the modeled allocation (no quantities), with that stated', () => {
    const alloc = ds.facts.filter((f) => f.study_id === 'CS-FIS' && f.component === 'modeled_cost_allocation');
    expect(alloc.length).toBe(18);
    expect(alloc.every((f) => f.unit === 'USD' && /no quantities/i.test(f.note ?? ''))).toBe(true);
  });

  it('service ratings from cost seg are UNVERIFIED (template language shared by Broadway and Red Branch)', () => {
    const svc = ds.facts.filter((f) => f.component === 'electrical' && /service/i.test(f.attribute));
    expect(svc.length).toBeGreaterThan(0);
    expect(svc.every(isUnverified)).toBe(true);
    expect(isUnverified(CostSegFact.parse(fact({ component: 'electrical', attribute: 'service_rating', value: '400 A', note: null })))).toBe(true);
    expect(isUnverified(CostSegFact.parse(fact()))).toBe(false);
  });
});

describe('spec sheet', () => {
  it('groups one study into the component groups the sheet shows, in a stable order', () => {
    const sheet = specSheet(ds.facts, 'CS-RDB');
    const groups = sheet.map((g) => g.group);
    expect(groups.indexOf('Site')).toBeLessThan(groups.indexOf('Roof'));
    expect(sheet.flatMap((g) => g.facts)).toHaveLength(ds.facts.filter((f) => f.study_id === 'CS-RDB').length);
    expect(groups).toEqual(expect.arrayContaining(['Roof', 'Doors & dock', 'Paving & site improvements']));
  });

  it('tenants are history as of the study date, never a tenant record', () => {
    const t = specSheet(ds.facts, 'CS-BWY').find((g) => g.group === 'Tenants (as of study)')!;
    expect(t.facts.length).toBeGreaterThan(0);
    expect(t.facts.every((f) => /rent roll is the record/i.test(f.note ?? ''))).toBe(true);
  });
});

describe('PCA vs cost-seg quantity cross-check', () => {
  it('compareQuantity picks the same nearest value whatever the input order (ties go to the smaller)', () => {
    expect(compareQuantity(100, [98, 102])).toEqual(compareQuantity(100, [102, 98]));
    expect(compareQuantity(100, [98, 102]).nearest).toBe(98);
  });

  it('compareQuantity: match within 2%, differs otherwise, no PCA value when none', () => {
    expect(compareQuantity(11280, [10950])).toMatchObject({ status: 'differs' });
    expect(compareQuantity(11280, [11280])).toMatchObject({ status: 'match' });
    expect(compareQuantity(11280, [11100])).toMatchObject({ status: 'match' }); // 1.6%
    expect(compareQuantity(11280, [])).toMatchObject({ status: 'no-pca' });
    expect(compareQuantity(53700, [52233, 53700])).toMatchObject({ status: 'match' }); // any PCA value within tolerance
  });

  it('compareQuantity never divides by zero or trusts a non-positive quantity', () => {
    expect(compareQuantity(5, [0])).toEqual({ status: 'no-pca', nearest: null, pctDiff: null });
    expect(compareQuantity(5, [-3])).toMatchObject({ status: 'no-pca' });
    expect(compareQuantity(0, [100])).toMatchObject({ status: 'no-pca' });
    expect(compareQuantity(10, [0, 10])).toMatchObject({ status: 'match', nearest: 10 });
    expect(Number.isFinite(compareQuantity(5, [0, 4]).pctDiff ?? 0)).toBe(true);
    expect(pcaComparators([], 'e-livingston', 0).buildingSf).toEqual([]); // a register SF of 0 is "not stated"
  });

  it('a CURRENT PCA value outranks a STALE one: stale values are shown but never decide the check', () => {
    const base = { label: 'x', scoped: false };
    const pca = [{ ...base, value: 90000, vintage: 'STALE' }, { ...base, value: 84000, vintage: 'CURRENT' }];
    expect(decidingValues(pca).map((p) => p.value)).toEqual([84000]);
    const rows = crossCheck(ds.facts, 'CS-RDB', { propertyKey: 'red-branch', buildingSf: [], pavingArea: [], doors: [], roofArea: pca });
    const roof = rows.find((r) => r.metric === 'Roof area')!;
    expect(roof.status).toBe('differs'); // cost seg 90,000 vs CURRENT 84,000 — the stale 90,000 does not rescue it
    expect(roof.pca).toHaveLength(2); // both still displayed
    expect(decidingValues([{ ...base, value: 90000, vintage: 'STALE' }]).map((p) => p.value)).toEqual([90000]); // only stale exists -> used
  });

  it('door types are summed into one family total before comparing (cost seg states a count per door type)', () => {
    const rdb = crossCheck(ds.facts, 'CS-RDB', pcaComparators([], 'red-branch', null)).filter((r) => r.metric.startsWith('Overhead'));
    expect(rdb).toHaveLength(1);
    expect(rdb[0]).toMatchObject({ metric: 'Overhead / drive-in doors (total)', costSeg: 19, unit: 'EA' }); // 15 x 8x8 + 4 x 12x12
    const nwd = crossCheck(ds.facts, 'CS-NWD', pcaComparators([], 'northwood', null)).find((r) => r.metric.startsWith('Overhead'))!;
    expect(nwd.costSeg).toBe(38); // 14 + 15 + 8 (10x10) + 1 (12x12 bldg A)
    expect(nwd.confidence).toBe('DERIVED');
    const match = crossCheck(ds.facts, 'CS-RDB', { propertyKey: 'red-branch', buildingSf: [], roofArea: [], pavingArea: [], doors: [{ value: 19, label: 'x', vintage: 'CURRENT', scoped: false }] });
    expect(match.find((r) => r.metric.startsWith('Overhead'))!.status).toBe('match');
  });

  it('a per-building modeled roof is not flagged against a whole-property PCA total', () => {
    const cmp = { propertyKey: 'northwood', buildingSf: [], pavingArea: [], doors: [], roofArea: [{ value: 52233, label: 'King', vintage: 'CURRENT', scoped: false }] };
    const per = crossCheck(ds.facts, 'CS-NWD', cmp).find((r) => r.metric === 'Roof area (per building, modeled)')!;
    expect(per.status).toBe('no-pca'); // only building-level PCA values could be compared
  });

  it('flags Livingston GBA 11,280 (cost seg) vs 10,950 (PCA register) and shows both', () => {
    const cmp = pcaComparators([], 'e-livingston', 10950);
    const rows = crossCheck(ds.facts, 'CS-LIV', cmp);
    const gba = rows.find((r) => r.metric === 'Gross building area')!;
    expect(gba).toMatchObject({ costSeg: 11280, status: 'differs' });
    expect(gba.pca).toEqual([expect.objectContaining({ value: 10950 })]);
  });

  it('shows Livingston roof as three surfaces, never one blended number — and makes no match claim between them', () => {
    const rows = crossCheck(ds.facts, 'CS-LIV', pcaComparators([], 'e-livingston', 10950)).filter((r) => r.metric.startsWith('Roof'));
    expect(rows.map((r) => r.costSeg).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2240, 2962, 6078]);
    // With no PCA roof value there is nothing to compare; with PCA sections present the rows are 'not-comparable', not match/differs.
    const meta = ReportMeta.parse({
      report_id: 'R04', property_key: 'e-livingston', property_label: 'Livingston', consultant: 'AEI', report_date: '2025-04-10', inspection_date: null,
      source_file: 'x.pdf', ocr: false, draft: true, status: 'READ', path_tried: null, pages_total: 1, pages_without_text: 0, notes: '',
    });
    const raw = RawExtraction.parse({
      report_id: 'R04', coverage: { status: 'READ', pages_total: 1, pages_without_text: 0, pages_read: 1, notes: '' }, findings: [],
      facts: [
        { component: 'roof', attribute: 'area', value: 3000, unit: 'SF', scope: '3875 Office', as_of: '2025-03', source_page: 35, confidence: 'STATED', note: null },
        { component: 'roof', attribute: 'area', value: 2400, unit: 'SF', scope: '3883 Office', as_of: '2025-03', source_page: 35, confidence: 'STATED', note: null },
      ],
    });
    const cmp = pcaComparators(stampReport(meta, raw).facts, 'e-livingston', 10950);
    const withPca = crossCheck(ds.facts, 'CS-LIV', cmp).filter((r) => r.metric.startsWith('Roof'));
    expect(withPca.every((r) => r.status === 'not-comparable')).toBe(true);
    expect(withPca.every((r) => r.pca.length === 2)).toBe(true); // PCA side still listed for reference
  });

  it('whole-property PCA values decide the check; building-level values do not create a false match on a total', () => {
    const base = { value: 0, label: 'x', vintage: 'CURRENT' };
    const cmp = { propertyKey: 'northwood', roofArea: [], pavingArea: [], doors: [], buildingSf: [
      { ...base, value: 52000, scoped: false },
      { ...base, value: 53700, scoped: true }, // a single building that happens to equal the cost seg total
    ] };
    const gba = crossCheck(ds.facts, 'CS-NWD', cmp).find((r) => r.metric === 'Gross building area')!;
    expect(gba.status).toBe('differs'); // 53,700 vs 52,000 whole-property (3.3%), the scoped 53,700 is ignored
    const onlyScoped = { ...cmp, buildingSf: [{ ...base, value: 53700, scoped: true }] };
    expect(crossCheck(ds.facts, 'CS-NWD', onlyScoped).find((r) => r.metric === 'Gross building area')!.status).toBe('match');
  });

  it('uses PCA fact quantities when present and says so; a study with no PCA mapping shows no-pca', () => {
    const meta = ReportMeta.parse({
      report_id: 'R12', property_key: 'red-branch', property_label: '9050 Red Branch', consultant: 'PCI', report_date: '2015-08-12', inspection_date: null,
      source_file: 'x.pdf', ocr: false, status: 'READ', path_tried: null, pages_total: 1, pages_without_text: 0, notes: '',
    });
    const raw = RawExtraction.parse({
      report_id: 'R12', coverage: { status: 'READ', pages_total: 1, pages_without_text: 0, pages_read: 1, notes: '' }, findings: [],
      facts: [{ component: 'roof', attribute: 'area', value: 90000, unit: 'SF', scope: null, as_of: '2015-07', source_page: 5, confidence: 'STATED', note: null }],
    });
    const cmp = pcaComparators(stampReport(meta, raw).facts, 'red-branch', 89609);
    const roof = crossCheck(ds.facts, 'CS-RDB', cmp).find((r) => r.metric === 'Roof area')!;
    expect(roof).toMatchObject({ costSeg: 90000, status: 'match' });
    expect(roof.pca[0]).toMatchObject({ value: 90000 });
    expect(COST_SEG_PROPERTY_MAP['CS-FIS']).toBeNull();
    expect(COST_SEG_PROPERTY_MAP['CS-RAR']).toBeNull();
    expect(crossCheck(ds.facts, 'CS-RAR', pcaComparators([], null, null)).every((r) => r.status === 'no-pca')).toBe(true);
  });

  it('reads only; nothing in the cross-check mutates the cost seg data', () => {
    const before = JSON.stringify(ds.facts);
    crossCheck(ds.facts, 'CS-LIV', pcaComparators([], 'e-livingston', 10950));
    expect(JSON.stringify(ds.facts)).toBe(before);
  });
});

describe('quantity bridge → calibration_pending only', () => {
  const proposal = (over: Record<string, unknown> = {}): CalibrationProposal =>
    CalibrationProposal.parse({
      obs_id: 'e-fulton:roof_epdm:x:1', property: '9050 Red Branch Rd', component: 'roof_epdm', unit: 'SF', qty: null, pca_unit_cost: 5,
      pca_source: { consultant: 'PCI', report_date: '2025-01', source_file: 'f', source_date: '2025-01', price_basis: 'PCA_CONSULTANT_ESTIMATE', status: 'CURRENT' },
      contractor_unit_cost: null,
      contractor_source: { vendor: 'V', doc_date: '2026-01-01', status: 'BID', source_file: 'q', source_date: '2026-01-01', price_basis: 'CONTRACTOR_QUOTE' },
      scope_note: '', include_in_stats: true, exclusion_reason: null, proposed_at: '2026-10-13', proposed_from: 'test', ...over,
    });

  it('offers a cost seg quantity as the candidate qty on a pending proposal with none, flagged COST_SEG_MODELED', () => {
    const out = bridgeCostSegQuantities([proposal()], ds.facts);
    expect(out[0]).toMatchObject({ qty: 90000, qty_source: 'COST_SEG_MODELED' });
    expect(out[0]!.scope_note).toMatch(/cost seg/i);
  });

  it('never overwrites a stated quantity and never touches any other field (PCA / contractor values stay)', () => {
    const stated = proposal({ qty: 52500 });
    const out = bridgeCostSegQuantities([stated], ds.facts)[0]!;
    expect(out.qty).toBe(52500);
    expect(out.qty_source).toBe('STATED');
    const filled = bridgeCostSegQuantities([proposal()], ds.facts)[0]!;
    expect(filled.pca_unit_cost).toBe(5);
    expect(filled.contractor_unit_cost).toBeNull();
  });

  it('does not bridge an ambiguous scope — Livingston roof is three surfaces (open item D2)', () => {
    const liv = proposal({ property: '3875-3883 E Livingston', component: 'roof_other' });
    expect(bridgeCostSegQuantities([liv], ds.facts)[0]!.qty).toBeNull();
  });

  it('does not bridge a property with no cost seg quantity, or a non-roof/paving component', () => {
    expect(bridgeCostSegQuantities([proposal({ property: '3520 E Fulton St' })], ds.facts)[0]!.qty).toBeNull();
    expect(bridgeCostSegQuantities([proposal({ component: 'hvac' })], ds.facts)[0]!.qty).toBeNull();
  });

  it('bridges paving too (SF unit), refuses a unit mismatch, and refuses a zero / negative cost seg quantity', () => {
    const paving = bridgeCostSegQuantities([proposal({ component: 'paving_overlay', unit: 'SF' })], ds.facts)[0]!;
    expect(paving).toMatchObject({ qty: 100605, qty_source: 'COST_SEG_MODELED' });
    expect(bridgeCostSegQuantities([proposal({ component: 'paving_overlay', unit: 'SY' })], ds.facts)[0]!.qty).toBeNull();
    for (const bad of [0, -5]) {
      const zeroed = ds.facts.map((f) => (f.study_id === 'CS-RDB' && f.attribute === 'roofing_area' ? { ...f, value: bad } : f));
      expect(bridgeCostSegQuantities([proposal()], zeroed)[0]!.qty).toBeNull();
    }
  });

  it('a bridged proposal still satisfies the pending schema (qty positive) and says the area is whole-property', () => {
    const out = bridgeCostSegQuantities([proposal()], ds.facts)[0]!;
    expect(() => CalibrationProposal.parse(out)).not.toThrow();
    expect(out.scope_note).toMatch(/WHOLE-property/);
  });

  it('old ledger rows without qty_source parse as STATED; a promoted cost-seg quantity is flagged in the aggregate', () => {
    const rows = parseLedger(JSON.parse(readFileSync(join(process.cwd(), 'data', 'calibration', 'observations.json'), 'utf-8')));
    expect(rows.every((o) => o.qty_source === 'STATED')).toBe(true);
    const cand = bridgeCostSegQuantities([proposal({ contractor_unit_cost: 9 })], ds.facts);
    const promoted = promoteProposal([], cand, cand[0]!.obs_id, '2026-10-14').ledger;
    const agg = aggregateByComponent(promoted)[0]!;
    expect(agg.n).toBe(1);
    expect(agg.costSegQtyN).toBe(1);
    expect(agg.points[0]!.qtySource).toBe('COST_SEG_MODELED');
  });

  it('is pure: the pending input is not mutated and nothing reaches the ledger', () => {
    const p = proposal();
    const before = JSON.stringify(p);
    bridgeCostSegQuantities([p], ds.facts);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('only an explicit promotion turns the candidate into an observation, and it keeps the COST_SEG_MODELED tag', () => {
    const candidate = bridgeCostSegQuantities([proposal({ contractor_unit_cost: 9 })], ds.facts);
    const r = promoteProposal([], candidate, candidate[0]!.obs_id, '2026-10-14');
    expect(r.ledger).toHaveLength(1);
    expect(r.promoted.qty_source).toBe('COST_SEG_MODELED');
    expect(r.promoted.qty).toBe(90000);
  });
});

describe('open issue 9 — cost seg discrepancies D1–D14', () => {
  it('the queue now has 9 items, all Open and unassigned, #9 naming the cost seg discrepancies', () => {
    expect(PCA_ISSUES).toHaveLength(9);
    expect(PCA_ISSUES.every((i) => i.status === 'Open' && i.owner === '')).toBe(true);
    const nine = PCA_ISSUES[8]!;
    expect(nine.detail).toMatch(/D1/);
    expect(nine.detail).toMatch(/\[SPECULATIVE\]/);
    expect(nine.detail).toMatch(/Livingston/);
  });
});

describe('isolation — cost seg never feeds reserve / near-term / intensity / calibration statistics', () => {
  it('PCA reserve / near-term / calibration outputs are identical before and after the cost seg code runs over the same data', () => {
    const pcaProp = {
      propertyKey: 'e-livingston', propertyLabel: 'Livingston', propertyMasterId: null, history: [], ageYears: 1, reservesPsfYr: null, hasDollarFigures: true,
      current: { reportId: 'R04', reportDate: '2025-04-10', consultant: 'AEI', usabilityClass: 'draft' as const, usabilityRaw: null, sf: 10950, immediateUsd: 10400, shortTermUsd: 59000, reservesUninflUsd: 105330, reservesInflUsd: 118129, termYears: 12, psfYrStated: null, notes: null },
    };
    const report = { asOf: '2026-10-13', loaded: true, properties: [pcaProp], totals: { propertiesTotal: 1, propertiesWithFigures: 1, immediateUsd: 0, shortTermUsd: 0, reservesUninflUsd: 0 }, schedule: [], lifecycle: [], calibration: [], quotes: [], priceBook: [], openItems: [] };
    const ledger = parseLedger(JSON.parse(readFileSync(join(process.cwd(), 'data', 'calibration', 'observations.json'), 'utf-8')));
    const snap = () => JSON.stringify({ rollup: nearTermRollup([pcaProp]), overlay: applyPcaOverlay(report, { corrections: [], flags: {}, rentRolls: [] }).totals, calib: aggregateByComponent(ledger) });
    const before = snap();
    for (const id of Object.keys(ds.studies)) crossCheck(ds.facts, id, pcaComparators([], null, 10950));
    bridgeCostSegQuantities([], ds.facts);
    expect(snap()).toBe(before);
    expect(JSON.parse(before).rollup.totalUsd).toBe(69400); // Livingston 10,400 + 59,000 — unmoved by cost seg
  });

  it('no cost seg fact carries PCA vintage / reserve fields, and every study_id has a study record', () => {
    const f: CostSegFactT = ds.facts[0]!;
    for (const k of ['report_vintage', 'reservesUninflUsd', 'immediateUsd', 'report_id']) expect(Object.keys(f)).not.toContain(k);
    for (const x of ds.facts) expect(ds.studies[x.study_id]).toBeDefined();
  });

  it('sameProperty matches the same street number + a real name word and refuses generic words and other streets', () => {
    expect(sameProperty('2203-2207 Northwood', '2203 Marvel Rd & 2205-2207 Northwood Dr')).toBe(true);
    expect(sameProperty('9050 Red Branch Rd', '9050 Red Branch Rd, Columbia MD')).toBe(true);
    expect(sameProperty('1900 N Broadway', '1900 North Broadway, Baltimore MD')).toBe(true);
    expect(sameProperty('1000 Industrial Park Dr', '1000 Commerce Business Center')).toBe(false); // only generic words shared
    expect(sameProperty('9050 Red Branch Rd', '9051 Red Branch Rd')).toBe(false);
    expect(sameProperty('Northwood', 'Northwood Dr')).toBe(false); // no street number
  });
});
