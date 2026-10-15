// tests/unit/building-specs.test.ts
//
// Module 9 — Building Specs & Historical Findings. Vintage-stamped facts from every report (incl. stale ones),
// current-overrides-stale resolution, [FORECAST] projections kept apart from STATED facts, the findings ledger
// (stale dollars only inside it, never summed), cross-vintage diff, cohort rollups, coverage/UNREADABLE handling,
// and the isolation guarantee: stale data never enters reserve / near-term / calibration aggregates.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  RawExtraction,
  ReportMeta,
  SpecFact,
  buildFindingsLedger,
  canonicalAttribute,
  coverageSummary,
  crossVintageDiff,
  effectiveSpecs,
  filterFacts,
  hvacOwnershipRollup,
  formatSpecValue,
  projectRoofs,
  roofEulText,
  roofForecastText,
  roofRollup,
  roofTypeCategory,
  sprinklerRollup,
  stampReport,
  vintageFor,
  type ReportMetaT,
} from '../../src/analytics/building-specs';
import { buildClockRows } from '../../src/modules/property-condition/clock';
import { aggregateByComponent, CalibrationObservation } from '../../src/analytics/calibration-ledger';
import { nearTermRollup } from '../../src/analytics/pca-intelligence';

const meta = (over: Partial<ReportMetaT> = {}): ReportMetaT => ReportMeta.parse({
  report_id: 'R09', property_key: 'info-lane', property_label: '29000 Information Ln', consultant: 'PCI Consultants',
  report_date: '2016-12-07', inspection_date: '2016-12-01', source_file: 'Business/29000 Information Lane/Property Condition Assessment 12-2016.pdf',
  ocr: false, status: 'READ', path_tried: null, pages_total: 59, pages_without_text: 3, notes: '', ...over,
});
const rawFact = (over: Record<string, unknown> = {}) => ({
  component: 'roof', attribute: 'install_year', value: 2001, unit: null, scope: 'Building 2', as_of: '2016-12', source_page: 22,
  confidence: 'STATED', note: null, ...over,
});
const rawFinding = (over: Record<string, unknown> = {}) => ({
  component: 'paving', description: 'Repair drainage north lot', priority: 'Immediate', estimate_usd: 7500, qty: null, unit: null,
  timing: null, scope: null, source_page: 30, ...over,
});
const stamp = (m: ReportMetaT, facts: unknown[], findings: unknown[] = []) =>
  stampReport(m, RawExtraction.parse({ report_id: m.report_id, coverage: { status: m.status, pages_total: m.pages_total, pages_without_text: m.pages_without_text, pages_read: 1, notes: '' }, facts, findings }));

const STALE = meta();
const CURRENT = meta({
  report_id: 'R08', consultant: 'Intertek', report_date: '2025-10-29', inspection_date: '2025-10-21', pages_total: 121,
  source_file: 'Downloads/PCA-29000 Information Lane-Easton-Maryland.pdf',
});

describe('vintage + schema', () => {
  it('stamps vintage from the report: pre-2024 STALE, DRAFT stays DRAFT, else CURRENT', () => {
    expect(vintageFor(STALE, false)).toBe('STALE');
    expect(vintageFor(CURRENT, true)).toBe('DRAFT');
    expect(vintageFor(CURRENT, false)).toBe('CURRENT');
    expect(vintageFor(meta({ report_date: '2023-08-04' }), true)).toBe('STALE'); // stale beats draft
  });

  it('every stamped fact carries as_of and report_vintage plus full provenance', () => {
    const { facts } = stamp(CURRENT, [rawFact({ as_of: '2025-10' })]);
    const f = facts[0]!;
    expect(f).toMatchObject({ as_of: '2025-10', report_id: 'R08', report_vintage: 'CURRENT', source_page: 22, confidence: 'STATED', ocr: false, property: 'info-lane' });
    expect(f.source_file).toContain('29000 Information Lane');
    expect(f.report_date).toBe('2025-10-29');
  });

  it('the SpecFact schema rejects a row without as_of or report_vintage', () => {
    const good = JSON.parse(JSON.stringify(stamp(CURRENT, [rawFact({ as_of: '2025-10' })]).facts[0])) as Record<string, unknown>;
    expect(() => SpecFact.parse(good)).not.toThrow();
    const noAsOf = { ...good }; delete noAsOf.as_of;
    const noVintage = { ...good }; delete noVintage.report_vintage;
    expect(() => SpecFact.parse(noAsOf)).toThrow();
    expect(() => SpecFact.parse(noVintage)).toThrow();
  });

  it('the raw extraction schema also requires as_of and confidence on every fact', () => {
    const base = { report_id: 'R08', coverage: { status: 'READ', pages_total: 1, pages_without_text: 0, pages_read: 1, notes: '' }, findings: [] };
    expect(() => RawExtraction.parse({ ...base, facts: [{ ...rawFact(), as_of: undefined }] })).toThrow();
    expect(() => RawExtraction.parse({ ...base, facts: [{ ...rawFact(), confidence: 'GUESS' }] })).toThrow();
  });

  it('flags OCR-derived facts: report-level OCR, or an OCR note on the fact', () => {
    expect(stamp(meta({ ocr: true }), [rawFact()]).facts[0]!.ocr).toBe(true);
    expect(stamp(meta(), [rawFact({ note: 'OCR-uncertain' })]).facts[0]!.ocr).toBe(true);
    expect(stamp(meta(), [rawFact()]).facts[0]!.ocr).toBe(false);
  });
});

