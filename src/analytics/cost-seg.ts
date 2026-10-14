// src/analytics/cost-seg.ts
//
// Cost Segregation Property Data (module 10): engineering takeoffs and RSMeans / Marshall & Swift modeled pricing
// from the six cost segregation studies. It records quantities, system types and modeled cost for tax classification.
// It does NOT assess condition, remaining life or deferred maintenance — a cost seg value is never a condition finding.
//
// Isolation: nothing in this file feeds a reserve total, the near-term rollup, reserve intensity, a forecast, or
// calibration statistics. The price basis (COST_SEG_MODELED_RSMEANS_M&S) is a distinct enum value that the PCA and
// calibration schemas reject. Quantities may be offered as a candidate `qty` on a *pending* calibration proposal
// (bridgeCostSegQuantities); only an explicit human promotion turns that into an observation.
import { z } from 'zod';
import { CalibrationProposal } from './calibration-ledger';
import { canonicalAttribute, type SpecFactT } from './building-specs';

export const COST_SEG_BASIS = 'COST_SEG_MODELED_RSMEANS_M&S' as const;
export const COST_SEG_STUDY_IDS = ['CS-RAR', 'CS-BWY', 'CS-RDB', 'CS-NWD', 'CS-LIV', 'CS-FIS'] as const;
export const CostSegStudyId = z.enum(COST_SEG_STUDY_IDS);
export type CostSegStudyId = z.infer<typeof CostSegStudyId>;

const partialDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD');

/** study_id and as_of are required (the site-visit date); price_basis and source_type are single-valued on purpose. */
export const CostSegFact = z
  .object({
    property: z.string().min(1),
    study_id: CostSegStudyId,
    component: z.string().min(1),
    attribute: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
    unit: z.string().nullable(),
    as_of: partialDate,
    consultant: z.string().min(1),
    report_date: partialDate.nullable(),
    source_type: z.literal('COST_SEG'),
    price_basis: z.literal(COST_SEG_BASIS),
    source_file: z.string().min(1),
    source_page: z.union([z.number().int(), z.string()]).nullable(),
    ocr: z.boolean(),
    confidence: z.enum(['STATED', 'DERIVED']),
    note: z.string().nullable(),
  })
  .strict();
export type CostSegFactT = z.infer<typeof CostSegFact>;

export const CostSegStudy = z
  .object({
    property: z.string(),
    entity: z.string().optional(),
    consultant: z.string(),
    report_date: partialDate.nullable(),
    as_of: partialDate,
    method: z.string(),
    pis: z.string(),
    fee: z.number().nullable(),
    alloc: z.record(z.string(), z.number()),
    total: z.number(),
    source_file: z.string(),
    other_sources: z.array(z.string()).optional(),
    alloc_sum: z.number().optional(),
    alloc_ties: z.boolean().optional(),
    ocr: z.boolean().optional(),
  })
  .strict();
export type CostSegStudyT = z.infer<typeof CostSegStudy>;

export const CostSegDiscrepancy = z.object({ id: z.string(), property: z.string(), issue: z.string(), action: z.string() }).strict();
export const CostSegQc = z.object({ check: z.string(), computed: z.number(), expected: z.number(), ok: z.boolean() }).strict();

export const CostSegDataset = z
  .object({
    as_of: partialDate,
    price_basis: z.literal(COST_SEG_BASIS),
    schema_note: z.string(),
    studies: z.record(z.string(), CostSegStudy),
    facts: z.array(CostSegFact),
    discrepancies: z.array(CostSegDiscrepancy),
    qc: z.array(CostSegQc),
  })
  .strict();
export type CostSegDatasetT = z.infer<typeof CostSegDataset>;

export const parseCostSeg = (raw: unknown): CostSegDatasetT => CostSegDataset.parse(raw);

// ── study register ──────────────────────────────────────────────────────────────────────────

export const allocationSum = (s: Pick<CostSegStudyT, 'alloc'>): number => Object.values(s.alloc).reduce((a, b) => a + b, 0);

