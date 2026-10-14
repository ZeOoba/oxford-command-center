// src/analytics/calibration-ledger.ts
//
// Append-only calibration observation ledger: PCA consultant unit costs vs contractor unit costs on the
// SAME scope, normalized to $/unit. Rows are data (data/calibration/observations.json); everything derived —
// ratio, variance, per-component n / median / min / max / tier — is computed here and NEVER stored, so adding
// a quote or award is a data change, never a code change.
//
// Price Basis firewall: the PCA estimate and the contractor price are separate fields end to end. Nothing here
// blends them into a benchmark or an average, nothing overwrites a PCA unit cost with a contractor price, and
// nothing applies a ratio to a reserve — this module is informational only.
import { z } from 'zod';
import { STALE_BEFORE_YEAR } from './pca-intelligence';

export const CALIBRATION_COMPONENTS = [
  'roof_tpo', 'roof_epdm', 'roof_metal', 'roof_other', 'paving_overlay', 'paving_full_depth',
  'seal_stripe', 'exterior_paint', 'sealants', 'hvac', 'other',
] as const;
export const CalibrationComponent = z.enum(CALIBRATION_COMPONENTS);
export type CalibrationComponent = z.infer<typeof CalibrationComponent>;

export const CalibrationUnit = z.enum(['SF', 'SY', 'LF', 'LS']);
export type CalibrationUnit = z.infer<typeof CalibrationUnit>;

export const ContractorStatus = z.enum(['BID', 'SIGNED', 'EXECUTED']);
export type ContractorStatus = z.infer<typeof ContractorStatus>;

const isoDate = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'expected YYYY, YYYY-MM or YYYY-MM-DD');
const unitCost = z.number().finite().nonnegative().nullable();

/** Every figure's source carries file / date / price basis / status — provenance lives in the data. */
export const PcaSource = z
  .object({
    consultant: z.string().min(1),
    report_date: isoDate,
    source_file: z.string().min(1),
    source_date: isoDate,
    price_basis: z.literal('PCA_CONSULTANT_ESTIMATE'),
    status: z.enum(['CURRENT', 'DRAFT', 'STALE']),
  })
  .strict();
export type PcaSource = z.infer<typeof PcaSource>;

export const ContractorSource = z
  .object({
    vendor: z.string().min(1),
    doc_date: isoDate,
    /** BID = unsigned quote or budget; SIGNED = awarded / signed contract; EXECUTED = work completed. */
    status: ContractorStatus,
    source_file: z.string().min(1),
    source_date: isoDate,
    price_basis: z.enum(['CONTRACTOR_QUOTE', 'CONTRACTOR_ACTUAL']),
  })
  .strict();
export type ContractorSource = z.infer<typeof ContractorSource>;