describe('derived vs stated stay separate', () => {
  it('DERIVED facts keep their label; projections are a separate [FORECAST] structure, never added to facts', () => {
    const { facts } = stamp(STALE, [
      rawFact({ attribute: 'install_year', value: 2001 }),
      rawFact({ attribute: 'eul', value: 40, unit: 'years' }),
      rawFact({ attribute: 'install_year', value: 2007, scope: 'Building 1', confidence: 'DERIVED', note: '2015 minus stated age' }),
    ]);
    expect(facts.filter((f) => f.confidence === 'DERIVED')).toHaveLength(1);
    const before = facts.length;
    const proj = projectRoofs(facts, 2026);
    expect(facts).toHaveLength(before); // projection did not add rows
    expect(proj.every((p) => p.forecast === true && p.label === '[FORECAST]')).toBe(true);
  });
});

describe('projectRoofs — projected status today (computed, never asserted as present condition)', () => {
  const { facts } = stamp(STALE, [
    rawFact({ scope: 'Building 2', attribute: 'install_year', value: 2001 }),
    rawFact({ scope: 'Building 2', attribute: 'eul', value: 40, unit: 'years' }),
    rawFact({ scope: 'Building 1', attribute: 'install_year', value: 2007 }),
    rawFact({ scope: 'Building 3', attribute: 'install_year', value: 1987 }),
    rawFact({ scope: 'Building 3', attribute: 'eul', value: 20, unit: 'years' }),
  ]);

  it('install year + EUL → years remaining as of today, with the as-reported year first', () => {
    const rows = projectRoofs(facts, 2026);
    const b2 = rows.find((r) => r.scope === 'Building 2')!;
    expect(b2).toMatchObject({ installYear: 2001, eul: 40, asReportedYear: 2016, ageToday: 25, yearsRemaining: 15, pastEul: false });
  });

  it('"as reported in" is the REPORT year, not the own as_of of the fact (install year 2001 in a 2016 report)', () => {
    const f = stamp(STALE, [rawFact({ scope: 'B9', attribute: 'install_year', value: 2001, as_of: '2001' })]).facts;
    expect(projectRoofs(f, 2026)[0]!.asReportedYear).toBe(2016);
  });

  it('flags a roof past its EUL', () => {
    const b3 = projectRoofs(facts, 2026).find((r) => r.scope === 'Building 3')!;
    expect(b3).toMatchObject({ yearsRemaining: -19, pastEul: true });
  });

  it('with no EUL stated the projection is null — nothing is assumed', () => {
    const b1 = projectRoofs(facts, 2026).find((r) => r.scope === 'Building 1')!;
    expect(b1.eul).toBeNull();
    expect(b1.yearsRemaining).toBeNull();
    expect(b1.pastEul).toBeNull();
  });

  it('moves with the as-of year (no hardcoded years left)', () => {
    expect(projectRoofs(facts, 2030).find((r) => r.scope === 'Building 2')!.yearsRemaining).toBe(11);
  });
});

