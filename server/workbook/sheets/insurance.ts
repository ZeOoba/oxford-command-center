// server/workbook/sheets/insurance.ts
//
// Master Workbook parser: the Insurance Renewals and Insurance Premium History sheets. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import { slug, type InsurancePolicy, type DataQualityFlag, type InsuranceStatus } from '../../../src/contracts/index';
import { cv, decPairOrFlag, isoOrNull, num, row, str } from './cells';
type Worksheet = ExcelJS.Worksheet;

// ── insurance (Insurance Renewals) ────────────────────────────────────────────
export function parseInsurance(ws: Worksheet, flags: DataQualityFlag[]): InsurancePolicy[] {
  const out: InsurancePolicy[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const rowId = str(row(ws, r, 1));
    if (!rowId || !/^ins-/i.test(rowId)) continue; // RowID pattern anchors data rows
    const property = str(row(ws, r, 2)) ?? '—';
    const override = (str(row(ws, r, 12)) ?? '').toLowerCase();
    const rawStatus = (str(row(ws, r, 11)) ?? '').toLowerCase();
    let status: InsuranceStatus = 'Unknown';
    if (override.includes('cancel') || rawStatus.includes('cancel')) status = 'Cancelled';
    else if (rawStatus.includes('expired')) status = 'Expired';
    else if (rawStatus.includes('renew now')) status = 'Renew Now';
    else if (rawStatus.includes('renewing')) status = 'Renewing Soon';
    else if (rawStatus.includes('current')) status = 'Current';
    out.push({
      id: slug(rowId),
      property,
      entity: str(row(ws, r, 3)),
      coverage: str(row(ws, r, 4)),
      effective: isoOrNull(row(ws, r, 5), flags, slug(rowId), 'effective'),
      expires: isoOrNull(row(ws, r, 6), flags, slug(rowId), 'expires'),
      policyNo: str(row(ws, r, 7)),
      carrier: str(row(ws, r, 8)),
      premium: num(row(ws, r, 9)) ?? 0,
      daysToExpiry: num(row(ws, r, 10)),
      status,
      notes: str(row(ws, r, 13)),
      // Optional economics columns (D3 framework): absent columns → null, never invented.
      tiv: num(row(ws, r, 14)),
      ...decPairOrFlag(num(row(ws, r, 15)), num(row(ws, r, 16)), flags, slug(rowId)),
      flags: [],
    });
  }
  return out;
}

// ── insurance TIV (Insurance Premium History) ─────────────────────────────────
// The `Insurance Renewals` tab was re-laid-out to 13 columns (RowID..Notes), so parseInsurance's
// positional tiv read (column 14) has been empty since; every current-term policy captured
// coverage_tiv NULL and the own-book rate benchmark collapsed to cohortN 0. The declaration-
// transcribed building limit lives on `Insurance Premium History` (one row per property per policy
// year). Ruling 2026-09-24 (Gabriel): re-import from that source on every parse — never carry a
// prior term's value forward. Columns are located by HEADER TEXT, not position, so the next
// re-layout degrades to "no TIV" instead of reading the wrong column.
export interface PremiumHistoryTivRow {
  sheetRow: number;
  property: string;
  namedInsured: string | null;
  /** First year of the 'Policy Year' label ("2025-2026" → 2025). */
  policyYearStart: number;
  packagePremium: number | null;
  tiv: number | null;
  basis: string | null;
}

// Every pattern is anchored at the label start and must match EXACTLY ONE header cell: the live tab
// also carries "YoY TIV" and "Rate per $100 TIV", and a first-match-wins read would attach a ratio
// as a building limit the moment a column is inserted to the left (refute wf_fb9dddc7-3a3).
const PREMIUM_HISTORY_HEADERS = {
  property: /^property$/i,
  namedInsured: /^named insured/i,
  policyYear: /^policy year/i,
  packagePremium: /^package premium/i,
  tiv: /^(building limit|tiv)\b/i,
  basis: /^basis/i,
} as const;
type PremiumHistoryKey = keyof typeof PREMIUM_HISTORY_HEADERS;

/** `null` = the header row is missing or ambiguous (a pattern hits two columns) — the caller treats
 *  that like an absent tab and flags it; a column position is never guessed. */
