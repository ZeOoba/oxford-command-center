// src/analytics/lease-forecast.ts — Phase 3 Lease Forecast Analytics Engine
// Pure functions over PortfolioSnapshot + overlay-derived inputs. No DB. Spine A.
// Mirrors engine.ts style — no side effects, no I/O.
import type { Lease } from '@contracts/index';
import { ALERT_THRESHOLDS } from './conditions';
import type {
  ExpiryBucket,
  RenewalSignal,
  MarketRentGap,
  RentForecastInput,
  RentForecastResult,
  RenewalLikelihood,
} from '@contracts/lease-forecast';
import { coerceNonNegMoney } from '@/lib/money';
import { DAY_MS, MONTH_MS } from '../../server/warehouse/time-constants';

// ── Constants ─────────────────────────────────────────────────────────────────
/** Ratified 2026-06-21: VELOCITY_SLOW_DAYS = 60 days (updated from proposed 120). */
export const VELOCITY_SLOW_DAYS = 60;

/** Compute signed months between two ISO date strings. Positive = target is later than from. */
function monthsBetween(isoTarget: string, isoFrom: string): number {
  return (new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / MONTH_MS;
}

// ── bucketExpiry ──────────────────────────────────────────────────────────────
/**
 * Map months-to-expiry to a five-way bucket:
 *   null / NaN → 'unknown'
 *   < 0        → 'expired'
 *   0..6       → '0-6m'    (inclusive of 0; exclusive of 6)
 *   6..12      → '6-12m'   (inclusive of 6; exclusive of 12)
 *   12..24     → '12-24m'
 *   > 24       → '24m+'
 *
 * Pass `asOf` to correctly classify leases that expired earlier in the current calendar month:
 * the workbook `monthsToExpiry` field uses differenceInCalendarMonths (integer) which returns 0
 * for both "expires this month in the future" and "expired this month in the past". When `asOf`
 * and `leaseEnd` are both provided, the date comparison takes priority over the truncated integer.
 */
export function bucketExpiry(monthsToExpiry: number | null, leaseEnd: string | null, asOf?: string): ExpiryBucket {
  if (monthsToExpiry === null || !Number.isFinite(monthsToExpiry)) return 'unknown';
  // Date-accurate expiry check: if leaseEnd is strictly before asOf the lease has already expired,
  // regardless of what the truncated calendar-month integer says.
  if (asOf && leaseEnd && new Date(leaseEnd).getTime() < new Date(asOf).getTime()) return 'expired';
  if (monthsToExpiry < 0) return 'expired';
  if (monthsToExpiry < 6) return '0-6m';
  if (monthsToExpiry < 12) return '6-12m';
  if (monthsToExpiry <= 24) return '12-24m';
  return '24m+';
}

// ── renewalSignals ────────────────────────────────────────────────────────────
/**
 * Compute renewal probability signals for all leases using the ratified band table.
 * Defensive coercion throughout — overlay fields skip Zod on the live path (MEMORY: overlay-not-reparsed-zod).
 *
 * Band table (first match wins):
 *   1. renewalStage ∈ {'LOI','Executed'}                                  → 'likely'
 *   2. monthToMonth = true OR (leaseEnd in past AND no stage)              → 'lapsing'
 *   3. arrearsUsd ≥ ALERT_THRESHOLDS.arrearsMaterialUsd AND ≤ 12m         → 'at-risk'
 *   4. tenureMonths ≥ 36 AND arrearsUsd == 0 AND monthsToExpiry ≤ 12      → 'likely'
 *   5. monthsToExpiry ≤ 6 AND renewalStage ∈ {null,'Expiring'}            → 'at-risk'
 *   6. otherwise                                                            → 'uncertain'
 */
export function renewalSignals(
  leases: Lease[],
  asOf: string,
  renewalStages: Record<string, unknown>,
  arrears: Record<string, { d30?: unknown; d60?: unknown; d90?: unknown; d90plus?: unknown }>,
): RenewalSignal[] {
  const asOfMs = new Date(asOf).getTime();
  const out: RenewalSignal[] = [];

  const VALID_STAGES = new Set(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);

  for (const l of leases) {
    // ── Defensive coercion of overlay fields ──────────────────────────────────
    // renewalStage: validate against known stages, treat anything else as null
    const rawStage = renewalStages[l.id];
    const stage: RenewalSignal['renewalStage'] =
      typeof rawStage === 'string' && VALID_STAGES.has(rawStage)
        ? (rawStage as RenewalSignal['renewalStage'])
        : null;

    // arrearsUsd: sum all buckets through coerceNonNegMoney
    const ar = arrears[l.id];
    const arrearsUsd = ar
      ? coerceNonNegMoney(ar.d30) + coerceNonNegMoney(ar.d60) +
        coerceNonNegMoney(ar.d90) + coerceNonNegMoney(ar.d90plus)
      : 0;

    // monthToMonth: leaseEnd in the past AND status is not 'Expired' (holdover tenancy)
    const leaseEndMs = l.leaseEnd ? new Date(l.leaseEnd).getTime() : null;
    const leaseEndInPast = leaseEndMs !== null && leaseEndMs < asOfMs;
    const monthToMonth = leaseEndInPast && l.status !== 'Expired';

    // monthsToExpiry: use the workbook-computed field (most accurate), fallback to computation
    const mte: number | null = (() => {
      if (l.monthsToExpiry !== null && Number.isFinite(l.monthsToExpiry)) return l.monthsToExpiry;
      if (l.leaseEnd) return monthsBetween(l.leaseEnd, asOf);
      return null;
    })();

    // tenureMonths: (asOf - leaseStart) in months; null if no leaseStart
    const tenureMonths: number | null = l.leaseStart
      ? Math.max(0, monthsBetween(asOf, l.leaseStart))
      : null;

    const expiryBucket = bucketExpiry(mte, l.leaseEnd, asOf);

    // ── Renewal likelihood band table (first match wins) ─────────────────────
    let likelihood: RenewalLikelihood;
    let rationale: string;

    if (stage === 'LOI' || stage === 'Executed') {
      likelihood = 'likely';
      rationale = `Renewal ${stage} in hand`;
    } else if (monthToMonth || (leaseEndInPast && stage === null)) {
      likelihood = 'lapsing';
      rationale = leaseEndInPast
        ? 'Lease end passed — holdover/month-to-month, no renewal stage'
        : 'Month-to-month exposure — no fixed end date';
    } else if (
      arrearsUsd >= ALERT_THRESHOLDS.arrearsMaterialUsd &&
      mte !== null && mte <= 12
    ) {
      likelihood = 'at-risk';
      rationale = `Material arrears (${arrearsUsd.toFixed(0)}) with ≤12m to expiry`;
    } else if (
      tenureMonths !== null && tenureMonths >= 36 &&
      arrearsUsd === 0 &&
      mte !== null && mte <= 12
    ) {
      likelihood = 'likely';
      rationale = `Long-term tenant (${Math.round(tenureMonths)}m tenure), current on rent, expiring soon`;
    } else if (mte !== null && mte <= 6 && (stage === null || stage === 'Expiring')) {
      likelihood = 'at-risk';
      rationale = `≤6m to expiry with no renewal activity`;
    } else {
      likelihood = 'uncertain';
      rationale = 'Insufficient signals to assess renewal probability';
    }

    out.push({
      leaseId: l.id,
      tenantName: l.company ?? l.tenantName,
      propertyId: l.propertyId,
      propertyKey: l.propertyKey,
      annualRent: l.annualRent,
      sf: l.sf,
      leaseEnd: l.leaseEnd,
      monthsToExpiry: mte,
      expiryBucket,
      tenureMonths,
      renewalStage: stage,
      arrearsUsd,
      monthToMonth,
      likelihood,
      rationale,
    });
  }

  return out;
}

// ── marketRentGaps ────────────────────────────────────────────────────────────
/**
 * Compute market-rent gap for each lease. `marketRents` is the user-supplied manual overlay:
 * Record<propertyKey|leaseId, number> — $/SF PSF. `feedRents` (optional) is the lease-market
 * asking-rent feed (server/warehouse/lease-market/feed.ts), Record<propertyKey, number>, used
 * ONLY as an informational fallback for THIS display — never merged into rentForecast's NOI math.
 *
 * Lookup order: manual leaseId ▸ manual propertyKey ▸ feed propertyKey. A non-positive/invalid
 * value at any step is treated as missing and falls through to the next step. If nothing resolves
 * → absent (not fabricated).
 * gapPsf = marketPsf - currentRentPsf (positive = market above in-place = upside)
 * underMarket = gapPsf > 0 (market > in-place)
 * provenance = 'derived' when a manual value resolved it, 'derived-asking' when only the feed did.
 */
export function marketRentGaps(
  leases: Lease[],
  marketRents: Record<string, number>,
  feedRents: Record<string, number> = {},
): MarketRentGap[] {
  const out: MarketRentGap[] = [];
  const valid = (v: number | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

  for (const l of leases) {
    // Derive current PSF — prefer rentPerSf if available, else compute from annualRent/sf
    const currentRentPsf: number | null = (() => {
      if (l.rentPerSf !== null && Number.isFinite(l.rentPerSf)) return l.rentPerSf;
      if (l.sf > 0 && Number.isFinite(l.annualRent)) return l.annualRent / l.sf;
      return null;
    })();

    // Market rent lookup: manual leaseId ▸ manual propertyKey ▸ lease-market feed (propertyKey).
    const manual = valid(marketRents[l.id]) ?? valid(marketRents[l.propertyKey]);
    const fromFeed = manual === null ? valid(feedRents[l.propertyKey]) : null;
    const marketRentPsf: number | null = manual ?? fromFeed;

    if (marketRentPsf === null) {
      // No market rent — return absent record (do not skip to preserve visibility)
      out.push({
        leaseId: l.id,
        tenantName: l.company ?? l.tenantName,
        propertyKey: l.propertyKey,
        currentRentPsf,
        marketRentPsf: null,
        gapPsf: null,
        gapAnnualUsd: null,
        underMarket: false,
        provenance: 'absent',
      });
      continue;
    }

    const gapPsf = currentRentPsf !== null ? marketRentPsf - currentRentPsf : null;
    const gapAnnualUsd = gapPsf !== null && l.sf > 0 ? gapPsf * l.sf : null;
    const underMarket = gapPsf !== null && gapPsf > 0;

    out.push({
      leaseId: l.id,
      tenantName: l.company ?? l.tenantName,
      propertyKey: l.propertyKey,
      currentRentPsf,
      marketRentPsf,
      gapPsf,
      gapAnnualUsd,
      underMarket,
      provenance: manual !== null ? 'derived' : 'derived-asking',
    });
  }

  return out;
}

// ── rentForecast ──────────────────────────────────────────────────────────────
/**
 * Compute forward rent-roll forecast for a single scenario.
 *
 * Three scenarios:
 *   renew_at_current: projected = inPlace, delta = 0, noiImpact = 0
 *   renew_at_market:  for leases expiring within horizon, replace annualRent with
 *                     marketPsf*sf where market rent exists; others hold at current.
 *                     deltaUsd = sum of changes. noiImpactAnnualUsd = deltaUsd (NNN 1:1).
 *   vacancy_haircut:  projectedAnnualRent = inPlace - (expiringRentInHorizon * vacancyPct).
 *                     noiImpactAnnualUsd = -(expiringRentInHorizon * vacancyPct).
 *
 * expiringRentInHorizon = sum annualRent of leases where 0 ≤ monthsToExpiry ≤ horizonMonths.
 */
export function rentForecast(
  leases: Lease[],
  asOf: string,
  input: RentForecastInput,
  marketRents: Record<string, number>,
): RentForecastResult {
  const { scenario, horizonMonths, vacancyPct } = input;
  const assumptions: string[] = [];

  // Total in-place annual rent (all active leases)
  const inPlaceAnnualRent = leases.reduce((s, l) => s + l.annualRent, 0);

  // expiringRentInHorizon: 0 ≤ monthsToExpiry ≤ horizonMonths.
  // Use day-accurate signed months from leaseEnd to avoid calendar-month truncation: the workbook
  // field differenceInCalendarMonths returns 0 for a lease that expired earlier THIS month, which
  // would incorrectly include it as "expiring in the future". monthsBetween returns negative for past dates.
  const asOfMs = new Date(asOf).getTime();
  const expiringLeases = leases.filter((l) => {
    const mte = l.leaseEnd
      ? (new Date(l.leaseEnd).getTime() - asOfMs) / (DAY_MS * 30.4375)
      : (l.monthsToExpiry !== null && Number.isFinite(l.monthsToExpiry) ? l.monthsToExpiry : null);
    return mte !== null && Number.isFinite(mte) && mte >= 0 && mte <= horizonMonths;
  });
  const expiringRentInHorizon = expiringLeases.reduce((s, l) => s + l.annualRent, 0);

  assumptions.push(`Basis: Spine A rent roll (workbook contractual rents)`);
  assumptions.push(`Horizon: ${horizonMonths} months from ${asOf}`);
  assumptions.push(`Expiring leases in horizon: ${expiringLeases.length} leases, ${expiringRentInHorizon.toFixed(0)} annual rent`);

  if (scenario === 'renew_at_current') {
    assumptions.push('Scenario: all leases renew at current contractual rents — no change.');
    return {
      scenario,
      horizonMonths,
      inPlaceAnnualRent,
      projectedAnnualRent: inPlaceAnnualRent,
      deltaUsd: 0,
      noiImpactAnnualUsd: 0,
      expiringRentInHorizon,
      spine: 'A',
      assumptions,
    };
  }

  if (scenario === 'renew_at_market') {
    // For leases expiring within horizon: replace annualRent with marketPsf * sf where market rent exists
    let projectedAnnualRent = inPlaceAnnualRent;
    let leasesMissingMarket = 0;
    let leasesReplaced = 0;

    for (const l of expiringLeases) {
      const rawMarket = marketRents[l.id] ?? marketRents[l.propertyKey];
      const marketPsf = typeof rawMarket === 'number' && Number.isFinite(rawMarket) && rawMarket > 0
        ? rawMarket : null;
      if (marketPsf !== null && l.sf > 0) {
        const marketAnnual = marketPsf * l.sf;
        projectedAnnualRent += marketAnnual - l.annualRent;
        leasesReplaced++;
      } else {
        leasesMissingMarket++;
      }
    }

    const deltaUsd = projectedAnnualRent - inPlaceAnnualRent;
    assumptions.push(
      `Scenario: ${leasesReplaced} expiring leases reset to market rent (NNN — NOI impact 1:1).`,
    );
    if (leasesMissingMarket > 0) {
      assumptions.push(`${leasesMissingMarket} expiring leases held at current (no market rent in overlay).`);
    }
    assumptions.push('NNN leases: rent delta flows 1:1 to NOI (no opex offset).');
    // noiImpactAnnualUsd must be non-negative per RentForecastResult schema for projectedAnnualRent
    const projectedClamped = Math.max(0, projectedAnnualRent);

    return {
      scenario,
      horizonMonths,
      inPlaceAnnualRent,
      projectedAnnualRent: projectedClamped,
      deltaUsd,
      noiImpactAnnualUsd: deltaUsd,
      expiringRentInHorizon,
      spine: 'A',
      assumptions,
    };
  }

  // vacancy_haircut
  if (scenario === 'vacancy_haircut') {
    const haircut = expiringRentInHorizon * vacancyPct || 0; // || 0 eliminates -0
    const projectedAnnualRent = Math.max(0, inPlaceAnnualRent - haircut);
    const noiImpactAnnualUsd = -(haircut) || 0; // -(0) is -0; || 0 normalizes

    assumptions.push(
      `Scenario: ${(vacancyPct * 100).toFixed(0)}% of expiring rent (${expiringRentInHorizon.toFixed(0)}) assumed not to renew.`,
    );
    assumptions.push(`Haircut: ${haircut.toFixed(0)} (annual NOI impact on NNN leases).`);
    assumptions.push('NNN leases: vacancy haircut flows 1:1 to NOI (no opex recovery).');

    return {
      scenario,
      horizonMonths,
      inPlaceAnnualRent,
      projectedAnnualRent,
      deltaUsd: projectedAnnualRent - inPlaceAnnualRent,
      noiImpactAnnualUsd,
      expiringRentInHorizon,
      spine: 'A',
      assumptions,
    };
  }

  // Exhaustive — TypeScript should catch unreachable, but guard defensively
  throw new Error(`Unknown scenario: ${scenario as string}`);
}