describe('current overrides stale for the same component', () => {
  const stale = stamp(STALE, [
    rawFact({ component: 'site', attribute: 'number_of_buildings', value: 5, scope: null }),
    rawFact({ component: 'roof', attribute: 'install_year', value: 2001, scope: 'Building 2' }),
    rawFact({ component: 'hvac', attribute: 'ownership', value: 'tenant', scope: null }),
  ]).facts;
  const current = stamp(CURRENT, [
    rawFact({ component: 'site', attribute: 'number_of_buildings', value: 5, scope: null, as_of: '2025-10' }),
    rawFact({ component: 'roof', attribute: 'install_year', value: 2007, scope: 'Building 2', as_of: '2025-10' }),
  ]).facts;
  const eff = effectiveSpecs([...stale, ...current]);

  it('the current-vintage value is the effective one; the stale value is kept as history', () => {
    const roof = eff.find((e) => e.component === 'roof' && e.attribute === 'install_year')!;
    expect(roof.effective.value).toBe(2007);
    expect(roof.effective.report_vintage).toBe('CURRENT');
    expect(roof.history.map((h) => h.value)).toEqual([2001]);
    expect(roof.history[0]!.report_vintage).toBe('STALE');
  });

  it('a stale fact stands alone (flagged stale-only) when no current fact covers that component', () => {
    const hvac = eff.find((e) => e.component === 'hvac' && e.attribute === 'ownership')!;
    expect(hvac.effective.report_vintage).toBe('STALE');
    expect(hvac.staleOnly).toBe(true);
    expect(hvac.history).toHaveLength(0);
  });

  it('a stale fact never overrides a current one even if its as_of is later', () => {
    const odd = stamp(meta({ report_id: 'R99', report_date: '2019-01-01' }), [rawFact({ attribute: 'install_year', value: 1999, scope: 'Building 2', as_of: '2030' })]).facts;
    const e = effectiveSpecs([...current, ...odd]).find((x) => x.component === 'roof' && x.attribute === 'install_year')!;
    expect(e.effective.report_vintage).toBe('CURRENT');
  });

  it('differing values are reported for reconciliation', () => {
    expect(eff.find((e) => e.component === 'roof' && e.attribute === 'install_year')!.conflicts).toBe(true);
    expect(eff.find((e) => e.component === 'site' && e.attribute === 'buildings')!.conflicts).toBe(false);
  });
});

describe('canonical attributes (only the ones the diff / rollups depend on)', () => {
  it('maps vocabulary variants onto one key', () => {
    expect(canonicalAttribute('roof', 'install_year_reported')).toBe('install_year');
    expect(canonicalAttribute('roof', 'roof_type')).toBe('type');
    expect(canonicalAttribute('roof', 'membrane_tpo')).toBe('type');
    expect(canonicalAttribute('roof', 'area_epdm')).toBe('area_sf');
    expect(canonicalAttribute('site', 'number_of_buildings')).toBe('buildings');
    expect(canonicalAttribute('site', 'year_completed')).toBe('year_built');
    expect(canonicalAttribute('hvac', 'ownership')).toBe('ownership');
    expect(canonicalAttribute('roof', 'something_unusual')).toBe('something_unusual');
  });
});

describe('findings ledger', () => {
  const stale = stamp(STALE, [], [rawFinding({ estimate_usd: 7500 }), rawFinding({ description: 'Mold in basement', estimate_usd: null, priority: 'Narrative' })]).findings;
  const current = stamp(CURRENT, [], [rawFinding({ description: 'ADA van space', component: 'ada', estimate_usd: 275, priority: 'Immediate' })]).findings;

  it('keeps every finding with its original priority and dollar estimate, resolved_since UNKNOWN by default', () => {
    const rows = buildFindingsLedger([...stale, ...current], []);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.resolved_since === 'UNKNOWN')).toBe(true);
    expect(rows.find((r) => r.description === 'Repair drainage north lot')).toMatchObject({ priority: 'Immediate', estimate_usd: 7500, report_year: 2016 });
  });

  it('labels stale dollars with the report year and exposes no totals', () => {
    const rows = buildFindingsLedger([...stale, ...current], []);
    const s = rows.find((r) => r.description === 'Repair drainage north lot')!;
    expect(s.estimate_label).toBe('2016 report');
    expect(s.report_vintage).toBe('STALE');
    expect(Object.keys(rows)).not.toContain('total');
    expect(buildFindingsLedger([...stale], [])).not.toHaveProperty('total');
  });

  it('records work done since via resolutions data, with no code change', () => {
    const id = buildFindingsLedger(stale, [])[0]!.finding_id;
    const rows = buildFindingsLedger(stale, [{ finding_id: id, resolved_since: '2019-06-01', note: 'Lot repaved' }]);
    expect(rows.find((r) => r.finding_id === id)!.resolved_since).toBe('2019-06-01');
    expect(rows.filter((r) => r.resolved_since === 'UNKNOWN')).toHaveLength(1);
  });

  it('finding ids are stable and unique', () => {
    const ids = buildFindingsLedger([...stale, ...current], []).map((r) => r.finding_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildFindingsLedger(stale, []).map((r) => r.finding_id)).toEqual(buildFindingsLedger(stale, []).map((r) => r.finding_id));
  });
});