export function parseInsurancePremiumHistory(ws: Worksheet): PremiumHistoryTivRow[] | null {
  let headerRow = 0;
  const col: Partial<Record<PremiumHistoryKey, number>> = {};
  for (let r = 1; r <= ws.rowCount && !headerRow; r++) {
    if (!PREMIUM_HISTORY_HEADERS.property.test(str(row(ws, r, 1)) ?? '')) continue;
    const hits = new Map<PremiumHistoryKey, number[]>();
    ws.getRow(r).eachCell((cell, c) => {
      const label = str(cv(cell.value)) ?? '';
      for (const [key, re] of Object.entries(PREMIUM_HISTORY_HEADERS) as Array<[PremiumHistoryKey, RegExp]>) {
        if (re.test(label)) hits.set(key, [...(hits.get(key) ?? []), c]);
      }
    });
    if (!hits.has('tiv') || !hits.has('policyYear')) continue;
    if ([...hits.values()].some((cols) => cols.length > 1)) return null;
    headerRow = r;
    for (const [key, cols] of hits) col[key] = cols[0];
  }
  if (!headerRow || col.property === undefined || col.policyYear === undefined || col.tiv === undefined) return null;

  const out: PremiumHistoryTivRow[] = [];
  // The term block ends at the first blank Property cell — the portfolio-total and like-for-like
  // blocks below it carry year labels and TIV sums that must never be read as a property's term.
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const property = str(row(ws, r, col.property));
    if (!property) break;
    const year = /^(\d{4})\s*-\s*\d{4}/.exec(str(row(ws, r, col.policyYear)) ?? '');
    if (!year) continue;
    const tiv = num(row(ws, r, col.tiv));
    const packagePremium = col.packagePremium === undefined ? null : num(row(ws, r, col.packagePremium));
    out.push({
      sheetRow: r,
      property,
      namedInsured: col.namedInsured === undefined ? null : str(row(ws, r, col.namedInsured)),
      policyYearStart: Number(year[1]),
      packagePremium,
      tiv: tiv !== null && tiv > 0 ? tiv : null,
      basis: col.basis === undefined ? null : str(row(ws, r, col.basis)),
    });
  }
  return out;
}

/** Same keyword set as insurance-analysis.ts classifyCohort — the building limit belongs to the
 *  property/package line only, never to a BCL/GL/umbrella/EPLI line of the same property. */
const PROPERTY_LINE_RE = /property|package|building/i;
const STREET_SUFFIXES: Record<string, string> = {
  court: 'ct', avenue: 'ave', road: 'rd', drive: 'dr', street: 'st', highway: 'hwy', boulevard: 'blvd', lane: 'ln',
};
function streetKey(address: string): string {
  const head = address.replace(/\([^)]*\)/g, ' ').split(',')[0] ?? '';
  return head
    .toLowerCase()
    .replace(/[.]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_SUFFIXES[w] ?? w)
    .join(' ');
}
function insuredKey(name: string | null): string {
  if (!name) return '';
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
}
/** Address match first; named insured only when NO history row matches by street address. An
 *  entity named as loss payee on another property's tenant policy (401 Sunburst names the FVC LLC)
 *  must not pull that entity's own building limit onto the tenant line. */
function matchHistoryRows(p: InsurancePolicy, candidates: PremiumHistoryTivRow[]): PremiumHistoryTivRow[] {
  const a = streetKey(p.property);
  if (a && /^\d/.test(a)) {
    const byAddress = candidates.filter((h) => streetKey(h.property) === a);
    if (byAddress.length) return byAddress;
  }
  const e = insuredKey(p.entity);
  return e === '' ? [] : candidates.filter((h) => insuredKey(h.namedInsured) === e);
}
/** Premiums are whole dollars on both tabs; anything beyond a cent is a genuine disagreement. */
const PREMIUM_TIE_TOLERANCE = 0.01;

/**
 * Attach the Premium History building limit to current-term property/package policies.
 *
 * Join: same property (street address, else named insured) AND policy-year start year ===
 * the policy's effective year. Rules (ruling 2026-09-24 unless noted):
 *  - A TIV already on the Renewals row is kept; Cancelled rows are skipped (a replaced policy's
 *    rate must not enter the own-book median beside its replacement); $0-premium lines are skipped.
 *  - Never guess — each refusal leaves tiv null and raises a warn flag: two history rows for one
 *    term; a blank or disagreeing package premium (the premium tie is what proves the join hit the
 *    right term); a history TIV no larger than the premium (a ratio, not a building limit); one
 *    history row matching two policies (the same building limit would be counted twice).
 *  - A property line with no same-year history row, or a blank TIV cell on it, gets an info flag —
 *    it drops out of the own-book benchmark, and the register says why.
 *  - A basis note saying "reconstructed" still attaches, flagged on the policy so the capture
 *    writes it to data_quality_issues.
 *  - An EXPIRED property term (Renewals row not yet rolled) is flagged, naming a successor term
 *    already on the history tab; insurance-analysis.ts keeps expired terms out of the benchmark and
 *    the rebid verdicts (ruling 2026-09-24 "exclude + flag").
 * `history === null` means the tab is absent or its header unreadable — flagged only if some
 * policy actually needed TIV.
 */
