// scripts/fixtures/perturb.ts
//
// Keyed money perturbation for the synthetic fixtures (scripts/fixtures/build-synthetic-data.ts).
//
// Replaces the original single global scale factor, which could be brute-forced back out of the
// committed fixtures (refute run 2026-11-11): one linear factor maps every real value onto the same
// lattice, so a search over k that lands the de-scaled values on whole cents or round thousands
// recovers it, and one known real figure recovers it outright.
//
// Here every amount gets its OWN multiplier in [BAND_LO, BAND_HI), derived from an HMAC-SHA256 of a
// key with a local secret (never committed):
//   - value-keyed (default): the key is the amount itself, so equal real amounts stay equal (joins
//     such as a property's loan balance and the loan row, a task's payment and its loan, keep
//     working) while different amounts get independent multipliers;
//   - group-keyed: callers that must keep a set of amounts proportional (one property's P&L periods,
//     months and history, so its own margins and YoY stay internally consistent) pass a group key.
// Results are rounded to the source value's native precision (whole dollars stay whole, cents stay
// cents, at most 2 decimals), so the outputs carry no extra digits that would pin the multiplier.
// Derived totals (sums, per-SF, NOI = revenue - opex, ...) are recomputed by the generator from the
// perturbed parts.
import { createHmac } from 'node:crypto';

export const BAND_LO = 0.55;
export const BAND_HI = 0.95;

/** Decimal places of a number's shortest representation (exponent form counts as many). */
export function decimalsOf(v: number): number {
  const s = String(v);
  if (/e/i.test(s)) return 6;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Round to the source value's native precision: its own decimals, capped at 2. */
export function roundNative(x: number, source: number): number {
  const d = Math.min(decimalsOf(source), 2);
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function roundTo(x: number, decimals: number): number {
  const f = 10 ** Math.min(decimals, 2);
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export interface Perturber {
  /** The multiplier for a key: uniform in [BAND_LO, BAND_HI) at 48-bit resolution. */
  factor(key: string): number;
  /** Perturb one amount: group-keyed when `group` is given, else keyed by the amount itself. */
  money(v: number, group?: string | null): number;
}

export function makePerturber(secret: Buffer | string): Perturber {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const cache = new Map<string, number>();
  const factor = (k: string): number => {
    let f = cache.get(k);
    if (f === undefined) {
      const h = createHmac('sha256', key).update(k).digest();
      f = BAND_LO + (BAND_HI - BAND_LO) * (h.readUIntBE(0, 6) / 2 ** 48);
      cache.set(k, f);
    }
    return f;
  };
  return {
    factor,
    money(v: number, group?: string | null): number {
      if (!Number.isFinite(v) || v === 0) return v;
      const k = group ? factor(`g|${group}`) : factor(`v|${Math.abs(v).toFixed(2)}`);
      return roundNative(v * k, v);
    },
  };
}
