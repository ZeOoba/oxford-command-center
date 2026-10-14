// src/analytics/building-specs.ts
//
// Building Specs & Historical Findings: every property-condition report — including stale (pre-2024) ones — loaded
// as vintage-stamped facts and findings. Each fact keeps its own as_of date and report vintage; STATED facts (read
// from the report) stay separate from DERIVED ones, and anything computed "as of today" is a [FORECAST] held in its
// own structure, never mixed into the fact list.
//
// Isolation guarantee: nothing in this module feeds a reserve total, the near-term rollup, a forecast input, or
// calibration unit costs. The findings ledger shows stale-report dollars only per row, labeled with the report year,
// and exposes no total. When a current-vintage fact covers the same component, it wins and the stale value is kept as
// history (see effectiveSpecs).
import { z } from 'zod';
import { STALE_BEFORE_YEAR } from './pca-intelligence';

export const SPEC_COMPONENTS = [
  'site', 'structure', 'roof', 'paving', 'envelope', 'hvac', 'electrical', 'plumbing', 'fire_life_safety',
  'ada', 'environmental', 'code_zoning', 'utilities', 'overall_condition',
] as const;
export const SpecComponent = z.enum(SPEC_COMPONENTS);
export type SpecComponent = z.infer<typeof SpecComponent>;
export const FindingComponent = z.enum([...SPEC_COMPONENTS, 'other']);

const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD');
export const Vintage = z.enum(['CURRENT', 'DRAFT', 'STALE']);
export type Vintage = z.infer<typeof Vintage>;
export const Confidence = z.enum(['STATED', 'DERIVED']);

/** Reports dated before this year are STALE: history only, never forecasts, rollups or calibration inputs. */
export { STALE_BEFORE_YEAR } from './pca-intelligence';

// ── raw extraction (what the extractor emitted) ─────────────────────────────────────────────

export const RawFact = z
  .object({
    component: SpecComponent,
    attribute: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    unit: z.string().nullable(),
    scope: z.string().nullable(),
    as_of: partialDate,
    source_page: z.number().int().positive(),
    confidence: Confidence,
    note: z.string().nullable(),
  })
  .strict();

export const RawFinding = z
  .object({
    component: FindingComponent,
    description: z.string().min(1),
    priority: z.string().min(1),
    estimate_usd: z.number().finite().nonnegative().nullable(),
    qty: z.number().finite().nullable(),
    unit: z.string().nullable(),
    timing: z.string().nullable(),
    scope: z.string().nullable(),
    source_page: z.number().int().positive(),
  })
  .strict();

export const RawExtraction = z
  .object({
    report_id: z.string().min(1),
    coverage: z
      .object({
        status: z.enum(['READ', 'PARTIAL', 'UNREADABLE']),
        pages_total: z.number().int().nonnegative(),
        pages_without_text: z.number().int().nonnegative(),
        pages_read: z.number().int().nonnegative(),
        notes: z.string(),
      })
      .strict(),
    facts: z.array(RawFact),
    findings: z.array(RawFinding),
  })
  .strict();
export type RawExtraction = z.infer<typeof RawExtraction>;

// ── report registry ─────────────────────────────────────────────────────────────────────────

export const ReportMeta = z
  .object({
    report_id: z.string().min(1),
    property_key: z.string().min(1),
    property_label: z.string().min(1),
    consultant: z.string().min(1),
    report_date: partialDate,
    inspection_date: partialDate.nullable(),
    source_file: z.string().min(1),
    /** The text was produced by OCR (scanned report). */
    ocr: z.boolean(),
    /** The report carries a DRAFT watermark / is not final. */
    draft: z.boolean().default(false),
    status: z.enum(['READ', 'PARTIAL', 'UNREADABLE']),
    path_tried: z.string().nullable(),
    pages_total: z.number().int().nonnegative(),
    pages_without_text: z.number().int().nonnegative(),
    notes: z.string(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.status === 'UNREADABLE' && !m.path_tried) {
      ctx.addIssue({ code: 'custom', path: ['path_tried'], message: 'an UNREADABLE report must record the path_tried' });
    }
  });
export type ReportMetaT = z.infer<typeof ReportMeta>;

const yearOf = (d: string): number => Number(d.slice(0, 4));

