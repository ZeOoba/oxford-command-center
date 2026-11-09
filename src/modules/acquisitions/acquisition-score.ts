// src/modules/acquisitions/acquisition-score.ts
//
// Client surface for the ratified Acquisition engine: POSTs an underwriting input to
// /api/warehouse/acquisition/score and returns the deterministic AcquisitionScore. Pure helpers
// (field model, prefill, input assembly) are unit-testable; the fetch mirrors hooks.ts's
// unavailability semantics (503 / non-JSON mirror → typed AcquisitionEngineUnavailable).
import type { AcquisitionInput, AcquisitionScore } from '@contracts/acquisition';
import type { Deal } from '@contracts/index';
import { RCT_V03 } from '../../brain/replacement-cost';
import { ORA_CLIENT_HEADERS, ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';

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
      headers: ORA_JSON_MUTATION_HEADERS,
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
/** Form keys `use:<flag>` assemble into AcquisitionInput.use (an object), like `dd:<item>` into ddKnown. */
const USE_PREFIX = 'use:';

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
// Markets with a replacement-cost row (RCT v03). The engine divides the Basis floor/score by THIS market's
// LOW; with no market it silently uses the strictest (cheapest-market) fallback, so the form must carry it
// (OI-356: no live path used to send `market`, so every UI-scored deal scored on the fallback).
const MARKET_OPTIONS = Object.keys(RCT_V03).map((m) => ({ value: m, label: m }));

export const FIELD_GROUPS: readonly FieldGroup[] = [
  { title: 'Size & Price', fields: [
    { key: 'market', label: 'Market (sets replacement cost)', kind: 'select', options: MARKET_OPTIONS, hint: 'blank = strictest fallback' },
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
  // Other-use kill screen (audit 2026-11-08): the engine caps the verdict at T2 while any of these is unknown.
  { title: 'Other-Use Kill Screen', fields: [
    { key: 'groundLeased', label: 'Ground-leased', kind: 'tribool', hint: 'No = fee simple' },
    { key: 'groundLeaseYearsRemaining', label: 'Ground lease yrs remaining', kind: 'num' },
    { key: 'envRemediationPctOfPrice', label: 'Env remediation % of price', kind: 'pct', hint: '0 = Phase I clean' },
    { key: 'use:automotive', label: 'Automotive use', kind: 'tribool' },
    { key: 'use:childRelated', label: 'Child-related use', kind: 'tribool' },
    { key: 'use:childSafetyReviewed', label: 'Child-safety reviewed', kind: 'tribool' },
  ] },
  { title: 'Basis · Yield · IRR', fields: [
    { key: 'allInBasis', label: 'All-in basis', kind: 'usd' },
    // No replacement-cost band selector: the field it set (`replacementCostBand`) is DORMANT — the
    // engine's Basis floor/score divisor is HARDCODED to the per-market RCT v03 LOW (2026-07-14
    // refute fix; see server/warehouse/acquisition.ts `rcBand`). Its option labels also asserted the
    // retired flat $125/$137.50/$150 table, superseded by the per-market RCT v03 (ratified 2026-07-14).
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
export function dealToForm(
  deal: Pick<Deal, 'sf' | 'estPrice' | 'irr' | 'holdYrs'> & { market?: Deal['market'] | null; buildings?: Deal['buildings'] | undefined },
): FormState {
  const f: FormState = {};
  // Only a market that has an RCT row is prefilled; anything else stays blank (strictest fallback), never guessed.
  if (deal.market && Object.prototype.hasOwnProperty.call(RCT_V03, deal.market)) f.market = deal.market;
  if (deal.estPrice !== null) f.price = String(deal.estPrice);
  // Deal.sf is the TOTAL SF; the size gate tests the LARGEST SINGLE building (audit 2026-11-08,
  // dealtoform-portfolio-sf-false-kill: a 3 x 30K portfolio was KILLED as one 90K building). A Deal carries no
  // per-building SF, so the largest building is known only when the deal is ONE building. For a portfolio, or an
  // unknown building count, it stays blank: the engine caps that at T2 until the underwriter enters it, never a KILL.
  // Known trade-off (refute 2026-11-08): while blank, the engine's Cat-3 clear-height band falls back to the smallest
  // (most lenient) band (acquisition.ts `maxBuildingSf ?? 0`), so the T2-capped composite can read high until entered.
  if (deal.sf !== null) {
    f.totalSf = String(deal.sf);
    if (deal.buildings === 1) f.maxBuildingSf = String(deal.sf);
  }
  // Portfolio status drives the price cap (single asset vs portfolio); set only when the building count is known. The
  // portfolio cap is doctrine for a 2-5 building portfolio sold together (acquisition-underwriting Amendment H); the
  // ruleset carries no building-count bound, so a larger count is left for the underwriter rather than prefilled 'yes'.
  // Blank reaches the engine as null (unknown, tri-state since refute wf_6e927240-7cc): a price between the single-asset
  // and portfolio caps then caps at T2 instead of KILLing on the single-asset cap.
  if (deal.buildings === 1) f.isPortfolio = 'no';
  else if (typeof deal.buildings === 'number' && deal.buildings >= 2 && deal.buildings <= 5) f.isPortfolio = 'yes';
  if (deal.irr !== null) f.leveredIrr = String(Math.round(deal.irr * 1000) / 10); // decimal → %
  if (deal.holdYrs === 5 || deal.holdYrs === 10) f.underwriteHorizonYrs = String(deal.holdYrs);
  return f;
}

/** Assemble the POST body from raw form strings, converting per field kind. Unset → omitted (server
 *  defaults to null). ddKnown is reassembled from the dd:* checkbox keys. */
export function buildInput(form: FormState, dealId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { dealId };
  const ddKnown: Record<string, boolean> = {};
  const useBits: Record<string, boolean> = {};
  for (const group of FIELD_GROUPS) {
    for (const spec of group.fields) {
      const raw = form[spec.key];
      if (raw === undefined) continue;
      if (spec.key.startsWith(USE_PREFIX)) {
        if (raw === 'yes') useBits[spec.key.slice(USE_PREFIX.length)] = true;
        else if (raw === 'no') useBits[spec.key.slice(USE_PREFIX.length)] = false;
        continue;
      }
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
  const use = assembleUse(useBits);
  if (use !== null) out.use = use;
  // Tenure "No (fee simple)" means there is no ground lease, so a leftover term in the form (e.g. from an earlier OM pass)
  // is not sent: otherwise the engine, which always tests a supplied term, would KILL a fee-simple deal on stale state.
  if (out.groundLeased === false) delete out.groundLeaseYearsRemaining;
  return out;
}

/**
 * Assemble AcquisitionInput.use (one object of three booleans) from the three `use:*` tri-state answers.
 *  - A KILL already determined by the answers given (automotive = yes, or child-related = yes AND safety review = no)
 *    is ALWAYS sent, whatever else is blank: a confirmed disqualifier must never be dropped to "unknown". The blank
 *    fields are filled with false; they cannot change a KILL, and inputToForm does not reload them (see killingUseFlags).
 *  - Otherwise `use` is sent only when the screen is complete: automotive answered, and child-related answered with,
 *    when child-related = yes, the safety review answered. Anything less stays unknown (the engine caps at T2) and is
 *    never turned into a KILL by reading a blank safety-review field as "not reviewed".
 */
function assembleUse(b: Record<string, boolean>): { automotive: boolean; childRelated: boolean; childSafetyReviewed: boolean } | null {
  const automotiveKill = b.automotive === true;
  const childKill = b.childRelated === true && b.childSafetyReviewed === false;
  const filled = { automotive: b.automotive === true, childRelated: b.childRelated === true, childSafetyReviewed: b.childSafetyReviewed === true };
  if (childKill) return filled;
  if (automotiveKill) {
    // The child questions only stay on a stored automotive KILL when fully answered; an incomplete child screen is stored
    // as not-child-related, so childRelated=yes never sits next to a filled-in review=false that reload would show.
    const childComplete = b.childRelated === false || (b.childRelated === true && b.childSafetyReviewed !== undefined);
    return childComplete ? filled : { automotive: true, childRelated: false, childSafetyReviewed: false };
  }
  const childScreened = b.childRelated === false || (b.childRelated === true && b.childSafetyReviewed !== undefined);
  return b.automotive !== undefined && childScreened ? filled : null;
}

// ACCEPTED TRADE-OFF (refute wf_5337efe6-574, correctness lens): a stored automotive KILL reloads ONLY the automotive flag.
// assembleUse stores an incomplete child screen on an automotive KILL as childRelated:false, so a confirmed child answer
// cannot be told apart from a filled-in one; both are dropped on reload. If the user then clears the automotive KILL,
// `use` is unknown (T2 cap) until the child questions are answered again: extra re-entry, never a fabricated pass.
// Nothing else displays the stored use flags (no IC memo / export reads use.childRelated), so the fill is never shown as "no".
function storedUseFormValue(use: AcquisitionInput['use'], flag: string): boolean | undefined {
  if (!use) return undefined;
  const kill = killingUseFlags(use);
  // childSafetyReviewed means nothing when the use is not child-related: its stored false is a fill, never reloaded.
  if (flag === 'childSafetyReviewed' && !use.childRelated) return undefined;
  if (kill === null) return (use as Record<string, boolean>)[flag];
  if (flag === 'automotive') return kill.automotive ? true : undefined;
  return kill.child ? (use as Record<string, boolean>)[flag] : undefined;
}

/** Which `use` flags are decisive for a KILL on a stored input (null when `use` is not a KILL). */
function killingUseFlags(use: AcquisitionInput['use']): { automotive: boolean; child: boolean } | null {
  if (!use) return null;
  const automotive = use.automotive;
  const child = use.childRelated && !use.childSafetyReviewed;
  return automotive || child ? { automotive, child } : null;
}

/** Persist a deal's underwriting inputs to the overlay (POST /api/actions/acquisition-input). Returns
 *  ok; a 404 (unknown/blank deal) or an offline server resolves to false rather than throwing. */
export async function saveDealInput(input: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/actions/acquisition-input', {
      method: 'POST', headers: ORA_JSON_MUTATION_HEADERS, body: JSON.stringify(input),
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
      // A stored KILL `use` may carry blank answers filled with false (assembleUse): reload ONLY the decisive flags, so a
      // filled-in false never reappears as a confirmed "no" that a later edit could turn into a clean screen.
      const v = spec.key.startsWith(USE_PREFIX)
        ? storedUseFormValue(input.use, spec.key.slice(USE_PREFIX.length))
        : rec[spec.key];
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
  // A stored market with no RCT row (the save route accepts any string) cannot be shown by the select and
  // would silently score on the fallback: load it blank rather than misleading the underwriter.
  if (f.market !== undefined && !Object.prototype.hasOwnProperty.call(RCT_V03, f.market)) delete f.market;
  return f;
}

// ── OM field extraction client helper ────────────────────────────────────────

export interface OmExtractResult {
  fields: Record<string, string>;
  fieldCount: number;
  rawText?: string;
  savedPath?: string;
}

export class OmExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmExtractError';
  }
}

/** POST a PDF file to the OM extraction endpoint. Returns extracted FormState-format fields.
 *  Throws OmExtractError on any failure (network, server, or extraction error). */
export async function omExtractRequest(file: File, dealId?: string): Promise<OmExtractResult> {
  const body = new FormData();
  body.append('file', file);
  if (dealId) body.append('dealId', dealId);
  const controller = new AbortController();
  // 55s: must exceed the server's own 45s Anthropic-call timeout (om-extract.ts) plus margin for
  // this request's own upload + PDF-parse time — a shorter client timeout aborts (and shows the
  // user an error for) a request the server is still processing to a real, billed completion.
  const timeoutId = setTimeout(() => controller.abort(), 55_000);
  let res: Response;
  try {
    // No content-type here on purpose: the browser sets the multipart boundary. ORA_CLIENT_HEADERS
    // still marks it as a first-party write (server/host-guard.ts).
    res = await fetch('/api/actions/om-extract', { method: 'POST', headers: ORA_CLIENT_HEADERS, body, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new OmExtractError('Extraction timed out. Please try again.');
    }
    throw new OmExtractError('Could not reach the Brain server.');
  } finally {
    clearTimeout(timeoutId);
  }
  type OmExtractResponse = { ok?: boolean; error?: string; fields?: Record<string, string>; fieldCount?: number; rawText?: string; savedPath?: string };
  let data: OmExtractResponse;
  try {
    data = (await res.json()) as OmExtractResponse;
  } catch {
    throw new OmExtractError(`Extraction failed (${res.status})`);
  }
  if (!res.ok || !data.ok) {
    throw new OmExtractError(data.error ?? `Extraction failed (${res.status})`);
  }
  if (!data.fields) throw new OmExtractError('Malformed extraction response.');
  return { fields: data.fields, fieldCount: data.fieldCount ?? 0, rawText: data.rawText, savedPath: data.savedPath };
}

/** Fill a still-blank Market from the pipeline deal (saved inputs predate the Market field, so
 *  inputToForm alone leaves it empty and the deal would rescore on the strictest fallback). Never
 *  overrides a market the underwriter already chose. */
export function applyDealMarket(form: FormState, deal: (Pick<Deal, 'sf'> & { market?: Deal['market'] | null }) | null | undefined): FormState {
  if (form.market || !deal?.market || !Object.prototype.hasOwnProperty.call(RCT_V03, deal.market)) return form;
  return { ...form, market: deal.market };
}

/** The engine's replacement-cost DENOMINATOR notes (market not supplied / not priced -> strictest fallback;
 *  [PROXY] -> DENOMINATOR-SENSITIVE, local quote pre-LOI). They live in score.dataQuality, which no panel
 *  rendered, so with the Market select a verdict could flip to passing on a proxy denominator with nothing
 *  on screen saying the skill's local-quote rule applies (refute wf_f6699a8b-92b). Surface them. */
export function denominatorNotes(score: Pick<AcquisitionScore, 'dataQuality'>): string[] {
  return score.dataQuality
    .filter((d) => d.field === 'replacementCost' && /PROXY|not supplied|not in /.test(d.issue))
    .map((d) => d.issue);
}
