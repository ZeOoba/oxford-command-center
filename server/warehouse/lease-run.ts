// server/warehouse/lease-run.ts
//
// Pure, deterministic lease-run pro forma engine for the PFI feature.
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Engine section).
//
// projectLeaseRun(lease, assumptions) → LeaseRunProjection. The math is IDENTICAL to the v1.0
// Excel models (build_proformas.py) — the golden reconciliation test (tests/unit/lease-run.test.ts)
// is the backstop. No I/O, no governor constants, no firm-figure source reads — a property's
// forward contractual cashflow given its lease terms and a set of overlay-overridable assumptions.
//
// NNN-net model (Behavior contract #2): for NNN / absolute-NNN structures, recoveries are
// pass-through, so EGR is NET to landlord — the engine NEVER adds reimbursement income or opex.
// A non-NNN structure throws (explicitly unsupported in v1) rather than silently mis-modeling.
import {
  LeaseRunAssumptions,
  isAssumptionStatus,
  type LeaseRunProjection,
  type LeaseRunPeriod,
  type LeaseTerm,
  type MarkToMarket,
} from '../../src/contracts/lease-run';
import { DAY_MS } from './time-constants';

/** Spec defaults — overridable via the overlay. None of these is a governor. */
export const DEFAULT_LEASE_RUN_ASSUMPTIONS: LeaseRunAssumptions = LeaseRunAssumptions.parse({
  managementFeePct: 0.03,
  roofStructuralReservePsf: 0.15,
  vacancyCreditLossPct: 0.0,
  renewalMarketGrowthPct: 0.03,
  indicativeCapRate: 0.08,
});

/** NNN-family structures the engine supports in v1 (EGR is net-to-landlord). */
const NNN_STRUCTURES = new Set(['absolute_nnn', 'nnn']);

/** A full lease-year spans ~365 days; anything materially shorter is a partial/stub period that
 *  must NOT be chosen for stabilization. 360 days is a safe floor (leap years, month boundaries). */
const FULL_YEAR_MIN_DAYS = 360;