export function vintageFor(meta: Pick<ReportMetaT, 'report_date' | 'draft'>, draft?: boolean): Vintage {
  if (yearOf(meta.report_date) < STALE_BEFORE_YEAR) return 'STALE';
  return (draft ?? meta.draft) ? 'DRAFT' : 'CURRENT';
}

// ── stamped records ─────────────────────────────────────────────────────────────────────────

/** Required: as_of and report_vintage — a row without either is rejected. */
export const SpecFact = z
  .object({
    property: z.string().min(1),
    property_label: z.string().min(1),
    component: SpecComponent,
    attribute: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    unit: z.string().nullable(),
    scope: z.string().nullable(),
    as_of: partialDate,
    report_id: z.string().min(1),
    consultant: z.string().min(1),
    report_date: partialDate,
    report_vintage: Vintage,
    source_file: z.string().min(1),
    source_page: z.number().int().positive(),
    ocr: z.boolean(),
    confidence: Confidence,
    note: z.string().nullable(),
  })
  .strict();
export type SpecFactT = z.infer<typeof SpecFact>;

export const Finding = z
  .object({
    finding_id: z.string().min(1),
    property: z.string().min(1),
    property_label: z.string().min(1),
    report_id: z.string().min(1),
    report_year: z.number().int(),
    report_vintage: Vintage,
    component: FindingComponent,
    description: z.string().min(1),
    priority: z.string().min(1),
    estimate_usd: z.number().finite().nonnegative().nullable(),
    qty: z.number().finite().nullable(),
    unit: z.string().nullable(),
    timing: z.string().nullable(),
    scope: z.string().nullable(),
    source_file: z.string().min(1),
    source_page: z.number().int().positive(),
    ocr: z.boolean(),
  })
  .strict();
export type FindingT = z.infer<typeof Finding>;

export const Resolution = z
  .object({ finding_id: z.string().min(1), resolved_since: z.string().min(1), note: z.string().nullable() })
  .strict();
export type ResolutionT = z.infer<typeof Resolution>;

export function stampReport(meta: ReportMetaT, raw: RawExtraction): { facts: SpecFactT[]; findings: FindingT[] } {
  if (raw.report_id !== meta.report_id) throw new Error(`extraction ${raw.report_id} does not match report ${meta.report_id}`);
  const vintage = vintageFor(meta);
  const facts = raw.facts.map((f) =>
    SpecFact.parse({
      property: meta.property_key, property_label: meta.property_label, component: f.component, attribute: f.attribute,
      value: f.value, unit: f.unit, scope: f.scope, as_of: f.as_of, report_id: meta.report_id, consultant: meta.consultant,
      report_date: meta.report_date, report_vintage: vintage, source_file: meta.source_file, source_page: f.source_page,
      ocr: meta.ocr || /ocr/i.test(f.note ?? ''), confidence: f.confidence, note: f.note,
    }),
  );
  const findings = raw.findings.map((f, i) =>
    Finding.parse({
      finding_id: `${meta.report_id}-${String(i + 1).padStart(3, '0')}`, property: meta.property_key, property_label: meta.property_label,
      report_id: meta.report_id, report_year: yearOf(meta.report_date), report_vintage: vintage, component: f.component,
      description: f.description, priority: f.priority, estimate_usd: f.estimate_usd, qty: f.qty, unit: f.unit, timing: f.timing,
      scope: f.scope, source_file: meta.source_file, source_page: f.source_page, ocr: meta.ocr,
    }),
  );
  return { facts, findings };
}

// ── canonical attributes ────────────────────────────────────────────────────────────────────

/**
 * Extractors name attributes freely ("roof_type", "membrane_tpo", "year_completed"). Only the attributes the diff and
 * the rollups depend on are canonicalized; everything else keeps its raw name.
 */