export interface StudyRegisterRow {
  studyId: string;
  property: string;
  consultant: string;
  reportDate: string | null;
  asOf: string;
  pis: string;
  fee: number | null;
  alloc: Record<string, number>;
  total: number;
  sum: number;
  /** Recomputed here from the allocation — never taken from the stored flag. */
  ties: boolean;
  /** Every QC check in the dataset that names this study passed. */
  qcOk: boolean;
  ocr: boolean;
}

export function studyRegister(ds: CostSegDatasetT): StudyRegisterRow[] {
  return Object.entries(ds.studies).map(([studyId, s]) => {
    const sum = allocationSum(s);
    const code = studyId.slice(3); // CS-FIS -> FIS: QC checks are named by study id or by code prefix (e.g. 'FIS 5yr detail')
    const qc = ds.qc.filter((c) => c.check === studyId || c.check.startsWith(`${code} `));
    return {
      studyId, property: s.property, consultant: s.consultant, reportDate: s.report_date, asOf: s.as_of, pis: s.pis, fee: s.fee,
      alloc: s.alloc, total: s.total, sum, ties: Math.abs(sum - s.total) < 0.005, qcOk: qc.length > 0 && qc.every((c) => c.ok), ocr: s.ocr === true,
    };
  });
}

// ── provenance flags ────────────────────────────────────────────────────────────────────────

/**
 * Every fact in the dataset is tagged with the cost seg basis, but some (Fishel's building description) were read from
 * the owner's property notes, not the study. Show that — a note is not an engineering takeoff.
 */
export function sourceKind(f: Pick<CostSegFactT, 'source_file'>): 'STUDY' | 'PROPERTY_NOTES' {
  return /property information|notes\.docx/i.test(f.source_file) ? 'PROPERTY_NOTES' : 'STUDY';
}

/** Electrical service ratings are template language until a panel schedule or utility record confirms them. */
export function isUnverified(f: Pick<CostSegFactT, 'component' | 'attribute' | 'note'>): boolean {
  if (/unverified/i.test(f.note ?? '')) return true;
  return f.component === 'electrical' && /service|feed|amp|volt/i.test(f.attribute);
}

// ── spec sheet ──────────────────────────────────────────────────────────────────────────────

const GROUP_BY_COMPONENT: Record<string, string> = {
  acquisition: 'Acquisition (as of study)', site: 'Site', structure: 'Structure', envelope: 'Envelope', roof: 'Roof',
  doors: 'Doors & dock', dock: 'Doors & dock', hvac: 'HVAC', plumbing: 'Plumbing', electrical: 'Electrical',
  fire_life_safety: 'Fire & life safety', paving: 'Paving & site improvements', interior: 'Interior', elevator: 'Elevator',
  utilities: 'Utilities', security: 'Security', unit_pattern: 'Unit pattern [DERIVED]', tenants: 'Tenants (as of study)',
  tenant: 'Tenants (as of study)', basis: 'Basis (as read)', modeled_cost_allocation: 'Modeled cost allocation (dollars only)',
};
const GROUP_ORDER = [
  'Acquisition (as of study)', 'Site', 'Structure', 'Envelope', 'Roof', 'Doors & dock', 'HVAC', 'Plumbing', 'Electrical',
  'Fire & life safety', 'Elevator', 'Paving & site improvements', 'Interior', 'Security', 'Utilities', 'Unit pattern [DERIVED]',
  'Tenants (as of study)', 'Basis (as read)', 'Modeled cost allocation (dollars only)', 'Other',
];

export interface SpecGroup {
  group: string;
  facts: CostSegFactT[];
}