describe('cross-vintage diff (29000 Information Ln: PCI 2016 vs Intertek 2025)', () => {
  const facts = [
    ...stamp(STALE, [
      rawFact({ component: 'site', attribute: 'number_of_buildings', value: 5, scope: null }),
      rawFact({ component: 'site', attribute: 'floor_area', value: 47000, unit: 'SF', scope: null }),
      rawFact({ component: 'roof', attribute: 'roof_type', value: 'standing seam metal', scope: 'Building 2' }),
      rawFact({ component: 'hvac', attribute: 'ownership', value: 'tenant', scope: null }),
    ]).facts,
    ...stamp(CURRENT, [
      rawFact({ component: 'site', attribute: 'number_of_buildings', value: 5, scope: null, as_of: '2025-10' }),
      rawFact({ component: 'site', attribute: 'gross_area', value: 48000, unit: 'SF', scope: null, as_of: '2025-10' }),
      rawFact({ component: 'roof', attribute: 'type', value: 'metal panel', scope: 'Building 2', as_of: '2025-10' }),
    ]).facts,
  ];

  it('lists comparable attributes side by side with stale and current values and flags differences', () => {
    const d = crossVintageDiff(facts, 'info-lane');
    const bldgs = d.find((r) => r.component === 'site' && r.attribute === 'buildings')!;
    expect(bldgs).toMatchObject({ stale: ['5'], current: ['5'], differs: false });
    const sf = d.find((r) => r.component === 'site' && r.attribute === 'building_sf')!;
    expect(sf.differs).toBe(true);
    expect(sf.stale).toEqual(['47,000 SF']);
    expect(sf.current).toEqual(['48,000 SF']);
    expect(d.find((r) => r.component === 'roof' && r.attribute === 'type')!.differs).toBe(true);
  });

  it('is empty when a property has only one vintage', () => {
    expect(crossVintageDiff(stamp(STALE, [rawFact()]).facts, 'info-lane')).toEqual([]);
  });

  it('an attribute present in only one vintage is shown, not dropped', () => {
    const d = crossVintageDiff(facts, 'info-lane');
    const hv = d.find((r) => r.component === 'hvac' && r.attribute === 'ownership')!;
    expect(hv.current).toEqual([]);
    expect(hv.stale).toEqual(['tenant']);
  });
});

describe('portfolio rollups — counts and distributions only, each broken out by vintage', () => {
  const a = stamp(meta({ report_id: 'R12', property_key: 'red-branch', report_date: '2015-08-12' }), [
    rawFact({ attribute: 'roof_type', value: 'built-up', scope: 'Roof' }),
    rawFact({ attribute: 'install_year', value: 2007, scope: 'Roof' }),
    rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: 'Building is not sprinklered', scope: null }),
    rawFact({ component: 'hvac', attribute: 'ownership', value: 'Tenant-owned', scope: null }),
  ]).facts;
  const b = stamp(CURRENT, [
    rawFact({ attribute: 'type', value: 'metal panel', scope: 'B2', as_of: '2025-10' }),
    rawFact({ attribute: 'install_year', value: 2001, scope: 'B2', as_of: '2025-10' }),
    rawFact({ component: 'fire_life_safety', attribute: 'sprinklered', value: 'No automatic sprinkler system', scope: null, as_of: '2025-10' }),
    rawFact({ component: 'hvac', attribute: 'ownership', value: 'Landlord-owned', scope: null, as_of: '2025-10' }),
  ]).facts;
  const all = [...a, ...b];

  it('roof type and install-year cohort counts are split by vintage', () => {
    const r = roofRollup(all);
    expect(r.byType.find((x) => x.key === 'Built-up (BUR)')).toMatchObject({ STALE: 1, CURRENT: 0 });
    expect(r.byType.find((x) => x.key === 'Metal')).toMatchObject({ STALE: 0, CURRENT: 1 });
    expect(r.byCohort.find((x) => x.key === '2000–2009')).toMatchObject({ STALE: 1, CURRENT: 1 });
  });

  it('HVAC ownership and sprinklered-or-not are classified and split by vintage', () => {
    expect(hvacOwnershipRollup(all)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'tenant', STALE: 1, CURRENT: 0 }),
      expect.objectContaining({ key: 'landlord', STALE: 0, CURRENT: 1 }),
    ]));
    expect(sprinklerRollup(all).find((x) => x.key === 'not sprinklered')).toMatchObject({ STALE: 1, CURRENT: 1 });
  });

  it('text that cannot be classified is counted as unclassified, not guessed', () => {
    const odd = stamp(CURRENT, [rawFact({ component: 'hvac', attribute: 'ownership', value: 'see lease', scope: null, as_of: '2025-10' })]).facts;
    expect(hvacOwnershipRollup(odd).find((x) => x.key === 'unclassified')).toMatchObject({ CURRENT: 1 });
  });
});

