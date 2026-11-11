// scripts/fixtures/synthetic-money.ts
//
// Seeded random money for the synthetic fixtures (scripts/fixtures/build-synthetic-data.ts).
//
// Replaces scripts/fixtures/perturb.ts (retired 2026-11-11). That module multiplied each REAL amount
// by a keyed HMAC factor; an adversarial review showed the link was still exploitable: with group
// keying (one factor per P&L entity, cost-seg study or lease) a single real figure that is public in a
// test, a doc or git history reveals the entity's factor and so its whole real P&L, and with a shared
// secret value keying is brute-forceable.
//
// Here no synthetic amount is a function of a real amount. Every money value is DRAWN:
//   value = sign × draw(SYNTH_SEED, structural key, band)
//   - SYNTH_SEED is public (committed below). No secret file exists or is needed.
//   - the structural key is the value's location in the SYNTHETIC output (file, record, entity,
//     period, line, field path, built from already-aliased ids), never the real value and never a
//     real name (a key carrying a real name could be confirmed by hashing guesses).
//   - the band is chosen from the field's MEANING (BANDS below, by field / line name), optionally
//     scaled by the record's square footage (SF is kept real on purpose). No band, bucket, order of
//     magnitude, ratio or rank is ever taken from the record's own real amount.
//   - the ONLY attributes of a real amount that survive are its SIGN and EXACT ZERO (a credit line,
//     a month with no activity, a lease-up month with no rent). Tests depend on those partial-year
//     and zero patterns, so they are kept; nothing else about the real value reaches the output.
//   - a draw that happens to equal a real amount on the numeric fingerprint list is redrawn with a
//     counter appended to its key, so the fingerprint leak check stays at zero.
// Derived figures (sums, NOI = revenue - opex, per-SF, ratios, portfolio views, cash totals, ...) are
// recomputed by the generator from the drawn parts, and joins (a property's loan balance and its loan
// row, arrears and AR balances, ...) are re-established by copying the canonical record's drawn value
// into its mirrors. Rates (percentages, cap rates, escalators), SF, counts and dates are not money and
// stay as they are.
import { createHash } from 'node:crypto';

/** Public seed. Changing it re-draws every synthetic amount (bump the suffix on purpose only). */
export const SYNTH_SEED = 'occ-synthetic-v2';

