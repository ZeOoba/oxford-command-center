// src/lib/money.ts
//
// Shared money coercion for the overlay numeric boundary. overlay.json is a user-/export-editable
// surface that bypasses Zod on the live path (CLAUDE.md §9), so a numeric value can arrive partial,
// negative, or currency-formatted from a hand-edit or a pasted QuickBooks/Excel/CSV export.
// coerceNonNegMoney normalizes any such value to a NON-NEGATIVE number — a real positive balance
// (incl. '$12,500', '1,200.00') survives; a credit / negative / accounting-parens / non-numeric
// value clamps to 0. It is the single source of truth used at every overlay numeric boundary
// (tenantArrears buckets, noiBudgets) AND as the in-memory backstop in src/analytics/conditions.ts,
// so the load path and the rule agree on exactly one coercion (no string/number asymmetry).

/**
 * Coerce an arbitrary value to a non-negative number.
 * - number → itself if finite and > 0, else 0
 * - string → strip `$`, thousands separators and whitespace; accounting parens `(x)` → `-x`; then
 *   Number(); finite and > 0 → that number, else 0
 * - anything else → 0
 * Directional safety: errs toward 0 (dropping a credit/junk), never toward a spurious positive.
 */
export function coerceNonNegMoney(v: unknown): number {
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const s = v.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    n = s === '' ? NaN : Number(s);
  } else {
    n = NaN;
  }
  return Number.isFinite(n) && n > 0 ? n : 0;
}