export function canonicalAttribute(component: string, attribute: string): string {
  const a = attribute.toLowerCase();
  switch (component) {
    case 'roof':
      if (/^(install(ed|ation)?_year(_reported)?|year_installed|installed)$/.test(a)) return 'install_year';
      if (/^(roof_)?type$|^membrane(_.+)?$|^roof_system$|^covering(_type)?$/.test(a)) return 'type';
      if (/^(roof_)?area(_.+)?$/.test(a)) return 'area_sf';
      if (/^eul(_.+)?$|^expected_useful_life$/.test(a)) return 'eul';
      if (/^rul$|^remaining_useful_life$/.test(a)) return 'rul';
      if (/^(observed_)?condition$/.test(a)) return 'condition';
      return a;
    case 'site':
      if (/^(number_of_buildings|buildings|building_count|no_of_buildings)$/.test(a)) return 'buildings';
      if (/^(year_built|year_completed|year_of_construction)$/.test(a)) return 'year_built';
      if (/^(floor_area|gross_area|gross_building_area|net_rentable_area|net_area_sf|building_area|total_building_area|rentable_area)$/.test(a)) return 'building_sf';
      if (/^(number_of_stories|stories)$/.test(a)) return 'stories';
      if (/^(site_area|lot_size|acreage|land_area)$/.test(a)) return 'site_area';
      return a;
    case 'hvac':
      if (/^(ownership|owner)$/.test(a)) return 'ownership';
      if (/^(system_type|type|hvac_type)$/.test(a)) return 'type';
      return a;
    case 'paving':
      if (/^(paving_)?type$/.test(a)) return 'type';
      if (/^install(ed|ation)?_year$/.test(a)) return 'install_year';
      return a;
    case 'fire_life_safety':
      if (/^(sprinklers?|sprinklered|sprinkler_system|fire_suppression)$/.test(a)) return 'sprinklered';
      return a;
    default:
      return a;
  }
}

// ── effective view: current overrides stale ─────────────────────────────────────────────────

const RANK: Record<Vintage, number> = { CURRENT: 2, DRAFT: 1, STALE: 0 };
const norm = (f: SpecFactT): string => `${String(f.value).trim().toLowerCase()}|${f.unit ?? ''}`;

export interface EffectiveSpec {
  property: string;
  component: SpecComponent;
  /** Canonical attribute. */
  attribute: string;
  scope: string | null;
  effective: SpecFactT;
  /** Every other fact for the same key, newest first — kept as history, never discarded. */
  history: SpecFactT[];
  /** True when the only evidence is a stale report (render as "as reported in <year>" + [FORECAST]). */
  staleOnly: boolean;
  /** True when history holds a different value (log it for PCA_RECONCILIATION.md). */
  conflicts: boolean;
}

export function effectiveSpecs(facts: SpecFactT[]): EffectiveSpec[] {
  const groups = new Map<string, SpecFactT[]>();
  for (const f of facts) {
    const key = [f.property, f.component, canonicalAttribute(f.component, f.attribute), f.scope ?? ''].join('|');
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const out: EffectiveSpec[] = [];
  for (const g of groups.values()) {
    const ordered = [...g].sort(
      (a, b) => RANK[b.report_vintage] - RANK[a.report_vintage] || b.as_of.localeCompare(a.as_of) || b.report_date.localeCompare(a.report_date),
    );
    const effective = ordered[0] as SpecFactT;
    const history = ordered.slice(1);
    out.push({
      property: effective.property, component: effective.component, attribute: canonicalAttribute(effective.component, effective.attribute),
      scope: effective.scope, effective, history, staleOnly: effective.report_vintage === 'STALE',
      conflicts: history.some((h) => norm(h) !== norm(effective)),
    });
  }
  return out;
}

// ── projected status today [FORECAST] ───────────────────────────────────────────────────────

export interface RoofProjection {
  propertyKey: string;
  reportId: string;
  vintage: Vintage;
  scope: string | null;
  installYear: number;
  /** The year of the REPORT that stated this fact (shown first, as "as reported in <year>") — not the fact's own as_of. */
  asReportedYear: number;
  eul: number | null;
  ageToday: number;
  /** install + EUL − today; negative = past EUL. Null when the report states no EUL — nothing is assumed. */
  yearsRemaining: number | null;
  pastEul: boolean | null;
  forecast: true;
  label: '[FORECAST]';
}

const firstYear = (v: string | number | boolean): number | null => {
  const m = /\b(1[89]|20)\d{2}\b/.exec(String(v));
  return m ? Number(m[0]) : null;
};
const plainYears = (v: string | number | boolean): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const m = /^\s*(\d{1,3})\s*(?:yrs?|years?)?\s*$/i.exec(String(v));
  return m ? Number(m[1]) : null;
};