export function specSheet(facts: CostSegFactT[], studyId: string): SpecGroup[] {
  const by = new Map<string, CostSegFactT[]>();
  for (const f of facts) {
    if (f.study_id !== studyId) continue;
    const g = GROUP_BY_COMPONENT[f.component] ?? 'Other';
    by.set(g, [...(by.get(g) ?? []), f]);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((group) => ({ group, facts: by.get(group) as CostSegFactT[] }));
}

// ── PCA vs cost seg quantity cross-check ────────────────────────────────────────────────────

/** Which PCA property (module 9 / register key) each study covers; null = no PCA on file. */
export const COST_SEG_PROPERTY_MAP: Record<CostSegStudyId, string | null> = {
  'CS-RAR': null, 'CS-BWY': 'n-broadway', 'CS-RDB': 'red-branch', 'CS-NWD': 'northwood', 'CS-LIV': 'e-livingston', 'CS-FIS': null,
};

export interface PcaQuantity {
  value: number;
  label: string;
  vintage: string | null;
  /** True when the PCA fact names a building / section (scope); false for whole-property values. */
  scoped: boolean;
}
export interface PcaComparators {
  propertyKey: string | null;
  buildingSf: PcaQuantity[];
  roofArea: PcaQuantity[];
  pavingArea: PcaQuantity[];
  doors: PcaQuantity[];
}

export const QUANTITY_TOLERANCE = 0.02;

export type QuantityStatus = 'match' | 'differs' | 'no-pca' | 'not-comparable';
export function compareQuantity(costSeg: number, pcaValues: number[]): { status: QuantityStatus; nearest: number | null; pctDiff: number | null } {
  // Only positive quantities are comparable: a zero / negative value is "not stated", never a divisor.
  const pca = pcaValues.filter((v) => Number.isFinite(v) && v > 0);
  if (pca.length === 0 || !(costSeg > 0)) return { status: 'no-pca', nearest: null, pctDiff: null };
  const nearest = pca.reduce((best, v) => (Math.abs(v - costSeg) < Math.abs(best - costSeg) ? v : best), pca[0] as number);
  const pctDiff = (costSeg - nearest) / nearest;
  return { status: Math.abs(nearest - costSeg) <= nearest * QUANTITY_TOLERANCE ? 'match' : 'differs', nearest, pctDiff };
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*([\d,]+(?:\.\d+)?)\s*$/.exec(v);
    if (m) return Number((m[1] as string).replace(/,/g, ''));
  }
  return null;
};

/** Pulls the PCA-side quantities for one property: the register SF plus the module-9 facts that state areas / counts. */
export function pcaComparators(specFacts: SpecFactT[], propertyKey: string | null, registerSf: number | null): PcaComparators {
  const mine = propertyKey === null ? [] : specFacts.filter((f) => f.property === propertyKey);
  const q = (f: SpecFactT, value: number, extra = ''): PcaQuantity => ({
    value, label: `${f.report_id} p.${f.source_page}${f.scope ? ` · ${f.scope}` : ''}${extra}`, vintage: f.report_vintage, scoped: f.scope !== null,
  });
  const buildingSf: PcaQuantity[] = registerSf === null || !(registerSf > 0) ? [] : [{ value: registerSf, label: 'PCA register SF', vintage: null, scoped: false }];
  const roofArea: PcaQuantity[] = [];
  const pavingArea: PcaQuantity[] = [];
  const doors: PcaQuantity[] = [];
  for (const f of mine) {
    const v = num(f.value);
    if (v === null) continue;
    if (f.component === 'site' && canonicalAttribute('site', f.attribute) === 'building_sf') buildingSf.push(q(f, v));
    else if (f.component === 'roof' && canonicalAttribute('roof', f.attribute) === 'area_sf') roofArea.push(q(f, v));
    else if (f.component === 'paving' && /area|quantity/i.test(f.attribute)) {
      const unit = (f.unit ?? '').toUpperCase();
      if (unit === 'SF') pavingArea.push(q(f, v));
      else if (unit === 'SY') pavingArea.push(q(f, v * 9, ' · SY×9'));
    } else if (f.component === 'structure' && /overhead|drive.?in/i.test(f.attribute) && (f.unit === null || /^(EA|each|doors?)$/i.test(f.unit))) doors.push(q(f, v));
  }
  return { propertyKey, buildingSf, roofArea, pavingArea, doors };
}