describe('review regressions', () => {
  it('sprinkler rollup: booleans classify directly; negation must attach to the sprinkler clause', () => {
    const f = stamp(CURRENT, [
      rawFact({ component: 'fire_life_safety', attribute: 'sprinklered', value: true, scope: 'A', as_of: '2025-10' }),
      rawFact({ component: 'fire_life_safety', attribute: 'sprinklered', value: false, scope: 'B', as_of: '2025-10' }),
      rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: 'Sprinklered; Firematic and Victaulic heads, no known deficiencies', scope: 'C', as_of: '2025-10' }),
      rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: 'No sprinkler or standpipe systems in any building', scope: 'D', as_of: '2025-10' }),
    ]).facts;
    const r = sprinklerRollup(f);
    expect(r.find((x) => x.key === 'sprinklered')!.CURRENT).toBe(2); // true + 'heads, no known deficiencies'
    expect(r.find((x) => x.key === 'not sprinklered')!.CURRENT).toBe(2); // false + 'No sprinkler...'
    expect(r.find((x) => x.key === 'unclassified')).toBeUndefined();
  });

  it('sprinkler rollup: real report phrasings (R02, R06, R08) classify as not sprinklered; deficiency wording does not', () => {
    const mk = (v: string, sc: string) => rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: v, scope: sc, as_of: '2025-10' });
    const neg = ['Buildings are not equipped with automatic fire suppression (sprinkler) systems', 'Buildings are NOT equipped with automatic fire-suppression (sprinkler) systems', 'no central sprinkler system', 'Building lacks sprinklers', 'Non-sprinklered', 'Sprinklers: No'];
    const pos = ['no sprinkler heads missing', 'No sprinkler deficiencies were observed', 'Wet-pipe system; no sprinkler impairments noted', 'Fully sprinklered, without sprinkler impairments', 'Fully sprinklered; sprinkler deficiencies were not observed', 'Wet-pipe sprinkler system in good condition, leaks not observed', 'The riser lacks a current sprinkler inspection tag', 'ESFR sprinkler system; no evidence of leaking sprinkler heads', 'No visible damage to the sprinkler system', 'No leaks observed at the sprinkler piping', 'No sprinkler system impairments noted'];
    const r = sprinklerRollup(stamp(CURRENT, [...neg.map((v, i) => mk(v, `n${i}`)), ...pos.map((v, i) => mk(v, `p${i}`))]).facts);
    expect(r.find((x) => x.key === 'not sprinklered')!.CURRENT).toBe(neg.length);
    expect(r.find((x) => x.key === 'sprinklered')!.CURRENT).toBe(pos.length);
  });

  it('sprinkler rollup: a "no ..." that does not attach to the sprinkler noun is not a negation', () => {
    const f = stamp(CURRENT, [
      rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: 'No deficiencies noted with the sprinkler system', scope: 'A', as_of: '2025-10' }),
      rawFact({ component: 'fire_life_safety', attribute: 'sprinkler_system', value: 'No automatic sprinkler system', scope: 'B', as_of: '2025-10' }),
    ]).facts;
    const r = sprinklerRollup(f);
    expect(r.find((x) => x.key === 'sprinklered')!.CURRENT).toBe(1);
    expect(r.find((x) => x.key === 'not sprinklered')!.CURRENT).toBe(1);
  });

  it('projectRoofs emits one projection per install-year fact, even in a scope-less section', () => {
    const f = stamp(STALE, [
      rawFact({ scope: null, attribute: 'install_year', value: 2001 }),
      rawFact({ scope: null, attribute: 'install_year', value: 2007 }),
      rawFact({ scope: null, attribute: 'eul', value: 20, unit: 'years' }),
    ]).facts;
    const p = projectRoofs(f, 2026);
    expect(p.map((x) => x.installYear).sort()).toEqual([2001, 2007]);
    expect(p.every((x) => x.eul === 20)).toBe(true);
  });

  it('conflicting report-wide EULs are ambiguous: no single EUL, the candidates are kept and projected conservatively', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'Building A', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 30, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    const [p] = projectRoofs(f, 2026);
    expect(p).toMatchObject({ eul: null, eulAmbiguous: true, eulCandidates: [20, 30], eulMin: 20, eulMax: 30 });
    // Projected from the SHORTEST stated life (soonest replacement); the longest is kept alongside.
    expect(p).toMatchObject({ yearsRemaining: -5, yearsRemainingMax: 5 });
    // One candidate past, one not: whether it is past EUL is genuinely undecided.
    expect(p!.pastEul).toBeNull();
    expect(roofEulText(p!)).toBe('conflicting EULs 20/30 yrs');
    expect(roofForecastText(p!)).toBe('5 yrs past to 5 yrs left (conflicting EULs)');
  });

  it('issue #474: when EVERY conflicting EUL is already past, the roof is past EUL (and counts in the badge)', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: null, attribute: 'install_year', value: 2000, as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 15, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    const [p] = projectRoofs(f, 2026);
    expect(p).toMatchObject({ eul: null, eulAmbiguous: true, eulMin: 15, eulMax: 20, yearsRemaining: -11, yearsRemainingMax: -6, pastEul: true });
    expect(roofEulText(p!)).toBe('conflicting EULs 15/20 yrs');
    expect(roofForecastText(p!)).toBe('6–11 yrs past EUL (conflicting EULs)');
  });

  it('when no conflicting EUL is past yet, the roof is not past EUL and the range of years left is shown', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'A', attribute: 'install_year', value: 2020, as_of: '2025-10' }),
      rawFact({ scope: 'A', attribute: 'eul', value: 15, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'A', attribute: 'eul', value: 25, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    const [p] = projectRoofs(f, 2026);
    expect(p).toMatchObject({ pastEul: false, yearsRemaining: 9, yearsRemainingMax: 19 });
    expect(roofForecastText(p!)).toBe('9–19 yrs left (conflicting EULs)');
  });

  it('sorts an ambiguous roof by its conservative (shortest-life) projection, not last', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'Amb', attribute: 'install_year', value: 2000, as_of: '2025-10' }),
      rawFact({ scope: 'Amb', attribute: 'eul', value: 15, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'Amb', attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'Sole', attribute: 'install_year', value: 2010, as_of: '2025-10' }),
      rawFact({ scope: 'Sole', attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'None', attribute: 'install_year', value: 1990, as_of: '2025-10' }),
    ]).facts;
    expect(projectRoofs(f, 2026).map((r) => r.scope)).toEqual(['Amb', 'Sole', 'None']);
  });

  it('text for the unambiguous and no-EUL cases is unchanged', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'S', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: 'S', attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'L', attribute: 'install_year', value: 2020, as_of: '2025-10' }),
      rawFact({ scope: 'L', attribute: 'eul', value: 25, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'N', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
    ]).facts;
    const by = (s: string) => projectRoofs(f, 2026).find((r) => r.scope === s)!;
    expect([roofEulText(by('S')), roofForecastText(by('S'))]).toEqual(['20 yrs', '5 yrs past EUL']);
    expect(roofForecastText(by('L'))).toBe('19 yrs left');
    expect(by('L')).toMatchObject({ eulAmbiguous: false, eulCandidates: [25], eulMin: 25, eulMax: 25, yearsRemainingMax: 19 });
    expect([roofEulText(by('N')), roofForecastText(by('N'))]).toEqual(['not stated', 'n/a — no EUL stated']);
    expect(by('N')).toMatchObject({ eulAmbiguous: false, eulCandidates: [], eulMin: null, eulMax: null, yearsRemainingMax: null });
  });

  it('repeating the same report-wide EUL is not a conflict', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'Building A', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: '20 years', as_of: '2025-10' }),
    ]).facts;
    expect(projectRoofs(f, 2026)[0]!.eul).toBe(20);
  });

  it('two different EULs inside one scope-less section are ambiguous too', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: null, attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 30, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    expect(projectRoofs(f, 2026)[0]).toMatchObject({ eul: null, eulAmbiguous: true, eulCandidates: [20, 30] });
  });

  it("a group's own conflicting EULs still win over a single report-wide one (no fallback)", () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'A', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: 'A', attribute: 'eul', value: 20, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: 'A', attribute: 'eul', value: 30, unit: 'years', as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 40, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    expect(projectRoofs(f, 2026).find((r) => r.scope === 'A')).toMatchObject({ eulCandidates: [20, 30] });
  });

  it('a report-wide EUL (no scope) applies to scoped roofs that state none', () => {
    const f = stamp(CURRENT, [
      rawFact({ scope: 'Buildings 2, 3, 4', attribute: 'install_year', value: 2001, as_of: '2025-10' }),
      rawFact({ scope: null, attribute: 'eul', value: 40, unit: 'years', as_of: '2025-10' }),
    ]).facts;
    expect(projectRoofs(f, 2026)[0]).toMatchObject({ eul: 40, yearsRemaining: 15 });
  });

  it('buildClockRows: an overlay fact supersedes the register row by the register property key, and years left are runtime', () => {
    const schedule = [
      { propertyKey: 'easton-tech-commons', propertyLabel: 'Easton Tech Commons', component: 'Buildings / metal roofs', installFact: null, installYear: 2001, ageYears: 25, warranty: null, warrantyEndYear: null, warrantyStatus: 'unknown' as const, flag: null },
      { propertyKey: 'new-plant', propertyLabel: '55 New Plant Ct', component: 'Roof - EPDM', installFact: null, installYear: 2017, ageYears: 9, warranty: 'to 2037', warrantyEndYear: 2037, warrantyStatus: 'active' as const, flag: null },
    ];
    const extras = [{
      propertyKey: 'info-lane', propertyLabel: '29000 Information Ln', component: 'Metal-panel roof B2-B4', installYear: 2001, eul: 40, rul: null, rulAsOfYear: null,
      warrantyEndYear: null, note: null, supersedes: 'Buildings / metal roofs', supersedesPropertyKey: 'easton-tech-commons',
      provenance: { sourceFile: 'f', sourceDate: '2025-10-29', priceBasis: 'PCA_CONSULTANT_ESTIMATE' as const, status: 'DRAFT' as const },
    }];
    const rows = buildClockRows(schedule, extras, '2026-10-13');
    expect(rows.map((r) => r.component)).toEqual(['Roof - EPDM', 'Metal-panel roof B2-B4']);
    expect(rows[0]).toMatchObject({ origin: 'register', warrantyYearsRemaining: 11 });
    expect(rows[1]).toMatchObject({ origin: 'overlay', lifeYearsRemaining: 15 });
    expect(buildClockRows(schedule, extras, '2030-01-01')[0]!.warrantyYearsRemaining).toBe(7);
  });

  it('a derived overlay warranty is spelled out in the warranty text, never shown as a bare stated date', () => {
    const extras = [{
      propertyKey: 'e-fifth', propertyLabel: '3540 E Fifth Ave', component: 'Roof - TPO', installYear: 2022, eul: null, rul: null, rulAsOfYear: null,
      warrantyEndYear: 2042, note: 'Warranty end DERIVED: 20-yr term from 2022-10-21', supersedes: null,
      provenance: { sourceFile: 'f', sourceDate: '2022-10-21', priceBasis: 'CONTRACTOR_QUOTE' as const, status: 'CURRENT' as const },
    }];
    expect(buildClockRows([], extras, '2026-10-13')[0]!.warranty).toMatch(/DERIVED/);
  });
});