export function projectRoofs(facts: SpecFactT[], todayYear: number): RoofProjection[] {
  const byKey = new Map<string, SpecFactT[]>();
  // An EUL stated once for the whole report (no scope) applies to every roof in that report that states none of its own.
  const reportEul = new Map<string, number>();
  for (const f of facts) {
    if (f.component === 'roof' && f.scope === null && canonicalAttribute('roof', f.attribute) === 'eul') {
      const n = plainYears(f.value);
      if (n !== null) reportEul.set(`${f.property}|${f.report_id}`, n);
    }
  }
  for (const f of facts) {
    if (f.component !== 'roof') continue;
    const k = [f.property, f.report_id, f.scope ?? ''].join('|');
    const g = byKey.get(k);
    if (g) g.push(f);
    else byKey.set(k, [f]);
  }
  const rows: RoofProjection[] = [];
  for (const g of byKey.values()) {
    // One projection per install-year fact: a scope-less report section can state several roofs.
    const eulFact = g.find((f) => canonicalAttribute('roof', f.attribute) === 'eul');
    const first = g[0] as SpecFactT;
    const eul = (eulFact ? plainYears(eulFact.value) : null) ?? reportEul.get(`${first.property}|${first.report_id}`) ?? null;
    for (const inst of g.filter((f) => canonicalAttribute('roof', f.attribute) === 'install_year')) {
      const installYear = firstYear(inst.value);
      if (installYear === null) continue;
      const yearsRemaining = eul === null ? null : installYear + eul - todayYear;
      rows.push({
        propertyKey: inst.property, reportId: inst.report_id, vintage: inst.report_vintage, scope: inst.scope, installYear,
        asReportedYear: yearOf(inst.report_date), eul, ageToday: todayYear - installYear, yearsRemaining,
        pastEul: yearsRemaining === null ? null : yearsRemaining < 0, forecast: true, label: '[FORECAST]',
      });
    }
  }
  return rows.sort((a, b) => (a.yearsRemaining ?? 1e9) - (b.yearsRemaining ?? 1e9));
}

// ── findings ledger ─────────────────────────────────────────────────────────────────────────

export interface LedgerRow extends FindingT {
  /** 'UNKNOWN' until work done since is recorded in data/building-specs/resolutions.json. */
  resolved_since: string;
  resolution_note: string | null;
  /** Dollar column heading for this row — always the report year, so stale dollars are never read as current. */
  estimate_label: string;
}

/** Every finding with its original priority and estimate. Deliberately returns rows only — no totals, no sums. */
export function buildFindingsLedger(findings: FindingT[], resolutions: ResolutionT[]): LedgerRow[] {
  const byId = new Map(resolutions.map((r) => [r.finding_id, r]));
  return findings.map((f) => {
    const r = byId.get(f.finding_id);
    return {
      ...f,
      resolved_since: r?.resolved_since ?? 'UNKNOWN',
      resolution_note: r?.note ?? null,
      estimate_label: `${f.report_year} report`,
    };
  });
}

// ── cross-vintage diff ──────────────────────────────────────────────────────────────────────

export interface DiffRow {
  component: SpecComponent;
  attribute: string;
  stale: string[];
  current: string[];
  differs: boolean;
}

const DIFF_ATTRS: Array<[SpecComponent, string]> = [
  ['site', 'buildings'], ['site', 'building_sf'], ['site', 'year_built'], ['site', 'stories'], ['site', 'site_area'],
  ['roof', 'install_year'], ['roof', 'type'], ['roof', 'area_sf'], ['roof', 'eul'], ['roof', 'condition'],
  ['paving', 'type'], ['paving', 'install_year'], ['hvac', 'ownership'], ['hvac', 'type'], ['fire_life_safety', 'sprinklered'],
];

/** Plain-text number formatting: thousands separators for quantities, none for a bare year. */
export function formatSpecValue(value: string | number | boolean, unit: string | null): string {
  const isYear = typeof value === 'number' && !unit && value >= 1800 && value <= 2100;
  const v = typeof value === 'number' && !isYear ? value.toLocaleString('en-US') : String(value);
  return unit ? `${v} ${unit}` : v;
}