export interface CrossCheckRow {
  metric: string;
  costSeg: number | null;
  unit: string;
  confidence: 'STATED' | 'DERIVED';
  ocr: boolean;
  pca: PcaQuantity[];
  status: QuantityStatus;
  pctDiff: number | null;
  note: string | null;
}

const sumNumbers = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const vals = Object.values(v as Record<string, unknown>).map(num);
    return vals.every((x) => x !== null) && vals.length > 0 ? (vals as number[]).reduce((a, b) => a + b, 0) : null;
  }
  return null;
};

const SURFACE_LABEL: Record<string, string> = {
  '3883_aluminum_corrugated_panel': '3883 aluminum corrugated panel',
  '3883_asphalt_shingles': '3883 asphalt shingles',
  '3875_EPDM_fully_adhered': '3875 EPDM (fully adhered)',
};

/**
 * Which PCA values decide a check: whole-property values first; and a CURRENT / DRAFT value always outranks a STALE one
 * (stale values stay in the row for display, never for the verdict). Sectional values only when nothing else exists.
 */
export function decidingValues(pca: PcaQuantity[]): PcaQuantity[] {
  const live = pca.filter((p) => p.vintage !== 'STALE');
  const pool = live.length > 0 ? live : pca;
  return pool.some((p) => !p.scoped) ? pool.filter((p) => !p.scoped) : pool;
}

const humanize = (a: string): string => a.replace(/^(\d{4})_/, '$1 ').replace(/_/g, ' ');

/** Cost seg quantities beside the PCA's, with a flag where they differ. Read-only: nothing is adjusted. */
export function crossCheck(facts: CostSegFactT[], studyId: string, cmp: PcaComparators): CrossCheckRow[] {
  const rows: CrossCheckRow[] = [];
  const mine = facts.filter((x) => x.study_id === studyId);
  const push = (
    metric: string, costSeg: number | null, unit: string, src: CostSegFactT[], pca: PcaQuantity[], opts: { comparable?: boolean } = {},
  ) => {
    const basis = decidingValues(pca);
    const res =
      costSeg === null || !(costSeg > 0)
        ? { status: 'no-pca' as const, pctDiff: null }
        : opts.comparable === false && pca.length > 0
          ? { status: 'not-comparable' as const, pctDiff: null }
          : compareQuantity(costSeg, basis.map((p) => p.value));
    rows.push({
      metric, costSeg, unit, confidence: src.some((f) => f.confidence === 'DERIVED') ? 'DERIVED' : 'STATED', ocr: src.some((f) => f.ocr), pca,
      status: res.status, pctDiff: res.pctDiff, note: src.map((f) => f.note).filter(Boolean).join('; ') || null,
    });
  };

  for (const f of mine.filter((x) => x.component === 'site' && x.attribute === 'gross_building_area')) push('Gross building area', sumNumbers(f.value), f.unit ?? '', [f], cmp.buildingSf);

  // Roof: a single stated area is compared as a total; several surfaces (any attribute naming a roof area besides the total)
  // cannot be compared surface-by-surface against PCA sections cut differently (open item D2).
  const roofSf = mine.filter((x) => x.component === 'roof' && (x.unit ?? '').toUpperCase() === 'SF' && typeof x.value === 'number');
  const surfaces = roofSf.filter((x) => x.attribute !== 'roofing_area' && x.attribute !== 'roofing_area_per_building');
  for (const f of roofSf) {
    if (f.attribute === 'roofing_area') push('Roof area', f.value as number, 'SF', [f], cmp.roofArea, { comparable: surfaces.length === 0 });
    else if (f.attribute === 'roofing_area_per_building') {
      // A per-building modeled figure is only comparable to building-level PCA values, never to a whole-property total.
      push('Roof area (per building, modeled)', f.value as number, 'SF', [f], cmp.roofArea.filter((p) => p.scoped));
    } else push(`Roof — ${SURFACE_LABEL[f.attribute] ?? humanize(f.attribute)}`, f.value as number, 'SF', [f], cmp.roofArea, { comparable: false });
  }

  for (const f of mine.filter((x) => x.component === 'paving' && /^asphalt_parking(_drives)?$/.test(x.attribute) && (x.unit ?? '').toUpperCase() === 'SF')) {
    push('Paving area (asphalt)', sumNumbers(f.value), 'SF', [f], cmp.pavingArea);
  }

  // Doors: cost seg states counts per door type; the PCA states one overhead / drive-in count. Compare the family total.
  const doorFacts = mine.filter((x) => x.component === 'doors' && /overhead|drive_in/.test(x.attribute));
  if (doorFacts.length > 0) {
    const counts = doorFacts.map((f) => sumNumbers(f.value));
    const total = counts.every((c) => c !== null) ? (counts as number[]).reduce((a, c) => a + c, 0) : null;
    push('Overhead / drive-in doors (total)', total, 'EA', doorFacts, cmp.doors);
  }
  return rows;
}

