// server/ar/ar-aging.ts
//
// AR-aging report parser (strategic-audit Fix #2 data feed). Turns a property-management
// A/R-aging export into per-tenant arrears buckets {d30,d60,d90,d90plus} that map 1:1 onto the
// TenantArrears contract — the overlay surface the collections condition reads. This is the
// "QuickBooks AR export → tenantArrears" feed the audit flagged as the follow-up to make the
// dormant collections alert fire on live data.
//
// SCOPE: this module is the PURE text → rows core. It operates on text already extracted from a
// PDF (or CSV), NOT on the PDF binary — so it is fully unit-testable with synthetic fixtures and
// no real tenant delinquency data ever enters the repo. The PDF→text step (pdfplumber, swappable)
// and the tenant→Lease.id mapping + overlay write are separate, separately-reviewed increments.
//
// Two explicit-bucket formats are supported today; a third (Rent Manager "Delinquency (Detail)",
// which carries no buckets and needs per-charge aging computed from charge dates) is detected and
// rejected with a clear reason rather than silently mis-parsed — wrong financial parsing feeds the
// collections alert, so an honest "unsupported" beats a plausible-but-wrong number.
//
// Bucket semantics (the contract): d30 = 1–30 days, d60 = 31–60, d90 = 61–90, d90plus = 90+.
// Negative bucket values (clearing credits / prepayments, e.g. AppFolio "-398.00") are clamped to
// 0 — a credit is not a past-due balance — matching the overlay's per-bucket salvage (overlay.ts).

/** A single tenant's parsed arrears, with the source context needed for the later Lease.id mapping. */
export interface ArAgingRow {
  /** Raw tenant/payer name exactly as it appears on the report (pre-mapping; matched to a lease later). */
  tenant: string;
  /** Source property / building label when the report carries one (AppFolio unit header, RM property). */
  property: string | null;
  /** 1–30 days past due. */
  d30: number;
  /** 31–60 days past due. */
  d60: number;
  /** 61–90 days past due. */
  d90: number;
  /** 90+ days past due. */
  d90plus: number;
}

export type ArFormat = 'yardi-aging' | 'appfolio-aged-receivable' | 'rent-manager-delinquency' | 'unknown';

export interface ParseArResult {
  format: ArFormat;
  rows: ArAgingRow[];
  /** Set when the format is recognized but unsupported (e.g. no buckets) — never silently empty. */
  unsupportedReason?: string;
}

/** Match a money token: optional sign, thousands-separated, exactly two decimals. Account numbers
 *  (no decimal), dates (slashes), and tran#s never match — so a line's money tokens are unambiguous. */
const MONEY = /-?[\d,]+\.\d{2}/g;
/** A date anywhere on a line (MM/DD/YYYY or MM/YYYY) marks a per-charge detail row, not a subtotal. */
const DATE_RE = /\b\d{1,2}\/\d{1,4}(?:\/\d{2,4})?\b/;