/** Inclusive day-span of a [start, end] period (both ISO 'YYYY-MM-DD'); end-inclusive +1 day. */
function periodDays(periodStart: string, periodEnd: string): number {
  const a = Date.parse(periodStart);
  const b = Date.parse(periodEnd);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/**
 * Project a single lease's forward cashflow. Pure: same inputs → same output.
 *
 * Per period:
 *   baseRent     = schedule rent, OR (option_assumed) prior projected rent × (1 + growth) — compounding
 *   egr          = baseRent × (1 − vacancyCreditLossPct)            [NNN: net, no recoveries]
 *   managementFee= −egr × managementFeePct                          [negative]
 *   reserve      = −sf × roofStructuralReservePsf                   [negative; constant across years]
 *   noi          = egr + managementFee + reserve
 * Stabilized NOI = first FULL forward lease-year NOI; indicativeValue = stabilizedNoi / capRate.
 */
export function projectLeaseRun(lease: LeaseTerm, assumptions: LeaseRunAssumptions): LeaseRunProjection {
  // Behavior contract #2: non-NNN throws (explicitly unsupported in v1).
  if (!NNN_STRUCTURES.has(lease.structure)) {
    throw new Error(
      `lease-run: structure '${lease.structure}' is not NNN-family — unsupported in v1 (only absolute_nnn / nnn are modeled net-of-opex)`,
    );
  }

  const sf = lease.rentableSf;
  const reserve = -sf * assumptions.roofStructuralReservePsf; // constant landlord cost across all years

  // Behavior contract #4: empty terms → typed empty projection, no crash.
  if (lease.rentSchedule.length === 0) {
    return {
      propertyId: lease.propertyId,
      tenant: lease.tenant,
      rentableSf: sf,
      structure: lease.structure,
      currentExpiry: lease.currentExpiry,
      assumptions,
      assumptionsAreDefault: assumptionsAreDefault(assumptions),
      periods: [],
      stabilizedNoi: null,
      stabilizedYearLabel: null,
      indicativeValue: null,
      indicativeValuePsf: null,
      diligenceNotes: lease.diligenceNotes,
      isEmpty: true,
    };
  }

  const periods: LeaseRunPeriod[] = [];
  let priorBaseRent: number | null = null;
  let priorNoi: number | null = null;

  for (const entry of lease.rentSchedule) {
    // option_assumed rows have no fixed rate → grow the PRIOR projected rent (compounding).
    // Contractual / renewal_exercised / option_contractual rows carry a hard number and NEVER grow,
    // so renewalMarketGrowthPct can only ever touch option_assumed rows (Behavior contract #3).
    let baseRent: number;
    if (entry.status === 'option_assumed') {
      const prior = priorBaseRent ?? entry.annualBaseRent ?? 0;
      baseRent = prior * (1 + assumptions.renewalMarketGrowthPct);
    } else {
      // Hard-data rows must carry a rent; fall back to prior only defensively (never expected).
      baseRent = entry.annualBaseRent ?? priorBaseRent ?? 0;
    }

    const baseRentPsf = sf > 0 ? baseRent / sf : 0;
    const egr = baseRent * (1 - assumptions.vacancyCreditLossPct); // NNN: net, no reimbursements
    const managementFee = -egr * assumptions.managementFeePct;
    const noi = egr + managementFee + reserve;
    const noiPsf = sf > 0 ? noi / sf : 0;
    const noiGrowthYoY = priorNoi !== null && priorNoi !== 0 ? noi / priorNoi - 1 : null;

    periods.push({
      leaseYearLabel: entry.leaseYearLabel,
      periodStart: entry.periodStart,
      periodEnd: entry.periodEnd,
      status: entry.status,
      isAssumption: isAssumptionStatus(entry.status),
      baseRent,
      baseRentPsf,
      egr,
      managementFee,
      reserve,
      noi,
      noiPsf,
      noiGrowthYoY,
    });

    priorBaseRent = baseRent;
    priorNoi = noi;
  }

  // Stabilized NOI: the first FULL lease-year of DURABLE go-forward income — never a partial/stub
  // (adversarial #5) and never an expiring initial-term tail year. Rule (reproduces both Excel
  // models exactly): if a renewal has been EXERCISED, the locked go-forward rate is the first
  // renewal_exercised full year (Fishel LY'26 initial-term tail is skipped in favour of LY'27);
  // otherwise it is the first full contractual/forward year (Sunburst LY'27). Falls back to the
  // first full year, then the first period, for degenerate inputs.
  const isFullYear = (p: LeaseRunPeriod): boolean =>
    periodDays(p.periodStart, p.periodEnd) >= FULL_YEAR_MIN_DAYS;
  const hasExercisedRenewal = periods.some((p) => p.status === 'renewal_exercised');
  const stabilized =
    (hasExercisedRenewal
      ? periods.find((p) => p.status === 'renewal_exercised' && isFullYear(p))
      : periods.find((p) => p.status === 'contractual' && isFullYear(p))) ??
    periods.find(isFullYear) ??
    periods[0]!;
  const stabilizedNoi = stabilized.noi;
  const indicativeValue =
    assumptions.indicativeCapRate > 0 ? stabilizedNoi / assumptions.indicativeCapRate : null;
  const indicativeValuePsf = indicativeValue !== null && sf > 0 ? indicativeValue / sf : null;

  return {
    propertyId: lease.propertyId,
    tenant: lease.tenant,
    rentableSf: sf,
    structure: lease.structure,
    currentExpiry: lease.currentExpiry,
    assumptions,
    assumptionsAreDefault: assumptionsAreDefault(assumptions),
    periods,
    stabilizedNoi,
    stabilizedYearLabel: stabilized.leaseYearLabel,
    indicativeValue,
    indicativeValuePsf,
    diligenceNotes: lease.diligenceNotes,
    isEmpty: false,
  };
}

/** True iff the assumptions equal the spec defaults (UI shows a "default" vs "overridden" chip). */
export function assumptionsAreDefault(a: LeaseRunAssumptions): boolean {
  const d = DEFAULT_LEASE_RUN_ASSUMPTIONS;
  return (
    a.managementFeePct === d.managementFeePct &&
    a.roofStructuralReservePsf === d.roofStructuralReservePsf &&
    a.vacancyCreditLossPct === d.vacancyCreditLossPct &&
    a.renewalMarketGrowthPct === d.renewalMarketGrowthPct &&
    a.indicativeCapRate === d.indicativeCapRate
  );
}

/** Merge a partial overlay override onto the defaults (any field the overlay omits stays default). */
export function resolveAssumptions(partial: Partial<LeaseRunAssumptions> | undefined): LeaseRunAssumptions {
  return LeaseRunAssumptions.parse({ ...DEFAULT_LEASE_RUN_ASSUMPTIONS, ...(partial ?? {}) });
}

/** A cohort $/SF benchmark for the mark-to-market chip (reuses the benchmarks engine's shape). */
export interface CohortRentBenchmark {
  median: number | null;
  p25: number | null;
  n: number;
}

/**
 * Below-market (rollover-upside) flag. "Current" $/SF is the FIRST (in-place) period's base
 * rent $/SF — the rate a re-leasing event would mark to market against the cohort median. Fires
 * when current is materially below the cohort median (and a cohort exists). Pure; null-safe.
 */
export function computeMarkToMarket(
  projection: LeaseRunProjection,
  cohort: CohortRentBenchmark,
): MarkToMarket {
  const inPlace = projection.periods[0] ?? null;
  const currentBaseRentPsf = inPlace ? inPlace.baseRentPsf : null;
  const median = cohort.median;
  const belowMarket =
    currentBaseRentPsf !== null && median !== null && cohort.n > 0 && currentBaseRentPsf < median;
  const upsidePct =
    belowMarket && currentBaseRentPsf !== null && currentBaseRentPsf > 0 && median !== null
      ? (median - currentBaseRentPsf) / currentBaseRentPsf
      : null;
  return {
    propertyId: projection.propertyId,
    currentBaseRentPsf,
    cohortMedianPsf: median,
    cohortP25Psf: cohort.p25,
    cohortN: cohort.n,
    belowMarket,
    upsidePct,
  };
}
