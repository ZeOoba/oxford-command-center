// src/analytics/governor-inputs.ts
//
// Blank governor inputs on Spine A (audit 2026-11-12 HIGH #2, `spine-a-debt-noi-blank-to-zero`).
//
// The Property contract carries noi / debtService / loanBalance as plain numbers, and the workbook
// parser coerces a blank cell to 0 so every non-governor surface keeps working. A blank on a
// LEVERED row is not a zero, though. A blank loan balance drops that loan out of aggregate LTV
// (falsely clears). A blank debt service drops the property out of the levered DSCR set (falsely
// clears). A blank NOI enters DSCR as $0 (false breach). So server/workbook/parse.ts tags each
// such blank with a warn-level DataQualityFlag on the property, and every governor surface reads
// it through this module and FAILS CLOSED: an unknown input yields an incomplete (null) governor
// figure, never a placeholder verdict either way.
//
// Mechanism only: no governor constant is read or restated here (Invariant 4).
import { namesAffiliateLender } from './debt-basis';

/** `DataQualityFlag.field` for a blank governor input; `rawValue` names the Property field. */
export const GOVERNOR_INPUT_BLANK_FIELD = 'governorInputBlank';

export const GOVERNOR_INPUT_FIELDS = ['noi', 'debtService', 'loanBalance'] as const;
export type GovernorInputField = (typeof GOVERNOR_INPUT_FIELDS)[number];

/** `DataQualityFlag.field` (info) for a row whose Lender column names a lender but whose debt
 *  cells carry no figure at all. Lender text alone is not leverage evidence (refute wf_406ad3ef-7de:
 *  free-text notes like 'Unlevered' blanked both portfolio governors), so the row is not flagged
 *  blank; this note asks for the debt figures to be filled or the lender cell cleared. */
export const GOVERNOR_LENDER_NO_FIGURES_FIELD = 'governorLenderNoFigures';

/** Display text for a blank governor input on per-property surfaces — never "$0". */
export const BLANK_IN_WORKBOOK = '— (blank in workbook)';

/** The field's value, or null when the workbook cell was blank / unknown (parse flag). */
export function governorFieldValue<T extends Flagged & Record<GovernorInputField, number>>(p: T, field: GovernorInputField): number | null {
  return hasBlankGovernorInput(p, field) ? null : p[field];
}

/** Workbook column label per field, for flag text. */
export const GOVERNOR_INPUT_LABEL: Record<GovernorInputField, string> = {
  noi: 'NOI',
  debtService: 'Debt Service',
  loanBalance: 'Loan Balance',
};

const isGovernorInputField = (v: unknown): v is GovernorInputField =>
  typeof v === 'string' && (GOVERNOR_INPUT_FIELDS as readonly string[]).includes(v);

interface Flagged {
  /** Optional: a legacy payload (or a hand-built fixture) may carry no flags array at all. */
  readonly flags?: readonly { readonly field: string; readonly rawValue?: string | undefined }[];
}

/** The governor inputs this property's workbook row left blank (parse-time flags), in field order. */
export function blankGovernorInputs(p: Flagged): GovernorInputField[] {
  const hit = new Set<GovernorInputField>();
  for (const f of p.flags ?? []) {
    if (f.field === GOVERNOR_INPUT_BLANK_FIELD && isGovernorInputField(f.rawValue)) hit.add(f.rawValue);
  }
  return GOVERNOR_INPUT_FIELDS.filter((k) => hit.has(k));
}

export const hasBlankGovernorInput = (p: Flagged, field?: GovernorInputField): boolean => {
  const blanks = blankGovernorInputs(p);
  return field === undefined ? blanks.length > 0 : blanks.includes(field);
};

export interface IncompleteGovernorRow {
  id: string;
  name: string;
  fields: GovernorInputField[];
}

const byId = (x: { id: string }, y: { id: string }): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * Rows whose blank input makes the portfolio DSCR aggregate (Σ NOI / Σ debt service over the levered
 * set) uncomputable: a blank Debt Service (the row may belong in the set), or a blank NOI on a row
 * that IS in the set or may be (debt service positive or itself blank). A blank NOI on a row whose
 * Debt Service was entered as 0 never enters the aggregate, so it does not block it (refute
 * wf_fe0c7b48-326). Affiliate rows stay in: affiliate debt service counts in DSCR (split basis
 * 2026-09-27).
 */
export function dscrIncompleteRows<T extends Flagged & { readonly id: string; readonly name: string; readonly debtService: number }>(
  properties: readonly T[],
): IncompleteGovernorRow[] {
  return properties
    .map((p) => {
      const blanks = blankGovernorInputs(p);
      const dsBlank = blanks.includes('debtService');
      const noiCounts = blanks.includes('noi') && (dsBlank || p.debtService > 0);
      const fields = GOVERNOR_INPUT_FIELDS.filter((f) => (f === 'debtService' && dsBlank) || (f === 'noi' && noiCounts));
      return { id: p.id, name: p.name, fields };
    })
    .filter((r) => r.fields.length > 0)
    .sort(byId);
}

/**
 * Rows whose blank Loan Balance makes the aggregate LTV (third-party debt / Σ value) uncomputable. An
 * affiliate-lender row is excluded: its note is excluded from the LTV basis whatever its balance
 * (./debt-basis, ratified 2026-09-24), so its blank cannot move the aggregate (refute wf_fe0c7b48-326).
 */
export function ltvIncompleteRows<T extends Flagged & { readonly id: string; readonly name: string; readonly lender?: string | null }>(
  properties: readonly T[],
): IncompleteGovernorRow[] {
  return incompleteGovernorRows(properties.filter((p) => !namesAffiliateLender(p.lender)), ['loanBalance']);
}

/** Rows whose blank inputs include any of `fields`, id-sorted (deterministic tile text). */
export function incompleteGovernorRows<T extends Flagged & { readonly id: string; readonly name: string }>(
  properties: readonly T[],
  fields: readonly GovernorInputField[] = GOVERNOR_INPUT_FIELDS,
): IncompleteGovernorRow[] {
  return properties
    .map((p) => ({ id: p.id, name: p.name, fields: blankGovernorInputs(p).filter((f) => fields.includes(f)) }))
    .filter((r) => r.fields.length > 0)
    .sort(byId);
}