describe('formatting + roof categories', () => {
  it('a bare year is never comma-formatted; quantities are', () => {
    expect(formatSpecValue(2001, null)).toBe('2001');
    expect(formatSpecValue(47000, 'SF')).toBe('47,000 SF');
    expect(formatSpecValue(1500, null)).toBe('1,500'); // not a year-range number? 1500 < 1800 → quantity
  });

  it('roofTypeCategory buckets free text', () => {
    expect(roofTypeCategory('Adhered single-ply TPO, sloped')).toBe('TPO');
    expect(roofTypeCategory('Pre-engineered standing seam metal roof')).toBe('Metal');
    expect(roofTypeCategory('Conventional built-up roof (reported)')).toBe('Built-up (BUR)');
    expect(roofTypeCategory('Duro-Last PVC overlay')).toBe('PVC');
    expect(roofTypeCategory('asphalt/fiberglass tabbed shingles')).toBe('Shingle');
    expect(roofTypeCategory('flat roof')).toBe('Other / unspecified');
  });
});

describe('search / filter', () => {
  const facts = [
    ...stamp(STALE, [rawFact(), rawFact({ component: 'hvac', attribute: 'ownership', value: 'tenant', scope: null })]).facts,
    ...stamp(CURRENT, [rawFact({ as_of: '2025-10' })]).facts,
  ];
  it('filters by property, component and vintage', () => {
    expect(filterFacts(facts, { component: 'hvac' })).toHaveLength(1);
    expect(filterFacts(facts, { vintage: 'STALE' })).toHaveLength(2);
    expect(filterFacts(facts, { vintage: 'CURRENT' })).toHaveLength(1);
    expect(filterFacts(facts, { property: 'nope' })).toHaveLength(0);
    expect(filterFacts(facts, { text: 'tenant' })).toHaveLength(1);
  });
});

