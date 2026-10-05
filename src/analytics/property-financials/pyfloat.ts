// src/analytics/property-financials/pyfloat.ts
//
// Python float semantics for the two places the Property Financials rebuild must match a Python-made
// artifact byte for byte (plan T9a): monthly-long.csv amounts carry Python's float repr ("141.0",
// "1508.25"), and every rounded figure in dataset.json came from Python's round(), which rounds the
// EXACT binary value half-to-even (8950.5 -> 8950, 0.125 -> 0.12). JavaScript's Math.round /
// toFixed round half away from zero / up, so a naive port drifts by a cent or a dollar on exact
// halves — invisible in the suite until a rent of $8,950.50 shows as 8951.
//
// Pure TypeScript: no fs.

const F64 = new DataView(new ArrayBuffer(8));

/** Decompose a finite double into sign, 53-bit integer mantissa and binary exponent: |x| = m * 2^e. */
function decompose(x: number): { negative: boolean; m: bigint; e: number } {
  F64.setFloat64(0, x);
  const hi = F64.getUint32(0);
  const lo = F64.getUint32(4);
  const negative = (hi >>> 31) === 1;
  const biasedExp = (hi >>> 20) & 0x7ff;
  const fracHi = BigInt(hi & 0xfffff);
  const frac = (fracHi << 32n) | BigInt(lo);
  if (biasedExp === 0) return { negative, m: frac, e: -1074 }; // subnormal (or zero)
  return { negative, m: frac | (1n << 52n), e: biasedExp - 1075 };
}

function pow10(n: number): bigint {
  let p = 1n;
  for (let i = 0; i < n; i++) p *= 10n;
  return p;
}

/**
 * Python `round(x, ndigits)`: round-half-to-even on the exact binary value, returned as the double
 * closest to the decimal result. ndigits must be a non-negative integer. Never returns -0.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`pyRound: value must be finite, got ${x}`);
  if (!Number.isInteger(ndigits) || ndigits < 0) throw new RangeError(`pyRound: ndigits must be a non-negative integer, got ${ndigits}`);
  if (x === 0) return 0;
  const { negative, m, e } = decompose(x);
  const scaled = m * pow10(ndigits); // |x| * 10^nd = scaled * 2^e, exactly
  let q: bigint;
  if (e >= 0) {
    q = scaled << BigInt(e);
  } else {
    const d = 1n << BigInt(-e);
    q = scaled / d;
    const r = scaled - q * d;
    const twice = r * 2n;
    if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n;
  }
  if (q === 0n) return 0;
  const digits = q.toString();
  const text = ndigits === 0 ? digits : `${digits}e-${ndigits}`;
  const value = Number(text);
  return negative ? -value : value;
}

/**
 * Python `repr(float)` for the values a P&L can hold: integers print with a trailing ".0", everything
 * else at shortest round-trip precision (identical digits to JavaScript's). Negative zero prints as
 * "0.0" (the reference CSV carries none). Values Python would print in exponent form (|x| >= 1e16 or
 * 0 < |x| < 1e-4) are refused rather than mis-rendered — no P&L line is in that range.
 */
export function pyRepr(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`pyRepr: value must be finite, got ${x}`);
  if (x === 0) return '0.0';
  const abs = Math.abs(x);
  if (abs >= 1e16 || abs < 1e-4) throw new RangeError(`pyRepr: ${x} would print in exponent form`);
  if (Number.isInteger(x)) return `${x}.0`;
  const s = String(x);
  if (s.includes('e')) throw new RangeError(`pyRepr: ${x} would print in exponent form`);
  return s;
}