function money(token: string): number {
  const n = Number(token.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
/** A past-due bucket is never negative: a credit/prepayment nets to 0 (matches overlay salvage). */
const bucket = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Returns true when pdfplumber extraction produced CID-font garbage rather than real text —
 * a signal the PDF has no text layer (image/scanned). Checks the first 800 chars: if >30%
 * are non-ASCII the content is unusable. Exported so callers can surface a clear error
 * before attempting to parse, rather than getting an 'unknown' format silently.
 */
export function isGarbageExtraction(text: string): boolean {
  const sample = text.slice(0, 800);
  if (sample.length < 20) return true;
  const nonAscii = sample.split('').filter((c) => c.charCodeAt(0) > 127).length;
  return nonAscii / sample.length > 0.3;
}

/** Detect the report format from its header text. */
export function detectArFormat(text: string): ArFormat {
  const head = text.slice(0, 600).toLowerCase();
  if (head.includes('aged receivable detail')) return 'appfolio-aged-receivable';
  if (head.includes('aging detail')) return 'yardi-aging';
  if (head.includes('delinquency')) return 'rent-manager-delinquency';
  return 'unknown';
}

/**
 * Yardi "Aging Detail". Per-tenant SUBTOTAL rows read:
 *   <Tenant Name> <Current> <0-30> <31-60> <61-90> <Over90> <Prepay> <Total>   (7 money tokens)
 * Detail rows start with the property code and always carry a date; subtotal rows carry NO date.
 * Buckets = tokens [1..4] (skip Current at 0, Prepay at 5, Total at 6).
 */
function parseYardiAging(text: string): ArAgingRow[] {
  const rows: ArAgingRow[] = [];
  // Property / entity / customer codes appear parenthesized: "29000 Information Lane (29000inf)",
  // "Alchemy Works, Inc. (t0000738)". The PROPERTY-total row is printed as "<propcode> <7 tokens>"
  // (no date) and would otherwise look exactly like a tenant subtotal — so collect every code and
  // exclude any subtotal whose name is one. A real tenant name never equals a code.
  const codes = new Set<string>();
  for (const m of text.matchAll(/\(([A-Za-z0-9]+)\)/g)) codes.add(m[1]!);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || DATE_RE.test(line)) continue; // detail rows carry a date; subtotals never do
    const tokens = line.match(MONEY);
    if (!tokens || tokens.length !== 7) continue; // a tenant subtotal is exactly 7 money tokens
    // Everything before the first money token is the tenant name.
    const firstIdx = line.indexOf(tokens[0]!);
    const name = line.slice(0, firstIdx).trim().replace(/[•·\-\s]+$/, '');
    // Skip: blank, the "(t0000738)" header form, a property/entity code (property-total row), and the
    // Grand-Total / Total rows — each of which carries the whole property's arrears, not a tenant's.
    if (!name || codes.has(name) || /\(t\d+\)$/i.test(name) || /^(grand\s+total|grand|total)\b/i.test(name)) continue;
    const v = tokens.map(money);
    rows.push({ tenant: name, property: null, d30: bucket(v[1]!), d60: bucket(v[2]!), d90: bucket(v[3]!), d90plus: bucket(v[4]!) });
  }
  return rows;
}

/**
 * AppFolio "Aged Receivable Detail". Tenant identity is in the unit header line:
 *   <propcode> - <address> - Unit <x> - <TENANT NAME>
 * followed by detail rows (payer name + GL text + 6 money tokens) and a SUBTOTAL row that is money
 * tokens ONLY (6 of them: Amount, TotalReceivable, 0-30, 31-60, 61-90, 91+). Buckets = last 4.
 * The grand "Total ..." line is skipped.
 */
function parseAppfolioAging(text: string): ArAgingRow[] {
  const rows: ArAgingRow[] = [];
  let curTenant: string | null = null;
  let curProperty: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const unitMatch = line.match(/^(.*?)\s-\sUnit\s.*?-\s(.+)$/i);
    if (unitMatch) {
      curProperty = unitMatch[1]!.trim();
      curTenant = unitMatch[2]!.trim();
      continue;
    }
    if (/^total\b/i.test(line)) { curTenant = null; continue; } // grand total — not a tenant subtotal
    // A subtotal row is money tokens only (no letters other than the sign/commas).
    const tokens = line.match(MONEY);
    if (!tokens || !curTenant) continue;
    const stripped = line.replace(MONEY, '').replace(/[\s,]/g, '');
    if (stripped !== '' ) continue; // still has non-numeric text → a detail/charge row, not a subtotal
    if (tokens.length < 4) continue;
    const v = tokens.map(money);
    const last4 = v.slice(-4); // 0-30, 31-60, 61-90, 91+
    rows.push({ tenant: curTenant, property: curProperty, d30: bucket(last4[0]!), d60: bucket(last4[1]!), d90: bucket(last4[2]!), d90plus: bucket(last4[3]!) });
    curTenant = null; // one subtotal per tenant block
  }
  return rows;
}

/**
 * Parse an A/R-aging report's extracted text into per-tenant arrears rows. Auto-detects the format.
 * A recognized-but-unsupported format (no buckets) returns an explicit unsupportedReason and no
 * rows — never a silent empty result that would read as "no delinquencies".
 */
export function parseArAging(text: string, formatHint?: ArFormat): ParseArResult {
  const format = formatHint && formatHint !== 'unknown' ? formatHint : detectArFormat(text);
  switch (format) {
    case 'yardi-aging':
      return { format, rows: parseYardiAging(text) };
    case 'appfolio-aged-receivable':
      return { format, rows: parseAppfolioAging(text) };
    case 'rent-manager-delinquency':
      return {
        format,
        rows: [],
        unsupportedReason:
          'Rent Manager "Delinquency (Detail)" carries no aging buckets — arrears must be computed from per-charge dates (a separate increment). Export the "Aging Detail" report instead for bucketed parsing.',
      };
    default:
      return { format: 'unknown', rows: [], unsupportedReason: 'Unrecognized A/R report format (no known header).' };
  }
}