describe('coverage — UNREADABLE renders as such', () => {
  const metas = [
    meta({ report_id: 'R01', status: 'READ' }),
    meta({ report_id: 'R02', status: 'PARTIAL' }),
    meta({ report_id: 'R03', status: 'UNREADABLE', path_tried: 'Business/Sepich/PCA.pdf', pages_total: 0, pages_without_text: 0 }),
  ];
  const stamped = [
    stamp(metas[0]!, [rawFact(), rawFact({ component: 'hvac' })], [rawFinding()]),
    stamp(metas[1]!, [rawFact()]),
    { facts: [], findings: [] },
  ];
  const cov = coverageSummary(metas, stamped);

  it('reports read / partial / unreadable per report with counts of facts by category', () => {
    expect(cov.map((c) => c.status)).toEqual(['READ', 'PARTIAL', 'UNREADABLE']);
    expect(cov[0]!.factsByComponent).toMatchObject({ roof: 1, hvac: 1 });
    expect(cov[0]!.findings).toBe(1);
    expect(cov[2]).toMatchObject({ facts: 0, findings: 0, pathTried: 'Business/Sepich/PCA.pdf' });
  });

  it('an UNREADABLE report must record the path that was tried', () => {
    expect(() => ReportMeta.parse({ ...metas[2]!, path_tried: null })).toThrow(/path/i);
  });
});