const show = (f: SpecFactT): string => {
  const withUnit = formatSpecValue(f.value, f.unit);
  return f.scope ? `${f.scope}: ${withUnit}` : withUnit;
};
export function crossVintageDiff(facts: SpecFactT[], propertyKey: string): DiffRow[] {
  const mine = facts.filter((f) => f.property === propertyKey);
  const stale = mine.filter((f) => f.report_vintage === 'STALE');
  const current = mine.filter((f) => f.report_vintage !== 'STALE');
  if (stale.length === 0 || current.length === 0) return [];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const rows: DiffRow[] = [];
  const pick = (set: SpecFactT[], c: SpecComponent, a: string) =>
    uniq(set.filter((f) => f.component === c && canonicalAttribute(c, f.attribute) === a).map(show));
  for (const [component, attribute] of DIFF_ATTRS) {
    const s = pick(stale, component, attribute);
    const c = pick(current, component, attribute);
    if (s.length === 0 && c.length === 0) continue;
    rows.push({ component, attribute, stale: s, current: c, differs: s.length > 0 && c.length > 0 && [...s].sort().join('|') !== [...c].sort().join('|') });
  }
  // Code / zoning items are reported as listed by each vintage.
  const codeAttrs = uniq(mine.filter((f) => f.component === 'code_zoning').map((f) => f.attribute));
  for (const attribute of codeAttrs) {
    const s = uniq(stale.filter((f) => f.component === 'code_zoning' && f.attribute === attribute).map(show));
    const c = uniq(current.filter((f) => f.component === 'code_zoning' && f.attribute === attribute).map(show));
    rows.push({ component: 'code_zoning', attribute, stale: s, current: c, differs: s.length > 0 && c.length > 0 && [...s].sort().join('|') !== [...c].sort().join('|') });
  }
  return rows;
}

// ── portfolio rollups (counts and distributions only) ───────────────────────────────────────

export interface CountRow {
  key: string;
  CURRENT: number;
  DRAFT: number;
  STALE: number;
}

function tally(items: Array<{ key: string; vintage: Vintage }>): CountRow[] {
  const m = new Map<string, CountRow>();
  for (const i of items) {
    const row = m.get(i.key) ?? { key: i.key, CURRENT: 0, DRAFT: 0, STALE: 0 };
    row[i.vintage] += 1;
    m.set(i.key, row);
  }
  return [...m.values()].sort((a, b) => b.CURRENT + b.DRAFT + b.STALE - (a.CURRENT + a.DRAFT + a.STALE) || a.key.localeCompare(b.key));
}

const ofAttr = (facts: SpecFactT[], component: SpecComponent, attribute: string) =>
  facts.filter((f) => f.component === component && canonicalAttribute(component, f.attribute) === attribute);

/** Free-text roof descriptions → a small category set, so the distribution is readable. */
export function roofTypeCategory(text: string | number | boolean): string {
  const t = String(text).toLowerCase();
  if (/tpo/.test(t)) return 'TPO';
  if (/epdm/.test(t)) return 'EPDM';
  if (/pvc|duro-?last/.test(t)) return 'PVC';
  if (/mod(ified)?[- ]?bit|apco/.test(t)) return 'Modified bitumen';
  if (/built[- ]?up|\bbur\b|gravel/.test(t)) return 'Built-up (BUR)';
  if (/metal|standing[- ]?seam|pre-?engineered/.test(t)) return 'Metal';
  if (/shingle/.test(t)) return 'Shingle';
  return 'Other / unspecified';
}

export function roofRollup(facts: SpecFactT[]): { byType: CountRow[]; byCohort: CountRow[] } {
  const byType = tally(ofAttr(facts, 'roof', 'type').map((f) => ({ key: roofTypeCategory(f.value), vintage: f.report_vintage })));
  const cohorts: Array<{ key: string; vintage: Vintage }> = [];
  for (const f of ofAttr(facts, 'roof', 'install_year')) {
    const y = firstYear(f.value);
    if (y === null) continue;
    const start = Math.floor(y / 10) * 10;
    cohorts.push({ key: `${start}–${start + 9}`, vintage: f.report_vintage });
  }
  return { byType, byCohort: tally(cohorts).sort((a, b) => a.key.localeCompare(b.key)) };
}

