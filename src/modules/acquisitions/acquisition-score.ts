// src/modules/acquisitions/acquisition-score.ts
//
// Client surface for the ratified Acquisition engine: POSTs an underwriting input to
// /api/warehouse/acquisition/score and returns the deterministic AcquisitionScore. Pure helpers
// (field model, prefill, input assembly) are unit-testable; the fetch mirrors hooks.ts's
// unavailability semantics (503 / non-JSON mirror → typed AcquisitionEngineUnavailable).
import type { AcquisitionInput, AcquisitionScore } from '@contracts/acquisition';
import type { Deal } from '@contracts/index';

export class AcquisitionEngineUnavailable extends Error {
  constructor(message = 'acquisition engine unavailable') {
    super(message);
    this.name = 'AcquisitionEngineUnavailable';
  }
}
export function isEngineUnavailable(e: unknown): boolean {
  return e instanceof AcquisitionEngineUnavailable;
}

/** POST an assembled input to the ratified engine. The server applies AcquisitionInput defaults, so
 *  a partial body (only dealId required) is valid — unknown fields score as indeterminate, not invalid. */
export async function scoreDealRequest(input: Record<string, unknown>): Promise<AcquisitionScore> {
  let res: Response;
  try {
    res = await fetch('/api/warehouse/acquisition/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new AcquisitionEngineUnavailable('brain server offline');
  }
  if (res.status === 503) throw new AcquisitionEngineUnavailable();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new AcquisitionEngineUnavailable('engine route not present');
  const body = (await res.json()) as { score?: AcquisitionScore; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  if (!body.score) throw new Error('malformed engine response');
  return body.score;
}

// ── Field model (drives a generic form so the JSX stays small regardless of field count) ──────────
export type FieldKind = 'usd' | 'num' | 'pct' | 'frac01' | 'select' | 'numselect' | 'tribool' | 'ddbool' | 'date';
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly { value: string; label: string }[];
  hint?: string;
}
export interface FieldGroup { title: string; fields: readonly FieldSpec[] }

const PRODUCT_TYPES = [
  'shallow-bay-multi', 'flex', 'office-warehouse', 'functional-single-tenant', 'quasi-ios', 'retail-only', 'office-only', 'other',
].map((v) => ({ value: v, label: v }));
const CLUSTER_TIERS = [
  { value: 'owned-submarket', label: 'ORA-owned submarket' }, { value: 'established', label: 'Established cluster' },
  { value: 'entry', label: 'Entry cluster' }, { value: 'satellite', label: 'Satellite (≤30 min)' }, { value: 'none', label: 'Outside clusters' },
];
const CONSTRUCTION = [
  { value: 'block-tilt-brick', label: 'Block / tilt-up / brick' }, { value: 'mixed', label: 'Mixed' },
  { value: 'pemb', label: 'All-metal PEMB' }, { value: 'unknown', label: 'Unknown' },
];
const CONFIDENCE = ['confirmed', 'estimated', 'derived'].map((v) => ({ value: v, label: v }));

export const FIELD_GROUPS: readonly FieldGroup[] = [
  { title: 'Size & Price', fields: [
    { key: 'price', label: 'Price', kind: 'usd' },
    { key: 'totalSf', label: 'Total gross SF', kind: 'num', hint: 'replacement-cost basis' },
    { key: 'maxBuildingSf', label: 'Largest building SF', kind: 'num', hint: '< 50,000 gate' },
    { key: 'isPortfolio', label: 'Portfolio (multi-building)', kind: 'tribool' },
  ] },
  { title: 'Product & Physical', fields: [
    { key: 'productType', label: 'Product type', kind: 'select', options: PRODUCT_TYPES },
    { key: 'officePct', label: 'Office %', kind: 'pct' },
    { key: 'clearHeightFt', label: 'Clear height (ft)', kind: 'num', hint: '< 12 kills' },
    { key: 'multiStory', label: 'Multi-story warehouse', kind: 'tribool' },
    { key: 'hasDock', label: 'Has dock(s)', kind: 'tribool' },
    { key: 'dockCount', label: 'Dock count', kind: 'num' },
    { key: 'hasDriveIn', label: 'Has drive-in(s)', kind: 'tribool' },
    { key: 'driveInCount', label: 'Drive-in count', kind: 'num' },
    { key: 'truckCourtFt', label: 'Truck court (ft)', kind: 'num' },
    { key: 'constructionType', label: 'Construction', kind: 'select', options: CONSTRUCTION },
    { key: 'yearBuilt', label: 'Year built', kind: 'num' },
    { key: 'sfhaOnPad', label: 'SFHA flood on pad', kind: 'tribool' },
  ] },
  { title: 'Basis · Yield · IRR', fields: [
    { key: 'allInBasis', label: 'All-in basis', kind: 'usd' },
    { key: 'replacementCostBand', label: 'Replacement-cost band', kind: 'select', options: [
      { value: 'low', label: 'Low ($125/SF)' }, { value: 'mid', label: 'Mid ($137.50/SF)' }, { value: 'high', label: 'High ($150/SF)' },
    ] },
    { key: 'stabilizedYoc', label: 'Stabilized YoC', kind: 'pct', hint: '≥ 8% floor' },
    { key: 'leveredIrr', label: 'Levered IRR', kind: 'pct', hint: '≥ 15% (5yr) / 12% (10yr)' },
    { key: 'underwriteHorizonYrs', label: 'UW horizon', kind: 'numselect', options: [{ value: '5', label: '5-year' }, { value: '10', label: '10-year' }] },
  ] },
  { title: 'Market', fields: [
    { key: 'clusterTier', label: 'Cluster tier', kind: 'select', options: CLUSTER_TIERS },
    { key: 'driveMinutesToCluster', label: 'Drive to cluster (min)', kind: 'num' },
    { key: 'marketFundamentalsAdj', label: 'Fundamentals ± (-1..1)', kind: 'num' },
    { key: 'marketFundamentalsConfidence', label: 'Fundamentals confidence', kind: 'select', options: CONFIDENCE },
    { key: 'compSourcedAt', label: 'Comps sourced at', kind: 'date', hint: '90-day freshness' },
  ] },
  { title: 'Seller · Tenancy · Value-Add', fields: [
    { key: 'sellerMotivationScore', label: 'Seller motivation (0–100)', kind: 'frac01' },
    { key: 'isVacant', label: '100% vacant', kind: 'tribool' },
    { key: 'inPlaceRentPsf', label: 'In-place rent $/SF', kind: 'num' },
    { key: 'marketRentPsf', label: 'Market rent $/SF', kind: 'num' },
    { key: 'waltYears', label: 'WALT (yrs)', kind: 'num' },
    { key: 'valueAddScore', label: 'Value-add (0–100)', kind: 'frac01' },
  ] },
  { title: 'DD-Critical resolved?', fields: [
    { key: 'dd:flood', label: 'FEMA flood', kind: 'ddbool' },
    { key: 'dd:zoning', label: 'Zoning / use', kind: 'ddbool' },
    { key: 'dd:roof', label: 'Roof age/life', kind: 'ddbool' },
    { key: 'dd:deferred-maintenance-capex', label: 'Deferred-maintenance capex', kind: 'ddbool' },
  ] },
];

export type FormState = Record<string, string>;

const num = (v: string): number | null => {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Prefill the form from a pipeline Deal's known fields (the rest the underwriter fills in). */
export function dealToForm(deal: Pick<Deal, 'sf' | 'estPrice' | 'irr' | 'holdYrs'>): FormState {
  const f: FormState = {};
  if (deal.estPrice !== null) f.price = String(deal.estPrice);
  if (deal.sf !== null) { f.totalSf = String(deal.sf); f.maxBuildingSf = String(deal.sf); }
  if (deal.irr !== null) f.leveredIrr = String(Math.round(deal.irr * 1000) / 10); // decimal → %
  if (deal.holdYrs === 5 || deal.holdYrs === 10) f.underwriteHorizonYrs = String(deal.holdYrs);
  return f;
}

/** Assemble the POST body from raw form strings, converting per field kind. Unset → omitted (server
 *  defaults to null). ddKnown is reassembled from the dd:* checkbox keys. */
export function buildInput(form: FormState, dealId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { dealId };
  const ddKnown: Record<string, boolean> = {};
  for (const group of FIELD_GROUPS) {
    for (const spec of group.fields) {
      const raw = form[spec.key];
      if (raw === undefined) continue;
      switch (spec.kind) {
        case 'usd': case 'num': { const n = num(raw); if (n !== null) out[spec.key] = n; break; }
        case 'pct': { const n = num(raw); if (n !== null) out[spec.key] = n / 100; break; }
        case 'frac01': { const n = num(raw); if (n !== null) out[spec.key] = Math.max(0, Math.min(1, n / 100)); break; }
        case 'select': { if (raw !== '') out[spec.key] = raw; break; }
        case 'numselect': { const n = num(raw); if (n !== null) out[spec.key] = n; break; }
        case 'date': { if (raw !== '') out[spec.key] = new Date(raw).toISOString(); break; }
        case 'tribool': { if (raw === 'yes') out[spec.key] = true; else if (raw === 'no') out[spec.key] = false; break; }
        case 'ddbool': { if (raw === 'true') ddKnown[spec.key.slice(3)] = true; break; }
      }
    }
  }
  if (Object.keys(ddKnown).length > 0) out.ddKnown = ddKnown;
  return out;
}

/** Persist a deal's underwriting inputs to the overlay (POST /api/actions/acquisition-input). Returns
 *  ok; a 404 (unknown/blank deal) or an offline server resolves to false rather than throwing. */
export async function saveDealInput(input: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/actions/acquisition-input', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Reverse of buildInput: a saved AcquisitionInput → editable form strings (so a persisted deal reloads). */
export function inputToForm(input: AcquisitionInput): FormState {
  const f: FormState = {};
  const rec = input as unknown as Record<string, unknown>;
  const dd = (input.ddKnown ?? {}) as Record<string, boolean | undefined>;
  for (const group of FIELD_GROUPS) {
    for (const spec of group.fields) {
      if (spec.kind === 'ddbool') {
        if (dd[spec.key.slice(3)] === true) f[spec.key] = 'true';
        continue;
      }
      const v = rec[spec.key];
      if (v === null || v === undefined) continue;
      switch (spec.kind) {
        case 'usd': case 'num': case 'numselect': case 'select': f[spec.key] = String(v); break;
        case 'pct': f[spec.key] = String(+(Number(v) * 100).toFixed(4)); break;
        case 'frac01': f[spec.key] = String(+(Number(v) * 100).toFixed(2)); break;
        case 'date': f[spec.key] = String(v).slice(0, 10); break;
        case 'tribool': f[spec.key] = v === true ? 'yes' : v === false ? 'no' : ''; break;
      }
    }
  }
  return f;
}

// ── OM field extraction client helper ────────────────────────────────────────

export interface OmExtractResult {
  fields: Record<string, string>;
  fieldCount: number;
}

export class OmExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmExtractError';
  }
}

/** POST a PDF file to the OM extraction endpoint. Returns extracted FormState-format fields.
 *  Throws OmExtractError on any failure (network, server, or extraction error). */
export async function omExtractRequest(file: File): Promise<OmExtractResult> {
  const body = new FormData();
  body.append('file', file);
  let res: Response;
  try {
    res = await fetch('/api/actions/om-extract', { method: 'POST', body });
  } catch {
    throw new OmExtractError('Could not reach the Brain server.');
  }
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    fields?: Record<string, string>;
    fieldCount?: number;
  };
  if (!res.ok || !data.ok) {
    throw new OmExtractError(data.error ?? `Extraction failed (${res.status})`);
  }
  if (!data.fields) throw new OmExtractError('Malformed extraction response.');
  return { fields: data.fields, fieldCount: data.fieldCount ?? 0 };
}