describe('isolation — stale data never enters reserve, near-term or calibration aggregates', () => {
  it('stale facts/findings live only in the specs model: the rollup and totals functions take no spec input', () => {
    // nearTermRollup consumes PCA register properties; STALE ones are excluded and counted.
    const stalePca = { propertyKey: 'red-branch', propertyLabel: 'Red Branch', propertyMasterId: null, history: [], ageYears: 11, reservesPsfYr: null, hasDollarFigures: true, status: 'STALE' as const,
      current: { reportId: 'R12', reportDate: '2015-08-12', consultant: 'PCI', usabilityClass: 'stale' as const, usabilityRaw: null, sf: 89609, immediateUsd: 76150, shortTermUsd: null, reservesUninflUsd: 522000, reservesInflUsd: 630594, termYears: 10, psfYrStated: 0.7, notes: null } };
    const r = nearTermRollup([stalePca]);
    expect(r.totalUsd).toBe(0);
    expect(r.excludedStale).toBe(1);
  });

  it('a calibration observation whose PCA estimate is from a stale report is excluded from the aggregate', () => {
    const o = CalibrationObservation.parse({
      obs_id: 's:roof_epdm:v:1', property: 'Old', component: 'roof_epdm', unit: 'SF', qty: 28700, pca_unit_cost: 7,
      pca_source: { consultant: 'PCI', report_date: '2016-10', source_file: 'f', source_date: '2016-10', price_basis: 'PCA_CONSULTANT_ESTIMATE', status: 'STALE' },
      contractor_unit_cost: 2.85, contractor_source: { vendor: 'Bean', doc_date: '2017-02-03', status: 'EXECUTED', source_file: 'q', source_date: '2017-02-03', price_basis: 'CONTRACTOR_QUOTE' },
      scope_note: '', added_at: '2026-10-13',
    });
    const agg = aggregateByComponent([o])[0]!;
    expect(agg.n).toBe(0);
    expect(agg.excluded).toBe(1);
    expect(agg.tier).toBe('NONE');
  });
});

describe('committed extraction data', () => {
  const dir = join(process.cwd(), 'data', 'building-specs');
  const metas = (JSON.parse(readFileSync(join(dir, 'reports.json'), 'utf-8')) as unknown[]).map((m) => ReportMeta.parse(m));
  const files = readdirSync(join(dir, 'extractions')).filter((f) => f.endsWith('.json'));

  it('every extraction file validates against the strict raw schema and has a matching report record', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = RawExtraction.parse(JSON.parse(readFileSync(join(dir, 'extractions', f), 'utf-8')));
      expect(metas.some((m) => m.report_id === raw.report_id)).toBe(true);
    }
  });

  it('stamps cleanly: unique finding ids, every fact has as_of + vintage, vintages follow the report date rule', () => {
    const all = metas.map((m) => {
      const file = join(dir, 'extractions', `${m.report_id}.json`);
      return m.status === 'UNREADABLE' ? { facts: [], findings: [] } : stampReport(m, RawExtraction.parse(JSON.parse(readFileSync(file, 'utf-8'))));
    });
    const ids = all.flatMap((s) => s.findings.map((f) => f.finding_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of all) for (const f of s.facts) {
      expect(f.as_of).toBeTruthy();
      expect(['CURRENT', 'DRAFT', 'STALE']).toContain(f.report_vintage);
    }
    const r12 = all.flatMap((s) => s.facts).find((f) => f.report_id === 'R12');
    expect(r12?.report_vintage).toBe('STALE');
  });

  it('covers R01–R17 (R11 includes its photo log) — each is READ, PARTIAL or UNREADABLE with the path tried', () => {
    const ids = new Set(metas.map((m) => m.report_id));
    for (let i = 1; i <= 17; i += 1) expect(ids.has(`R${String(i).padStart(2, '0')}`)).toBe(true);
    for (const m of metas) if (m.status === 'UNREADABLE') expect(m.path_tried).toBeTruthy();
  });
});