export function hvacOwnershipRollup(facts: SpecFactT[]): CountRow[] {
  return tally(
    ofAttr(facts, 'hvac', 'ownership').map((f) => {
      const t = String(f.value).toLowerCase();
      const tenant = /tenant/.test(t);
      const landlord = /landlord|owner(?!ship)/.test(t);
      return { key: tenant && landlord ? 'mixed' : tenant ? 'tenant' : landlord ? 'landlord' : 'unclassified', vintage: f.report_vintage };
    }),
  );
}

export function sprinklerRollup(facts: SpecFactT[]): CountRow[] {
  // Negation must sit directly on the sprinkler noun ("no automatic sprinkler system"); "no deficiencies noted with the sprinkler system" is NOT a negation.
  const NEGATED = /\b(?:no|not|without|none)\s+(?:(?:automatic|fire|wet|dry|any|fully|known|installed|present)\s+){0,3}(?:sprinkler|suppression)|unsprinklered|(?:sprinkler|suppression)[^.;]{0,40}\b(?:none(?! of)|not (?:present|provided|installed|equipped))/;
  return tally(
    ofAttr(facts, 'fire_life_safety', 'sprinklered').map((f) => {
      let key: string;
      if (typeof f.value === 'boolean') key = f.value ? 'sprinklered' : 'not sprinklered';
      else {
        const t = String(f.value).toLowerCase();
        key = NEGATED.test(t) ? 'not sprinklered' : /sprinkler|wet system|dry system/.test(t) ? 'sprinklered' : 'unclassified';
      }
      return { key, vintage: f.report_vintage };
    }),
  );
}

// ── search / filter ─────────────────────────────────────────────────────────────────────────

export interface SpecFilter {
  property?: string;
  component?: SpecComponent | string;
  vintage?: Vintage;
  text?: string;
}

export function filterFacts(facts: SpecFactT[], f: SpecFilter): SpecFactT[] {
  const q = f.text?.trim().toLowerCase();
  return facts.filter(
    (x) =>
      (!f.property || x.property === f.property) &&
      (!f.component || x.component === f.component) &&
      (!f.vintage || x.report_vintage === f.vintage) &&
      (!q || `${x.attribute} ${x.value} ${x.scope ?? ''} ${x.note ?? ''}`.toLowerCase().includes(q)),
  );
}

export function filterFindings(rows: LedgerRow[], f: SpecFilter & { unresolvedOnly?: boolean }): LedgerRow[] {
  const q = f.text?.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!f.property || r.property === f.property) &&
      (!f.component || r.component === f.component) &&
      (!f.vintage || r.report_vintage === f.vintage) &&
      (!f.unresolvedOnly || r.resolved_since === 'UNKNOWN') &&
      (!q || `${r.description} ${r.priority} ${r.scope ?? ''}`.toLowerCase().includes(q)),
  );
}

// ── coverage ────────────────────────────────────────────────────────────────────────────────

export interface CoverageRow {
  reportId: string;
  propertyLabel: string;
  consultant: string;
  reportDate: string;
  status: 'READ' | 'PARTIAL' | 'UNREADABLE';
  ocr: boolean;
  pagesTotal: number;
  pagesWithoutText: number;
  facts: number;
  findings: number;
  factsByComponent: Partial<Record<SpecComponent, number>>;
  pathTried: string | null;
  notes: string;
}

export function coverageSummary(metas: ReportMetaT[], stamped: Array<{ facts: SpecFactT[]; findings: FindingT[] }>): CoverageRow[] {
  return metas.map((m, i) => {
    const s = stamped[i] ?? { facts: [], findings: [] };
    const byComponent: Partial<Record<SpecComponent, number>> = {};
    for (const f of s.facts) byComponent[f.component] = (byComponent[f.component] ?? 0) + 1;
    return {
      reportId: m.report_id, propertyLabel: m.property_label, consultant: m.consultant, reportDate: m.report_date, status: m.status,
      ocr: m.ocr, pagesTotal: m.pages_total, pagesWithoutText: m.pages_without_text, facts: s.facts.length, findings: s.findings.length,
      factsByComponent: byComponent, pathTried: m.path_tried, notes: m.notes,
    };
  });
}
