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
    /** obs_ids of EARLIER rows this one replaces (e.g. a real quote replacing the two placeholder range rows). Older rows are never edited; they stop counting. */
    // Tolerant on read: an older row serialized `null`, a hand edit may give one bare id.
    supersedes: z.preprocess((v) => (v == null ? [] : typeof v === 'string' ? [v] : v), z.array(z.string().min(1))).default([]),
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

/**
 * obs_id → the obs_id of the row that supersedes it. A later row supersedes only an id that already exists earlier in the
 * ledger, and only when that row itself counts toward the stats — the same rule promoteProposal enforces, applied here too
 * so a hand-edited non-counting row cannot retire counted ones.
 */
export function supersededMap(ledger: readonly CalibrationObservation[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const o of ledger) {
    if (o.supersedes.length > 0 && exclusionFor(o, out) === null) {
      for (const t of o.supersedes) if (seen.has(t) && !out.has(t)) out.set(t, o.obs_id); // first superseder wins; never re-pointed
    }
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
 * is simply excluded from stats until the data is completed (by appending a corrected row). A proposal that is the same
 * quote document (`sameQuoteDocument`) as any ledger row it does not itself supersede (live or already retired) is refused, so one document is never
 * counted twice under two obs_ids; `allowDuplicateDocument` overrides that for a genuinely separate scope on one document.
 */
export function promoteProposal(
  ledger: CalibrationObservation[],
  pending: CalibrationProposal[],
  obsId: string,
  today: string,
  supersedes?: string[],
  opts: { propertyKeyOf?: PropertyKeyOf; allowDuplicateDocument?: boolean } = {},
): PromotionResult {
  const keyOf = opts.propertyKeyOf ?? slugPropertyKey;
  const matches = pending.filter((p) => p.obs_id === obsId);
  if (matches.length === 0) throw new Error(`calibration: no pending proposal with obs_id "${obsId}"`);
  // Never pick by array order: a duplicated id means two different quotes collide, so the human must resolve it.
  if (matches.length > 1) throw new Error(`calibration: ${matches.length} pending proposals share obs_id "${obsId}" - remove the duplicate from calibration_pending.json first`);
  const proposal = matches[0]!;
  const { proposed_at: _proposedAt, proposed_from: _proposedFrom, ...rest } = proposal;
  const fields = { ...rest };
  // Apply the operator's --supersedes BEFORE the crash-recovery comparison, so re-running the identical command heals a half-finished promote.
  if (supersedes !== undefined) fields.supersedes = [...new Set(supersedes)];
  fields.supersedes = [...fields.supersedes].sort(); // order of the --supersedes arguments must not matter
  const existing = ledger.find((o) => o.obs_id === obsId);
  if (existing) {
    // Crash recovery: a prior promote appended the identical row to the ledger but died before clearing pending.
    // Only that exact case is healed (pending dropped, ledger untouched); any differing row is still refused.
    const norm = (o: CalibrationObservation): string => JSON.stringify({ ...o, supersedes: [...o.supersedes].sort() });
    const same = norm(CalibrationObservation.parse({ ...fields, added_at: existing.added_at })) === norm(existing);
    if (!same) throw new Error(`calibration: obs_id "${obsId}" already exists in the ledger (append-only)`);
    return { ledger, pending: pending.filter((p) => p.obs_id !== obsId), promoted: existing };
  }
  const retired = supersededMap(ledger);
  for (const t of fields.supersedes) {
    const target = ledger.find((o) => o.obs_id === t);
    if (!target) throw new Error(`calibration: obs_id "${obsId}" supersedes "${t}", which is not in the ledger`);
    // A mistyped target must not silently retire an unrelated observation, and a retired row is not retired twice.
    // A placeholder may be replaced across a classifier relabel inside one scope family (roof_other quote for roof_epdm range rows).
    const sameScope = target.component === fields.component || (isPlaceholder(target) && scopeFamily(target.component) === scopeFamily(fields.component));
    if (!sameScope || target.unit !== fields.unit || keyOf(target.property) !== keyOf(fields.property)) {
      throw new Error(`calibration: "${t}" is a different property / component / unit than "${obsId}" - refusing to supersede it`);
    }
    if (retired.has(t)) throw new Error(`calibration: "${t}" is already superseded by "${retired.get(t)}"`);
  }
  // A placeholder stands in for an unidentified quote document on this scope; a real counted quote beside it would count
  // that document twice (Banwick: n 3 -> 5, LIMITED -> USABLE). Checked whatever --supersedes lists (a partial supersede
  // leaves the other range row counting) and in both promote orders. Placeholder beside placeholder is allowed: a quote
  // range is entered as a pair (low end, high end).
  if (!opts.allowDuplicateDocument && exclusionFor(CalibrationObservation.parse({ ...fields, added_at: today })) === null) {
    const inScope = (o: CalibrationObservation): boolean =>
      !retired.has(o.obs_id) && !fields.supersedes.includes(o.obs_id) && scopeFamily(o.component) === scopeFamily(fields.component) && keyOf(o.property) === keyOf(fields.property);
    if (isUnidentifiedVendor(fields)) {
      const real = ledger.filter((o) => inScope(o) && !isPlaceholder(o) && exclusionFor(o, retired) === null);
      if (real.length > 0) {
        throw new Error(
          `calibration: placeholder "${obsId}" would count next to real quote row(s) for the same scope (${real.map((o) => o.obs_id).join(', ')}). ` +
            'A placeholder stands in for a quote not yet on file; if it is a separate document, pass --allow-duplicate-document',
        );
      }
    } else {
      const stand = ledger.filter((o) => inScope(o) && isPlaceholder(o));
      if (stand.length > 0) {
        throw new Error(
          `calibration: "${obsId}" would count next to placeholder row(s) for the same scope (${stand.map((o) => o.obs_id).join(', ')}). ` +
            'If it is the quote a placeholder stands in for, promote with --supersedes <placeholder obs_id> for EACH of them; if it is a separate document, pass --allow-duplicate-document',
        );
      }
    }
  }
  if (!opts.allowDuplicateDocument) {
    // Retired rows count too: a superseded document is history, and re-promoting it would count it next to its own revision.
    const twin = ledger.find((o) => !fields.supersedes.includes(o.obs_id) && sameQuoteDocument(o, fields, keyOf));
    if (twin) {
      throw new Error(
        `calibration: "${obsId}" is the same quote document (property / vendor / date) as ledger row "${twin.obs_id}" - it would be counted twice. ` +
          'If it replaces that row, promote with --supersedes; if it is a separate scope on the same document, pass --allow-duplicate-document',
      );
    }
  }
  const promoted = CalibrationObservation.parse({ ...fields, added_at: today });
  // A row that does not count itself must not retire counted rows (one no-price promote would otherwise delete both Banwick rows).
  if (promoted.supersedes.length > 0 && exclusionFor(promoted) !== null) {
    throw new Error(`calibration: "${obsId}" does not count toward the stats (${exclusionFor(promoted)}), so it cannot supersede other rows`);
  }
  return { ledger: [...ledger, promoted], pending: pending.filter((p) => p.obs_id !== obsId), promoted };
}

/** A row standing in for an unidentified or undated quote (an "Unidentified roofer" range end, a year-only date). */
export const isPlaceholder = (o: Pick<CalibrationObservation, 'contractor_source'>): boolean =>
  isUnidentifiedVendor(o) || /^\d{4}$/.test(o.contractor_source.doc_date);
/** A row ENTERED as a placeholder (no identified vendor). An identified vendor with a year-only date is a real quote when promoted. */
export const isUnidentifiedVendor = (o: Pick<CalibrationObservation, 'contractor_source'>): boolean => /^unidentified/i.test(o.contractor_source.vendor);

/** Placeholder matching tolerates a classifier relabel: every roof_* is one family, every paving_* another. */
export const scopeFamily = (c: CalibrationComponent): string => (c.startsWith('roof_') ? 'roof' : c.startsWith('paving_') ? 'paving' : c);

/** Live placeholder rows standing in for a quote on this property + scope family (shared by propose's note and promote's guard). */
export function placeholdersFor(
  ledger: readonly CalibrationObservation[],
  scope: { property: string; component: CalibrationComponent },
  propertyKeyOf: PropertyKeyOf = slugPropertyKey,
): CalibrationObservation[] {
  const retired = supersededMap(ledger);
  const key = propertyKeyOf(scope.property);
  return ledger.filter((o) => !retired.has(o.obs_id) && isPlaceholder(o) && scopeFamily(o.component) === scopeFamily(scope.component) && propertyKeyOf(o.property) === key);
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

/** Property label → stable property key. Callers with the register's alias rules pass them in (scripts/import-pca-register `resolveProperty`). */
export type PropertyKeyOf = (label: string) => string;
/** Fallback key: punctuation and case insensitive ("3520 E. Fulton St" = "3520 E Fulton St"), no alias knowledge. */
export const slugPropertyKey: PropertyKeyOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const VENDOR_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'pllc', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'lp', 'llp']);
/**
 * "REDACTED-555, Inc." / "REDACTED-555 LLC" / "REDACTED-555" → "ableroofing". Case, punctuation, spacing ("R.D." = "R. D." =
 * "R D"), apostrophes, "&" vs "and" and trailing entity suffixes are not identity. Tokens are joined with no separator so
 * spaced and unspaced initials agree.
 */
export function normalizeVendor(vendor: string): string {
  const tokens = vendor.toLowerCase().replace(/&/g, ' and ').replace(/[.'’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && VENDOR_SUFFIXES.has(tokens[tokens.length - 1] as string)) tokens.pop();
  if (tokens.length > 1 && tokens[0] === 'the') tokens.shift();
  return tokens.join('');
}

type QuoteDoc = Pick<CalibrationObservation, 'property' | 'contractor_source'>;

/**
 * THE identity of a priced quote document for de-duplication: same property (by key), same normalized vendor, and dates
 * that agree to the precision both state ("2026-05" matches "2026-05-07"). Neither component nor unit price is part of it —
 * one quote document is one observation, however an auto-classifier labels its scope and however its total divides out.
 * There is deliberately no string key: a precision-tolerant date match is not an equality, so callers compare pairwise.
 */
export function sameQuoteDocument(a: QuoteDoc, b: QuoteDoc, propertyKeyOf: PropertyKeyOf = slugPropertyKey): boolean {
  const da = a.contractor_source.doc_date;
  const db = b.contractor_source.doc_date;
  return (
    propertyKeyOf(a.property) === propertyKeyOf(b.property) &&
    normalizeVendor(a.contractor_source.vendor) === normalizeVendor(b.contractor_source.vendor) &&
    (da.startsWith(db) || db.startsWith(da))
  );
}