// ── quantity bridge (pending only) ──────────────────────────────────────────────────────────

const STOP = new Set(['rd', 'road', 'ave', 'avenue', 'dr', 'drive', 'st', 'street', 'n', 'e', 's', 'w', 'ln', 'lane', 'blvd', 'llc', 'and', '&', 'industrial', 'park', 'center', 'centre', 'plaza', 'building', 'bldg', 'unit', 'suite', 'commerce', 'business', 'distribution', 'way', 'court', 'ct', 'hwy', 'highway']);
const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9 -]/g, ' ').split(/[\s]+/).filter((t) => t && !STOP.has(t));

/** Same property when the leading street number agrees and at least one name word is shared. */
export function sameProperty(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const na = ta[0];
  const nb = tb[0];
  if (!na || !nb || !/^\d/.test(na) || !/^\d/.test(nb)) return false;
  const rangesOverlap = na.split('-')[0] === nb.split('-')[0];
  return rangesOverlap && ta.slice(1).some((t) => tb.includes(t));
}

/**
 * Offers a cost seg quantity as the candidate `qty` on pending proposals that have none, flagged
 * `qty_source: COST_SEG_MODELED`. Refuses ambiguous scopes (e.g. Livingston's roof is three surfaces — open item D2),
 * never overwrites a stated quantity, and touches no other field. Pure: returns new proposals; the ledger is never an input.
 */
export function bridgeCostSegQuantities(pending: CalibrationProposal[], facts: CostSegFactT[]): CalibrationProposal[] {
  return pending.map((p) => {
    if (p.qty !== null) return p;
    const kind = p.component.startsWith('roof_') ? 'roof' : p.component.startsWith('paving_') || p.component === 'seal_stripe' ? 'paving' : null;
    if (kind === null) return p;
    const candidates = facts.filter(
      (f) =>
        sameProperty(f.property, p.property) &&
        (f.unit ?? '').toUpperCase() === p.unit &&
        typeof f.value === 'number' &&
        Number.isFinite(f.value) &&
        f.value > 0 &&
        (kind === 'roof'
          ? f.component === 'roof' && f.attribute === 'roofing_area'
          : f.component === 'paving' && /^asphalt_parking(_drives)?$/.test(f.attribute)),
    );
    if (candidates.length !== 1) return p; // none, or ambiguous
    const f = candidates[0] as CostSegFactT;
    return CalibrationProposal.parse({
      ...p,
      qty: f.value as number,
      qty_source: 'COST_SEG_MODELED',
      scope_note: `${p.scope_note} Candidate qty ${f.value as number} ${f.unit} is the cost seg modeled WHOLE-property ${kind === 'roof' ? 'roof area' : 'paving area'} (${f.study_id}, ${f.source_file}) — valid only if the priced scope is the whole ${kind === 'roof' ? 'roof' : 'paved area'}; confirm before promoting.`.trim(),
    });
  });
}