/** `.strict()` is load-bearing: a stored `ratio` / `variance_pct` is rejected — they are derived, never stored. */
export const CalibrationObservation = z
  .object({
    obs_id: z.string().min(1),
    property: z.string().min(1),
    component: CalibrationComponent,
    unit: CalibrationUnit,
    /** Quantity of the CONTRACTOR-priced scope. Null = not in any source → excluded from stats. */
    qty: z.number().finite().positive().nullable(),
    /** STATED = from a PCA / quote / workbook; COST_SEG_MODELED = a cost seg takeoff a human confirmed at promotion. */
    qty_source: z.enum(['STATED', 'COST_SEG_MODELED']).default('STATED'),
    pca_unit_cost: unitCost,
    pca_source: PcaSource,
    contractor_unit_cost: unitCost,
    contractor_source: ContractorSource,
    scope_note: z.string(),
    include_in_stats: z.boolean().default(true),
    exclusion_reason: z.string().nullable().default(null),
    /** obs_id of an EARLIER row this one replaces (e.g. a real quote replacing a placeholder). The older row is never edited; it stops counting. */
    supersedes: z.string().nullable().default(null),
    /** Date this row entered the ledger (drives the "what changed" line). */
    added_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type CalibrationObservation = z.infer<typeof CalibrationObservation>;

/** A proposed pair awaiting human review. Same shape as an observation minus `added_at`, plus how it was found. */
export const CalibrationProposal = CalibrationObservation.omit({ added_at: true }).extend({
  proposed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  proposed_from: z.string().min(1),
}).strict();
export type CalibrationProposal = z.infer<typeof CalibrationProposal>;

export const parseLedger = (raw: unknown): CalibrationObservation[] => z.array(CalibrationObservation).parse(raw);
export const parsePending = (raw: unknown): CalibrationProposal[] => z.array(CalibrationProposal).parse(raw);

// ── derived values (never stored) ───────────────────────────────────────────────────────────

/** contractor ÷ PCA unit cost; null unless both are present and positive (a $0 quote is a placeholder, not a price). */
export function ratio(o: Pick<CalibrationObservation, 'pca_unit_cost' | 'contractor_unit_cost'>): number | null {
  if (o.pca_unit_cost === null || o.contractor_unit_cost === null || o.pca_unit_cost <= 0 || o.contractor_unit_cost <= 0) return null;
  return o.contractor_unit_cost / o.pca_unit_cost;
}

/** ratio − 1 (e.g. −0.60 = contractor 60% below the PCA estimate). */
export function variancePct(o: Pick<CalibrationObservation, 'pca_unit_cost' | 'contractor_unit_cost'>): number | null {
  const r = ratio(o);
  return r === null ? null : r - 1;
}

/**
 * Stats eligibility: opted in, a PCA estimate from a non-stale report, a stated quantity, a per-unit (not lump-sum) basis, and both unit costs present.
 * Rows failing this stay visible in the ledger — they just do not count toward n.
 */
export function exclusionFor(o: CalibrationObservation, supersededBy: ReadonlyMap<string, string> = new Map()): string | null {
  const newer = supersededBy.get(o.obs_id);
  if (newer !== undefined) return `superseded by ${newer} — kept as history, not counted`;
  if (!o.include_in_stats) return o.exclusion_reason ?? 'excluded by reviewer';
  // Stale (pre-2024) reports are history only — they never feed calibration unit costs, whatever the row says.
  const pcaYear = Number(o.pca_source.report_date.slice(0, 4));
  if (o.pca_source.status === 'STALE' || pcaYear < STALE_BEFORE_YEAR) return 'PCA estimate is from a stale (pre-2024) report — kept as history, not a calibration input';
  if (o.qty === null) return 'quantity not stated in any source';
  if (o.unit === 'LS') return 'lump sum — not normalizable to $/unit';
  if (ratio(o) === null) return 'missing unit cost on one side';
  return null;
}
export const includedInStats = (o: CalibrationObservation, supersededBy: ReadonlyMap<string, string> = new Map()): boolean => exclusionFor(o, supersededBy) === null;

/** obs_id → the obs_id of the row that supersedes it. A later row supersedes only an id that already exists earlier in the ledger. */
export function supersededMap(ledger: readonly CalibrationObservation[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const o of ledger) {
    if (o.supersedes !== null && seen.has(o.supersedes)) out.set(o.supersedes, o.obs_id);
    seen.add(o.obs_id);
  }
  return out;
}

export type ConfidenceTier = 'NONE' | 'THIN' | 'LIMITED' | 'USABLE';
/** n=0 NONE · n=1 THIN · n=2–4 LIMITED · n≥5 USABLE. Recomputed on every call. */
export function tierFor(n: number): ConfidenceTier {
  if (n <= 0) return 'NONE';
  if (n === 1) return 'THIN';
  if (n < 5) return 'LIMITED';
  return 'USABLE';
}
export const isDirectionalOnly = (t: ConfidenceTier): boolean => t === 'THIN' || t === 'LIMITED';
export const MEAN_MIN_N = 5;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface CalibrationPoint {
  obsId: string;
  property: string;
  ratio: number;
  variancePct: number;
  contractorStatus: ContractorStatus;
  /** COST_SEG_MODELED = the quantity behind this row is a cost seg takeoff a person confirmed at promotion. */
  qtySource: 'STATED' | 'COST_SEG_MODELED';
}

export interface ComponentAggregate {
  component: CalibrationComponent;
  /** Observations that count toward the statistics. */
  n: number;
  /** Rows present for this component but excluded (null qty, LS, reviewer opt-out, missing cost). */
  excluded: number;
  tier: ConfidenceTier;
  directionalOnly: boolean;
  medianRatio: number | null;
  minRatio: number | null;
  maxRatio: number | null;
  /** Shown only when n ≥ 5; otherwise null — a mean of 2 or 3 points is not a statistic. */
  meanRatio: number | null;
  points: CalibrationPoint[];
  /** How many counted points rest on a cost-seg-modeled quantity (promoted by a person, but flagged). */
  costSegQtyN: number;
}

/** Per-component aggregates, in the enum's order. Components with no rows at all are omitted. */
export function aggregateByComponent(ledger: CalibrationObservation[]): ComponentAggregate[] {
  const out: ComponentAggregate[] = [];
  const superseded = supersededMap(ledger);
  for (const component of CALIBRATION_COMPONENTS) {
    const rows = ledger.filter((o) => o.component === component);
    if (rows.length === 0) continue;
    const included = rows.filter((o) => includedInStats(o, superseded));
    const points: CalibrationPoint[] = included.map((o) => ({
      obsId: o.obs_id,
      property: o.property,
      ratio: ratio(o) as number,
      variancePct: variancePct(o) as number,
      contractorStatus: o.contractor_source.status,
      qtySource: o.qty_source,
    }));
    const ratios = points.map((p) => p.ratio);
    const n = ratios.length;
    const tier = tierFor(n);
    out.push({
      component,
      n,
      excluded: rows.length - n,
      tier,
      directionalOnly: isDirectionalOnly(tier),
      medianRatio: median(ratios),
      minRatio: n ? Math.min(...ratios) : null,
      maxRatio: n ? Math.max(...ratios) : null,
      meanRatio: n >= MEAN_MIN_N ? ratios.reduce((a, b) => a + b, 0) / n : null,
      points,
      costSegQtyN: points.filter((p) => p.qtySource === 'COST_SEG_MODELED').length,
    });
  }
  return out;
}

/** The most recently added observation (ties broken by ledger order, later wins). */
export function latestObservation(ledger: CalibrationObservation[]): CalibrationObservation | null {
  let best: CalibrationObservation | null = null;
  for (const o of ledger) if (best === null || o.added_at >= best.added_at) best = o;
  return best;
}

export interface UnderwritingUse {
  usable: CalibrationComponent[];
  notUsable: CalibrationComponent[];
  note: string;
}

/** Which components have ≥ USABLE n. Informational: no reserve or underwriting figure is adjusted by any ratio. */
export function underwritingUse(aggs: ComponentAggregate[]): UnderwritingUse {
  const usable = aggs.filter((a) => a.tier === 'USABLE').map((a) => a.component);
  const notUsable = aggs.filter((a) => a.tier !== 'USABLE').map((a) => a.component);
  const note =
    usable.length === 0
      ? 'No component has n ≥ 5, so none is usable for underwriting. Every ratio here is directional only.'
      : `Components with n ≥ 5: ${usable.join(', ')}. All others remain directional only.`;
  return { usable, notUsable, note };
}

// ── promotion (pending → observation) ───────────────────────────────────────────────────────

export interface PromotionResult {
  ledger: CalibrationObservation[];
  pending: CalibrationProposal[];
  promoted: CalibrationObservation;
}

/**
 * Explicit, human-triggered promotion. Append-only: never edits an existing observation, refuses a duplicate
 * obs_id, and removes the proposal from pending. A proposal with a null quantity or cost can be promoted — it
 * is simply excluded from stats until the data is completed (by appending a corrected row).
 */
export function promoteProposal(
  ledger: CalibrationObservation[],
  pending: CalibrationProposal[],
  obsId: string,
  today: string,
): PromotionResult {
  const matches = pending.filter((p) => p.obs_id === obsId);
  if (matches.length === 0) throw new Error(`calibration: no pending proposal with obs_id "${obsId}"`);
  // Never pick by array order: a duplicated id means two different quotes collide, so the human must resolve it.
  if (matches.length > 1) throw new Error(`calibration: ${matches.length} pending proposals share obs_id "${obsId}" - remove the duplicate from calibration_pending.json first`);
  const proposal = matches[0]!;
  const { proposed_at: _proposedAt, proposed_from: _proposedFrom, ...fields } = proposal;
  const existing = ledger.find((o) => o.obs_id === obsId);
  if (existing) {
    // Crash recovery: a prior promote appended the identical row to the ledger but died before clearing pending.
    // Only that exact case is healed (pending dropped, ledger untouched); any differing row is still refused.
    const same = JSON.stringify(CalibrationObservation.parse({ ...fields, added_at: existing.added_at })) === JSON.stringify(existing);
    if (!same) throw new Error(`calibration: obs_id "${obsId}" already exists in the ledger (append-only)`);
    return { ledger, pending: pending.filter((p) => p.obs_id !== obsId), promoted: existing };
  }
  if (fields.supersedes !== null && !ledger.some((o) => o.obs_id === fields.supersedes)) {
    throw new Error(`calibration: obs_id "${obsId}" supersedes "${fields.supersedes}", which is not in the ledger`);
  }
  const promoted = CalibrationObservation.parse({ ...fields, added_at: today });
  return { ledger: [...ledger, promoted], pending: pending.filter((p) => p.obs_id !== obsId), promoted };
}

// ── candidate-pair matching (pure; I/O lives in scripts/calibration-propose.ts) ──────────────

/** Map free-text system / scope names onto the component enum. Order matters (most specific first). */
export function classifyComponent(text: string): CalibrationComponent {
  const t = text.toLowerCase();
  if (/tpo/.test(t)) return 'roof_tpo';
  if (/epdm/.test(t)) return 'roof_epdm';
  if (/metal.*roof|roof.*metal|standing.?seam/.test(t)) return 'roof_metal';
  if (/roof/.test(t)) return 'roof_other';
  if (/mill.*overlay/.test(t)) return 'paving_overlay';
  if (/full.?depth/.test(t)) return 'paving_full_depth';
  if (/seal.*(stripe|coat)|re-?stripe/.test(t)) return 'seal_stripe';
  if (/paint/.test(t)) return 'exterior_paint';
  if (/sealant|joint/.test(t)) return 'sealants';
  if (/hvac|rtu|condens|packaged|split/.test(t)) return 'hvac';
  return 'other';
}

/**
 * Identity of a priced quote document for de-duplication: property + vendor + document date. Neither component nor
 * unit price is part of the key — one quote document is one observation, however an auto-classifier labels its scope
 * and however its total divides out.
 */
export const pairKey = (o: Pick<CalibrationObservation, 'property' | 'contractor_source'>): string =>
  [o.property.toLowerCase(), o.contractor_source.vendor.toLowerCase(), o.contractor_source.doc_date].join('|');