/** Decimal places of a number's shortest representation (exponent form counts as many). */
export function decimalsOf(v: number): number {
  const s = String(v);
  if (/e/i.test(s)) return 6;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function roundTo(x: number, decimals: number): number {
  const f = 10 ** Math.min(decimals, 2);
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Uniform in [0, 1) at 48-bit resolution from SHA-256(seed | key). Deterministic, public. */
export function unit(key: string, seed: string = SYNTH_SEED): number {
  const h = createHash('sha256').update(`${seed}|${key}`).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}

export const uniform = (key: string, lo: number, hi: number): number => lo + (hi - lo) * unit(key);

/** Log-uniform in [lo, hi): every order of magnitude inside the band equally likely. */
export function logUniform(key: string, lo: number, hi: number): number {
  if (lo <= 0 || hi <= lo) return uniform(key, lo, hi);
  return Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * unit(key));
}

/** A plausible range for one kind of amount. perSf: the bounds are annual $ per square foot and the
 *  caller multiplies by the record's SF (falling back to DEFAULT_SF when it has none). */
export interface Band {
  lo: number;
  hi: number;
  perSf?: boolean;
  /** Output precision (0 = whole dollars). Default 2. */
  decimals?: number;
}

/** The SF a per-SF band assumes when the record carries no square footage. */
export const DEFAULT_SF = 25_000;

const b = (lo: number, hi: number, extra: Partial<Band> = {}): Band => ({ lo, hi, ...extra });
const sfB = (lo: number, hi: number, extra: Partial<Band> = {}): Band => ({ lo, hi, perSf: true, ...extra });
const whole = { decimals: 0 };

/**
 * Bands by field (or P&L line / category) name. Per-SF bands are annual $/SF for shallow-bay
 * industrial / flex; absolute bands are plain dollars. A field that is always re-derived from its
 * parts (a total, NOI, a delta) still gets a band so a record whose identity did not hold has a
 * plausible stand-in.
 */
export const BANDS: Readonly<Record<string, Band>> = {
  // ── snapshot: properties ──
  estValue100: sfB(55, 120, whole),
  oxfordValue: sfB(30, 120, whole),
  grossIncome: sfB(5, 11),
  expenses: sfB(1.2, 3.5),
  noi: sfB(3, 8),
  noiScenarioAdj: sfB(3, 8),
  debtService: sfB(1.5, 4),
  netCashFlow: sfB(0.5, 4),
  loanBalance: sfB(20, 55),
  valuePerSf: b(55, 120),
  rentPerSf: b(5, 11),
  equityInvested: sfB(15, 45, whole),
  // ── snapshot: leases (monthly rent = annual $/SF / 12) ──
  monthlyRent: sfB(5 / 12, 11 / 12),
  annualRent: sfB(5, 11),
  rent: sfB(5, 11),
  // ── snapshot: loans / tasks ──
  currentBalance: b(400_000, 6_000_000),
  absBalance: b(400_000, 6_000_000),
  originalPrincipal: b(600_000, 8_000_000, whole),
  monthlyPmt: b(3_000, 45_000),
  annualInterest: b(20_000, 350_000),
  annualPrincipal: b(10_000, 200_000),
  // ── snapshot: cash ──
  totalCash: b(500_000, 8_000_000),
  priorBalance: b(5_000, 2_500_000),
  balance: b(5_000, 2_500_000),
  avg3: b(5_000, 2_500_000),
  minAllTime: b(1_000, 1_000_000),
  maxAllTime: b(20_000, 3_000_000),
  bal12moAgo: b(5_000, 2_500_000),
  deltaDollar: b(1_000, 200_000),
  growth12Dollar: b(5_000, 500_000),
  // ── snapshot: insurance ──
  premium: b(2_000, 60_000, whole),
  premiumAnnual: b(2_000, 60_000, whole),
  tiv: b(1_000_000, 12_000_000, whole),
  coverageTiv: b(1_000_000, 12_000_000, whole),
  deductible: b(1_000, 25_000, whole),
  coverageLimit: b(1_000_000, 10_000_000, whole),
  // ── snapshot: deals / comps ──
  estPrice: sfB(50, 120, whole),
  price: sfB(50, 130, whole),
  pricePerSf: b(50, 130),
  // ── snapshot: AR / arrears / QuickBooks ──
  d30: b(100, 25_000),
  d60: b(100, 15_000),
  d90: b(100, 10_000),
  d90plus: b(100, 40_000),
  total: b(500, 60_000),
  annualIncome: b(150_000, 1_500_000),
  annualExpense: b(40_000, 500_000),
  annualNoi: b(100_000, 1_000_000),
  income: b(150_000, 1_500_000),
  expense: b(40_000, 500_000),
  amount: b(200, 80_000),
  value: b(1_000, 500_000),

  // ── property financials: P&L lines (annual $/SF) ──
  base_rent: sfB(6, 11),
  recoveries: sfB(1.0, 2.4),
  utility_reimb: sfB(0.15, 0.6),
  reimbursements: sfB(1.2, 3.0),
  other_income: sfB(0.05, 0.4),
  vacancy_waivers: sfB(0.1, 0.6),
  energy_income: sfB(0.2, 1.0),
  revenue: sfB(7, 14),
  opex: sfB(2.5, 5.5),
  pool: sfB(2, 4.5),
  capex: sfB(0.3, 2.5),
  dist: sfB(2, 6),
  'Real estate & property tax': sfB(0.8, 1.8),
  Insurance: sfB(0.25, 0.6),
  'Management fees': sfB(0.3, 0.6),
  Utilities: sfB(0.2, 0.8),
  'Grounds / snow / lot': sfB(0.1, 0.5),
  'Repairs & maintenance': sfB(0.3, 1.0),
  'Turnover / make-ready': sfB(0.05, 0.4),
  'Professional / admin': sfB(0.05, 0.3),
  // non-operating (annual entities)
  interest_income_2026ytd: b(5_000, 80_000),
  interest_expense: b(2_000, 60_000),
  entity_income_tax: b(500, 15_000),
  annual_impact_usd: b(2_000, 120_000, whole),
  prior_monthly: sfB(5 / 12, 11 / 12),
  new_monthly: sfB(5 / 12, 11 / 12),
  security_deposit: sfB(0.5, 1.5),
  nnn_estimate_monthly: sfB(1.5 / 12, 3.5 / 12),

  // ── cost seg (whole dollars, as the studies state them) ──
  '5yr': b(80_000, 900_000, whole),
  '7yr': b(5_000, 120_000, whole),
  '9yr_ads': b(20_000, 300_000, whole),
  '15yr': b(60_000, 700_000, whole),
  '39yr': b(600_000, 7_000_000, whole),
  alloc_sum: b(1_000_000, 8_000_000, whole),
  fee: b(4_000, 25_000, whole),
  structure: b(400_000, 5_000_000, whole),
  hvac: b(30_000, 400_000, whole),
  plumbing: b(20_000, 250_000, whole),
  electrical: b(40_000, 500_000, whole),
  elevator: b(30_000, 150_000, whole),
  fire_alarm: b(5_000, 60_000, whole),
  fire: b(5_000, 80_000, whole),
  personal_5yr: b(20_000, 300_000, whole),
  land_improvements: b(50_000, 600_000, whole),
  public_space_5yr: b(5_000, 80_000, whole),
  pp5: b(20_000, 300_000, whole),
  pp9: b(10_000, 150_000, whole),
  computed: b(1_000_000, 8_000_000, whole),
  expected: b(1_000_000, 8_000_000, whole),
  usd_value: b(2_000, 400_000, whole),
  // ── building specs / calibration ──
  estimate_usd: b(2_000, 400_000, whole),
};

/** Unit-cost bands for calibration observations, by the observation's unit (a structural field). */
export const UNIT_COST_BANDS: Readonly<Record<string, Band>> = {
  SF: b(1, 12),
  LF: b(5, 60),
  EA: b(800, 9_000),
  SY: b(10, 60),
};

/** Fallback for a money field with no entry above. */
export const DEFAULT_BAND: Band = b(1_000, 100_000);

export function bandFor(field: string): Band {
  return BANDS[field] ?? DEFAULT_BAND;
}

export const hasBand = (field: string): boolean => Object.prototype.hasOwnProperty.call(BANDS, field);

export interface MoneyDrawer {
  /**
   * Draw an amount for `key` inside [lo, hi) (log-uniform), with the given sign and precision. The
   * caller passes the sign of the real amount; that is the only thing taken from it. A result whose
   * absolute value is on the avoid list (real-amount fingerprints) is redrawn with a counter.
   */
  draw(key: string, sign: number, lo: number, hi: number, decimals?: number): number;
  /** Number of redraws forced by the avoid list so far (for the run log). */
  readonly redraws: number;
}

export function makeMoneyDrawer(avoid: ReadonlySet<string> = new Set()): MoneyDrawer {
  let redraws = 0;
  return {
    draw(key: string, sign: number, lo: number, hi: number, decimals = 2): number {
      for (let c = 0; ; c++) {
        // A degenerate band (lo == hi: a model value with no jitter) steps by one unit of precision.
        const x = hi > lo ? logUniform(c === 0 ? key : `${key}#${c}`, lo, hi) : lo + c * 10 ** -Math.min(decimals, 2);
        let r = roundTo(x, decimals);
        if (r === 0) r = decimals === 0 ? 1 : 0.01; // a drawn amount is never an exact zero
        if (avoid.has(String(r)) && c < 1000) {
          redraws++;
          continue;
        }
        return sign < 0 ? -r : r;
      }
    },
    get redraws() {
      return redraws;
    },
  };
}