export function attachPremiumHistoryTiv(
  policies: InsurancePolicy[],
  history: PremiumHistoryTivRow[] | null,
  flags: DataQualityFlag[],
): InsurancePolicy[] {
  const flag = (p: InsurancePolicy, issue: string, severity: 'info' | 'warn' = 'warn'): void => {
    const f: DataQualityFlag = { entity: p.id, field: 'tiv', issue, severity };
    p.flags.push(f);
    flags.push(f);
  };
  // premium > 0: a $0 line is tenant-insured evidence (ACORD 28), not an ORA-paid policy — the
  // Premium History tab excludes it from every total, and a TIV there can never produce a rate.
  const isRatedPropertyLine = (p: InsurancePolicy): boolean =>
    p.status !== 'Cancelled' && p.premium > 0 && PROPERTY_LINE_RE.test(p.coverage ?? '') && p.effective !== null;
  const needsTiv = (p: InsurancePolicy): boolean => p.tiv === null && isRatedPropertyLine(p);

  for (const p of policies) {
    if (!isRatedPropertyLine(p) || p.daysToExpiry === null || p.daysToExpiry >= 0) continue;
    const year = Number(p.effective!.slice(0, 4));
    const successor = history
      ? matchHistoryRows(p, history.filter((h) => h.policyYearStart > year))
        .sort((x, y) => x.policyYearStart - y.policyYearStart)[0]
      : undefined;
    flag(
      p,
      `term expired ${p.expires ?? '(no date)'} — Renewals row not rolled to the current term` +
        (successor ? ` (Insurance Premium History row ${successor.sheetRow} already carries ${successor.policyYearStart}-${successor.policyYearStart + 1})` : '') +
        '; excluded from the own-book rate benchmark and rebid verdicts',
    );
  }

  if (history === null || history.length === 0) {
    if (policies.some(needsTiv)) {
      flags.push({
        entity: 'insurance',
        field: 'tiv',
        issue: 'Insurance Premium History tab not found, empty, or its header row is missing/ambiguous — current-term TIV unavailable, own-book rate benchmark will be insufficient',
        severity: 'warn',
      });
    }
    return policies;
  }

  const attachedBy = new Map<PremiumHistoryTivRow, InsurancePolicy[]>();
  for (const p of policies) {
    if (!needsTiv(p)) continue;
    const year = Number(p.effective!.slice(0, 4));
    const matches = matchHistoryRows(p, history.filter((h) => h.policyYearStart === year));
    if (matches.length === 0) {
      flag(p, `no Insurance Premium History row for policy year ${year} — TIV unavailable (declaration needed), excluded from the own-book rate benchmark`, 'info');
      continue;
    }
    if (matches.length > 1) {
      flag(p, `${matches.length} Insurance Premium History rows (sheet rows ${matches.map((m) => m.sheetRow).join(', ')}) match policy year ${year} — TIV left null`);
      continue;
    }
    const h = matches[0]!;
    if (h.tiv === null) {
      flag(p, `Insurance Premium History row ${h.sheetRow} has no building limit for policy year ${year} — TIV unavailable, excluded from the own-book rate benchmark`, 'info');
      continue;
    }
    if (h.packagePremium === null || Math.abs(h.packagePremium - p.premium) > PREMIUM_TIE_TOLERANCE) {
      flag(p, `Insurance Premium History row ${h.sheetRow} package premium ${h.packagePremium ?? '(blank)'} ≠ Renewals premium ${p.premium} for policy year ${year} — TIV left null`);
      continue;
    }
    if (h.tiv <= p.premium) {
      flag(p, `Insurance Premium History row ${h.sheetRow} TIV ${h.tiv} is not larger than the premium ${p.premium} — not a building limit, TIV left null`);
      continue;
    }
    const arr = attachedBy.get(h);
    if (arr) arr.push(p);
    else attachedBy.set(h, [p]);
  }

  for (const [h, ps] of attachedBy) {
    if (ps.length > 1) {
      for (const p of ps) {
        flag(p, `Insurance Premium History row ${h.sheetRow} matches ${ps.length} policies (${ps.map((x) => x.id).sort().join(', ')}) — TIV left null to avoid double-counting one building limit`);
      }
      continue;
    }
    const p = ps[0]!;
    p.tiv = h.tiv;
    if (h.basis && /reconstruct/i.test(h.basis)) {
      flag(p, `TIV ${h.tiv} attached from Insurance Premium History row ${h.sheetRow}, but that term's basis note says reconstructed (base declaration missing) — rate carries that premium's uncertainty`);
    }
  }
  return policies;
}
