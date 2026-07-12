import type { PortfolioSnapshot, MacroSnapshot } from '@contracts/index';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtMonths, fmtDate } from './format';
import type { Insight, InsightSeverity } from './types';
import { tenantScorecards } from '@/brain/tenants';
import { coerceNonNegMoney } from '@/lib/money';
import { renewalSignals, marketRentGaps, bucketExpiry } from './lease-forecast';
import { DAY_MS } from '../../server/warehouse/time-constants';
const HOUR_MS = 3_600_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

/** Single source of truth for every alert threshold. Change a number once, here. */
export const ALERT_THRESHOLDS = {
  balloonCriticalDays: 180,
  balloonWarningDays: 365,
  dscrFloor: 1.1,
  dscrWatch: 1.25,
  ltvGovernor: 0.40, // B3: the ratified LTV governor (capital-config.ts ltvCeiling) — info-level "above governor"
  ltvCeiling: 0.65,
  leaseCriticalDays: 60,
  leaseWarningDays: 180,
  insuranceRenewWarnDays: 30,
  cashConcentrationWarn: 0.3,
  tenantNoiConcentrationInfo: 0.15,
  // Collections (audit Fix #2; refute F2): any dollars genuinely 60+ days past due (d90 + d90plus)
  // → critical; otherwise a ≤60-day balance (d30 + d60) at/above this floor → warning. Small
  // short-dated balances are normal and suppressed.
  arrearsMaterialUsd: 5000,
  arStalenessMaxDays: 35,
  workbookStaleHours: 48,
  loiDeadlineWarnDays: 14,
  // Phase 2 slice 1 / M3 — refi-spread signal.
  // estimatedMarketRate: fallback 6.5% proxy for 5-year fixed industrial used when the live
  //   DGS5 snapshot is unavailable. The live path threads cachedMarketRate via EvaluateOpts
  //   (server call sites extract DGS5 from getMacro() and add industrialLenderSpread).
  //   The refi alert NEVER drops silently — this fallback is always active when no live rate is supplied.
  estimatedMarketRate: 0.065,
  // industrialLenderSpread: credit spread above DGS5 (5-Year Treasury) for a 5-year fixed
  //   industrial loan. 2.0% (200 bps) is the ORA canonical assumption — converts the raw DGS5
  //   rate to an all-in effective borrowing rate. Used by extractDgs5MarketRate() in the server
  //   macro layer.
  //   Rationale: DGS5 ≈ 4.0–4.5% + 200 bps spread ≈ 6.0–6.5%, consistent with the
  //   estimatedMarketRate fallback (6.5%). Distinct from CAPITAL_CONFIG.refiTriggerBps (150 bps),
  //   which is the minimum excess-over-market that triggers a refi recommendation — not the spread.
  //   This constant is subject to ORA market-assumption review, NOT the hard-invariant gate in
  //   capital-config.ts (DSCR/LTV). Any change here requires a comment explaining the market basis.
  industrialLenderSpread: 0.020,
  // refiSpreadBps: minimum excess above estimatedMarketRate that triggers the refi-spread signal.
  // 0.005 = 50 bps. A loan must exceed estimatedMarketRate + refiSpreadBps to fire.
  refiSpreadBps: 0.005,
  // Phase 3 — Lease forecast signal thresholds.
  // expiryNoSignalDays: ≤90d expiry with no renewal stage advance triggers L-1.
  expiryNoSignalDays: 90,
  // marketRentGapWarnPct: current ≥10% below market triggers L-4 under-market signal.
  marketRentGapWarnPct: 0.10,
  // lapsedHoldoverGraceDays: leaseEnd past with no Executed stage triggers L-2.
  lapsedHoldoverGraceDays: 0,
  // velocitySlowDays: median time-to-lease above this threshold → slowLeasing flag [RATIFIED 60].
  velocitySlowDays: 60,
} as const;

/**
 * Extract the effective market rate for the refi-spread signal from a MacroSnapshot.
 *
 * Base: DGS5 (5-Year Treasury) — the canonical benchmark for a 5-year fixed industrial loan.
 * Formula: DGS5 (as decimal) + ALERT_THRESHOLDS.industrialLenderSpread (200 bps)
 *   e.g. DGS5 = 4.18% → 0.0418 + 0.020 = 0.0618
 *
 * Benchmark rationale: the debt-api.ts refi-score path also uses DGS5 as its 5Y benchmark
 * (server/warehouse/debt-api.ts); using the same benchmark here keeps the two refi signals
 * coherent. The +200 bps lender spread converts the raw treasury rate to an all-in borrowing
 * cost — the debt-api path intentionally omits this spread (it treats DGS5 as the threshold
 * directly for scorecard purposes); the conditions.ts signal includes it to model the actual
 * borrowing rate ORA would face.
 *
 * Returns null when the DGS5 indicator is absent, null, or non-finite — the caller falls
 * back to ALERT_THRESHOLDS.estimatedMarketRate (0.065). Never throws.
 *
 * IMPORTANT: This function is a pure data extraction helper — it does NOT fetch anything.
 * The macro snapshot must already be in memory (e.g., from getMacro() on the server).
 * Call sites: server/brief/run.ts. NEVER import/call from client-side Spine-A code directly
 * — the snapshot must be passed, not fetched. (M3)
 */
export function extractDgs5MarketRate(macro: MacroSnapshot): number | null {
  const dgs5 = macro.indicators.find((ind) => ind.id === 'DGS5');
  if (!dgs5 || dgs5.value === null || !Number.isFinite(dgs5.value)) return null;
  // DGS5 value is in percent (e.g., 4.18 for 4.18%). Convert to decimal + add lender spread.
  const rate = dgs5.value / 100 + ALERT_THRESHOLDS.industrialLenderSpread;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Derive the annual debt service from the available Loan fields.
 *
 * Priority (first non-null, finite path wins):
 *   1. monthlyPmt * 12       — most direct; represents actual cash outflow.
 *   2. (annualInterest ?? 0) + (annualPrincipal ?? 0)
 *                            — sum of interest + scheduled principal; used when monthlyPmt is
 *                              absent but component fields are populated (e.g. IO loans that
 *                              report annualInterest only with annualPrincipal = 0).
 *   3. absBalance * rate     — rate-fallback for amortizing/balloon loans where payment fields
 *                              are missing. Uses absBalance (magnitude), NEVER the signed
 *                              currentBalance, to avoid producing a negative debt service for
 *                              lender-side rows. Produces interest-only estimate; principal is
 *                              ignored (conservative: understates service slightly for amortizing).
 *   4. null                  — no derivation possible.
 *
 * Every numeric input is coerced through Number.isFinite — a NaN or Infinity from a partially-
 * populated overlay record is treated as unavailable rather than silently propagating.
 */
function annualDebtService(l: {
  monthlyPmt: number | null;
  annualInterest: number | null;
  annualPrincipal: number | null;
  rate: number | null;
  absBalance: number;
}): number | null {
  // Path 1: monthly payment
  if (l.monthlyPmt !== null && Number.isFinite(l.monthlyPmt)) {
    return l.monthlyPmt * 12;
  }
  // Path 2: annual interest + principal components
  const hasInterest = l.annualInterest !== null && Number.isFinite(l.annualInterest);
  const hasPrincipal = l.annualPrincipal !== null && Number.isFinite(l.annualPrincipal);
  if (hasInterest || hasPrincipal) {
    return (hasInterest ? (l.annualInterest as number) : 0) +
           (hasPrincipal ? (l.annualPrincipal as number) : 0);
  }
  // Path 3: rate fallback — interest-only estimate using absBalance (magnitude)
  if (
    l.rate !== null &&
    Number.isFinite(l.rate) &&
    Number.isFinite(l.absBalance) &&
    l.absBalance > 0
  ) {
    return l.absBalance * l.rate;
  }
  return null;
}

export interface EvaluateOpts {
  /** Wall-clock now (ms) for the workbook-stale check. Defaults to Date.now(); injected in tests. */
  now?: number;
  /** dealId → stage at last brief. Supplied only by the email brief to emit stage-move alerts. */
  priorStages?: Record<string, string>;
  /**
   * Effective market rate to use for the refi-spread signal (DGS10 + lender spread, expressed as a
   * decimal, e.g. 0.060 for 6.00%). Sourced from the server-side macro snapshot (getMacro()) and
   * threaded in by the server call site — never fetched live from within evaluateConditions.
   *
   * When absent, non-finite, or null: falls back to ALERT_THRESHOLDS.estimatedMarketRate (0.065).
   * The refi alert NEVER drops silently — the fallback is always used when the live rate is
   * unavailable. Provenance is surfaced in the insight detail string.
   *
   * CONSTRAINT: evaluateConditions MUST NOT call fetchFredMacro() or perform any live HTTP.
   * This field is the only acceptable mechanism for injecting a live rate. (M3)
   */
  cachedMarketRate?: number;
  /**
   * Day-count reference date (YYYY-MM-DD) for every "expires/matures in Nd" computation.
   * The email brief passes its RUN date so alert day-counts track today (frozen-dateline
   * defect, 2026-07: meta.asOf pinned every count at the workbook data date). Defaults to
   * `s.meta.asOf` for backward compatibility with UI/tool callers.
   */
  referenceDate?: string;
}

/**
 * The single canonical alert engine. Pure. Replaces generateInsights + extendedInsights.
 * Date math uses opts.referenceDate when supplied (the brief's run date), else the snapshot's
 * asOf (stable across a refresh); only the workbook-stale check uses wall-clock now.
 */
export function evaluateConditions(s: PortfolioSnapshot, opts: EvaluateOpts = {}): Insight[] {
  const T = ALERT_THRESHOLDS;
  const asOf = opts.referenceDate ?? s.meta.asOf;
  const now = opts.now ?? Date.now();
  const out: Insight[] = [];

  // M3: Resolve the effective market rate for the refi-spread signal.
  // Priority: cachedMarketRate (threaded from server macro layer, no live HTTP) → fallback 0.065.
  // A non-finite or missing value from the snapshot falls back gracefully; the refi alert never
  // drops silently. Provenance is surfaced in the detail string so the reader knows the source.
  const effectiveMarketRate =
    opts.cachedMarketRate !== undefined &&
    opts.cachedMarketRate !== null &&
    Number.isFinite(opts.cachedMarketRate)
      ? opts.cachedMarketRate
      : T.estimatedMarketRate;
  const marketRateProvenance = effectiveMarketRate !== T.estimatedMarketRate ? 'live' : 'fallback';

  // ── Debt ──────────────────────────────────────────────────────────────────
  for (const l of s.loans) {
    if (l.balloon && l.maturity) {
      const days = daysBetween(l.maturity, asOf);
      if (days <= T.balloonWarningDays) {
        // Phase 2 slice 1 — balloon impactAnnualUsd derivation.
        //
        // impactAnnualUsd = annualDebtService(l) × min(monthsRemaining / 12, 1.0)
        //
        // monthsRemaining: days / 30, days already computed above from `asOf` (the live reference
        //   date, see conditions.ts module docstring) — NOT l.monthsToMaturity, a workbook column
        //   frozen at the data-month date (frozen-dateline defect, 2026-07: severity here already
        //   used `days`, but the impact dollar figure and detail string still preferred the stale
        //   column, silently mixing bases and overstating/understating impact by however far the
        //   run date has drifted from the workbook date). Clamp to ≥ 0 — a past-due/overdue
        //   balloon has monthsRemaining = 0, producing a factor of 0. We never let a negative
        //   factor reduce impact below zero, because a past-due balloon is strictly MORE urgent,
        //   not less — the displayed impact would be misleading if negative. Factor is then
        //   clamped at 1.0 (ceiling): a balloon 24+ months out carries a full-year service load.
        //
        // provenance:
        //   'derived'  — impact was computed from Loan fields (not a directly-stored dollar).
        //   'absent'   — annualDebtService returned null; no derivation possible.
        const ds = annualDebtService(l);
        let impactAnnualUsd: number | null = null;
        let provenance: Insight['provenance'] = 'absent';
        const monthsRemaining = Math.max(0, days / 30);
        if (ds !== null) {
          const factor = Math.min(monthsRemaining / 12, 1.0);
          impactAnnualUsd = ds * factor;
          provenance = 'derived';
        }

        out.push({
          id: `balloon-${l.id}`,
          severity: days < T.balloonCriticalDays ? 'critical' : 'warning',
          category: 'debt',
          title: `Balloon due — ${l.name}`,
          detail: `${fmtUsd(l.absBalance)} balance, balloon ${fmtDate(l.maturity)} (${fmtMonths(monthsRemaining)}). Prepare refinance or payoff.`,
          metric: fmtUsd(l.absBalance),
          entityType: 'loan',
          entityId: l.id,
          action: { label: 'Open refi workspace', kind: 'open-refi' },
          impactAnnualUsd,
          spine: 'B',
          provenance,
        });
      }
    }

    // Phase 2 slice 1 — refi-spread-opportunity signal.
    //
    // Fires when a borrower-direction loan's in-place rate exceeds the hardcoded market-rate
    // proxy by more than refiSpreadBps. Only 'borrower' loans qualify — Oxford pays interest on
    // those; a 'lender' or 'internal' loan has no refinanceable obligation on our side.
    //
    // impactAnnualUsd = (l.rate - estimatedMarketRate) × l.absBalance
    //   — the annualized interest savings if the loan were refinanced at the market proxy today.
    //   Uses absBalance (magnitude), never the signed currentBalance.
    //   Guard: absBalance must be > 0 (a zero-balance loan has no savings).
    //
    // provenance: 'derived' — computed from Loan.rate × Loan.absBalance; not a stored dollar.
    if (
      l.direction === 'borrower' &&
      l.rate !== null &&
      Number.isFinite(l.rate) &&
      Number.isFinite(l.absBalance) &&
      l.absBalance > 0 &&
      l.rate > effectiveMarketRate + T.refiSpreadBps
    ) {
      const rateDelta = l.rate - effectiveMarketRate;
      const marketRatePct = (effectiveMarketRate * 100).toFixed(2) + '%';
      const marketRateLabel = marketRateProvenance === 'live'
        ? `market ${marketRatePct} (FRED)`
        : `estimated market ${marketRatePct}`;
      out.push({
        id: `refi-spread-${l.id}`,
        severity: 'info',
        category: 'debt',
        title: `Refi spread — ${l.name}`,
        detail: `In-place rate ${(l.rate * 100).toFixed(2)}% vs ${marketRateLabel} — ${(rateDelta * 100).toFixed(2)}% spread on ${fmtUsd(l.absBalance)} balance. Estimated annual savings: ${fmtUsd(rateDelta * l.absBalance)}.`,
        entityType: 'loan',
        entityId: l.id,
        action: { label: 'Open refi workspace', kind: 'open-refi' },
        impactAnnualUsd: rateDelta * l.absBalance,
        spine: 'B',
        provenance: 'derived',
      });
    }
  }

  for (const p of s.properties) {
    if (p.dscr !== null && p.dscr < T.dscrFloor) {
      out.push({
        id: `dscr-floor-${p.id}`, severity: 'critical', category: 'debt',
        title: `DSCR below floor — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (below ${T.dscrFloor.toFixed(2)}x floor). Lender-remedy risk — act now.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    } else if (p.dscr !== null && p.dscr < T.dscrWatch) {
      out.push({
        id: `dscr-${p.id}`, severity: 'warning', category: 'debt',
        title: `DSCR below 1.25 — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (covenant watch). Review the loan.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    }
    if (p.ltv !== null && p.ltv > T.ltvCeiling) {
      out.push({
        id: `ltv-${p.id}`, severity: 'warning', category: 'debt',
        title: `LTV above 65% — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)} (above the ${fmtPct(T.ltvCeiling)} ceiling).`,
        metric: fmtPct(p.ltv), entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    } else if (p.ltv !== null && p.ltv > T.ltvGovernor) {
      // B3 Option B: above the ratified LTV governor (≤40%) but within the operational ceiling —
      // an info-level signal so a governor deviation is visible without warning-noise on every levered property.
      out.push({
        id: `ltv-governor-${p.id}`, severity: 'info', category: 'debt',
        title: `LTV above governor — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)} — above the ${fmtPct(T.ltvGovernor)} portfolio governor (LTV ≤ 40%).`,
        metric: fmtPct(p.ltv), entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    }
  }

  // ── Leases ────────────────────────────────────────────────────────────────
  for (const l of s.leases) {
    if (l.status === 'Expired') {
      out.push({
        id: `expired-${l.id}`, severity: 'warning', category: 'lease',
        title: `Lease expired — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} · ${fmtUsdCompact(l.annualRent)}/yr holding over. Resolve renewal or vacate.`,
        metric: fmtUsdCompact(l.annualRent), entityType: 'lease', entityId: l.id,
        action: { label: 'Draft renewal', kind: 'draft-renewal' },
        impactAnnualUsd: l.annualRent, spine: 'A', provenance: 'real',
      });
    } else if (l.leaseEnd) {
      const days = daysBetween(l.leaseEnd, asOf);
      const stage = s.renewalStages[l.id];
      const renewalUnderway = stage !== undefined && stage !== 'Expiring';
      if (days >= 0 && days <= T.leaseWarningDays && !renewalUnderway) {
        out.push({
          id: `expiring-${l.id}`,
          severity: days < T.leaseCriticalDays ? 'critical' : 'warning',
          category: 'lease',
          title: `Lease expiring — ${l.company ?? l.tenantName}`,
          detail: `${l.propertyKey} ${l.unit ?? ''} expires ${fmtDate(l.leaseEnd)} (${days}d). ${fmtUsdCompact(l.annualRent)}/yr at risk.`,
          metric: `${days}d`, entityType: 'lease', entityId: l.id,
          action: { label: 'Draft renewal', kind: 'draft-renewal' },
          impactAnnualUsd: l.annualRent, spine: 'A', provenance: 'real',
        });
      }
    }
    if (l.escalationDate && daysBetween(l.escalationDate, asOf) < 0) {
      out.push({
        id: `escalation-${l.id}`, severity: 'warning', category: 'lease',
        title: `Escalation date passed — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} escalation was due ${fmtDate(l.escalationDate)}. Confirm the bump was applied.`,
        entityType: 'lease', entityId: l.id,
        impactAnnualUsd: null, spine: 'A', provenance: 'absent',
      });
    }
  }

  // ── Phase 3 Lease Forecast Signals (L-1..L-5) ─────────────────────────────
  // These conditions extend the existing lease block. They consume renewalSignals() and
  // marketRentGaps() from the lease-forecast analytics engine (pure functions; no re-implementation).
  // All Insights: category:'lease', Spine A, provenance as noted.
  //
  // Dedup design:
  //   L-1 and L-2 are mutually exclusive (L-1 = future ≤90d; L-2 = past without Executed).
  //   L-3 co-fires with L-2 on the same holdover lease — they carry different messages (L-2=warning,
  //   L-3=info) and distinct IDs.
  //   L-4 fires only when a market rent is present in overlay (no fabrication).
  //   L-5 fires once per triggering bucket (not per-lease).
  {
    const arrears = s.tenantArrears ?? {};
    const marketRents = (s as PortfolioSnapshot & { marketRents?: Record<string, number> }).marketRents ?? {};
    const signals = renewalSignals(s.leases, asOf, s.renewalStages, arrears);
    const gaps = marketRentGaps(s.leases, marketRents);
    const asOfMs = new Date(asOf).getTime();

    // Build a total annual rent denominator for the L-5 concentration check
    const totalAnnualRent = s.leases.reduce((sum, l) => sum + l.annualRent, 0);

    for (const signal of signals) {
      const leaseEndMs = signal.leaseEnd ? new Date(signal.leaseEnd).getTime() : null;
      const leaseEndInPast = leaseEndMs !== null && leaseEndMs < asOfMs;
      const daysToExpiry = leaseEndMs !== null && !leaseEndInPast
        ? Math.round((leaseEndMs - asOfMs) / DAY_MS)
        : null;

      // L-1: Expiring ≤90d with no renewal signal (future expiry only)
      // Trigger: 0 ≤ daysToExpiry ≤ expiryNoSignalDays AND renewalStage ∈ {null, 'Expiring'}
      // Dedup: mutually exclusive with L-2 (L-2 = past expiry)
      if (
        daysToExpiry !== null &&
        daysToExpiry >= 0 &&
        daysToExpiry <= T.expiryNoSignalDays &&
        (signal.renewalStage === null || signal.renewalStage === 'Expiring')
      ) {
        out.push({
          id: `lease-expiry-${signal.leaseId}`,
          severity: 'critical',
          category: 'lease',
          title: `Expiring, no renewal signal — ${signal.tenantName}`,
          detail: `${signal.propertyKey}${signal.sf > 0 ? ` · ${signal.sf.toLocaleString()} SF` : ''} · expires in ${daysToExpiry}d · ${fmtUsdCompact(signal.annualRent)}/yr at risk. No renewal stage has advanced.`,
          metric: `${daysToExpiry}d`,
          entityType: 'lease',
          entityId: signal.leaseId,
          action: { label: 'Draft renewal', kind: 'draft-renewal' },
          impactAnnualUsd: signal.annualRent,
          spine: 'A',
          provenance: 'real',
        });
      }

      // L-2: Renewal lapsed / holdover (leaseEnd in past AND stage ≠ Executed)
      // Trigger: leaseEnd in past AND renewalStage ≠ 'Executed'
      if (leaseEndInPast && signal.renewalStage !== 'Executed') {
        out.push({
          id: `lease-lapsed-${signal.leaseId}`,
          severity: 'warning',
          category: 'lease',
          title: `Renewal lapsed / holdover — ${signal.tenantName}`,
          detail: `${signal.propertyKey} · lease end passed ${signal.leaseEnd ? fmtDate(signal.leaseEnd) : 'unknown'} with no executed renewal. ${fmtUsdCompact(signal.annualRent)}/yr on holdover.`,
          entityType: 'lease',
          entityId: signal.leaseId,
          action: { label: 'Draft renewal', kind: 'draft-renewal' },
          impactAnnualUsd: signal.annualRent,
          spine: 'A',
          provenance: 'real',
        });
      }

      // L-3: Month-to-month exposure (holdover, no fixed end)
      // Trigger: monthToMonth === true (leaseEnd in past AND status ≠ Expired — computed in renewalSignals)
      if (signal.monthToMonth) {
        out.push({
          id: `lease-mtm-${signal.leaseId}`,
          severity: 'info',
          category: 'lease',
          title: `Month-to-month exposure — ${signal.tenantName}`,
          detail: `${signal.propertyKey} · operating on holdover/MTM, no fixed lease end. ${fmtUsdCompact(signal.annualRent)}/yr is unprotected revenue.`,
          entityType: 'lease',
          entityId: signal.leaseId,
          impactAnnualUsd: signal.annualRent,
          spine: 'A',
          provenance: 'derived',
        });
      }
    }

    // L-4: Under-market lease (gap ≥ marketRentGapWarnPct AND market rent present)
    for (const gap of gaps) {
      if (
        gap.underMarket &&
        gap.gapPsf !== null &&
        gap.marketRentPsf !== null &&
        gap.gapAnnualUsd !== null &&
        gap.provenance !== 'absent'
      ) {
        // gapPct = gapPsf / marketRentPsf (positive = market above in-place)
        const gapPct = gap.gapPsf / gap.marketRentPsf;
        if (gapPct >= T.marketRentGapWarnPct) {
          out.push({
            id: `lease-undermarket-${gap.leaseId}`,
            severity: 'info',
            category: 'lease',
            title: `Under-market lease — ${gap.tenantName}`,
            detail: `${gap.propertyKey} · in-place ${gap.currentRentPsf !== null ? `$${gap.currentRentPsf.toFixed(2)}` : 'N/A'}/SF vs market $${gap.marketRentPsf.toFixed(2)}/SF — ${fmtPct(gapPct)} below market. Upside: ${fmtUsdCompact(gap.gapAnnualUsd)}/yr.`,
            entityType: 'lease',
            entityId: gap.leaseId,
            action: { label: 'Review', kind: 'review' },
            impactAnnualUsd: gap.gapAnnualUsd, // positive = upside
            spine: 'A',
            provenance: 'derived',
          });
        }
      }
    }

    // L-5: Concentrated rollover (one expiry bucket ≥ tenantNoiConcentrationInfo of total annual rent)
    // Checked buckets: '0-6m' and '6-12m' only (per spec §4)
    if (totalAnnualRent > 0) {
      const CONCENTRATION_BUCKETS = ['0-6m', '6-12m'] as const;
      for (const bucket of CONCENTRATION_BUCKETS) {
        // Sum annual rent for leases in this bucket using bucketExpiry
        const bucketRent = s.leases
          .filter((l) => bucketExpiry(l.monthsToExpiry, l.leaseEnd, asOf) === bucket)
          .reduce((sum, l) => sum + l.annualRent, 0);
        const bucketPct = bucketRent / totalAnnualRent;
        if (bucketPct >= T.tenantNoiConcentrationInfo) {
          out.push({
            id: `rollover-concentration-${bucket}`,
            severity: 'warning',
            category: 'lease',
            title: `Concentrated rollover — ${bucket} bucket`,
            detail: `${fmtPct(bucketPct)} of total annual rent (${fmtUsdCompact(bucketRent)}) expires in the ${bucket} window — above the ${fmtPct(T.tenantNoiConcentrationInfo)} concentration threshold.`,
            action: { label: 'Review', kind: 'review' },
            impactAnnualUsd: bucketRent,
            spine: 'A',
            provenance: 'derived',
          });
        }
      }
    }
  }

  // ── Collections / AR aging (audit Fix #2) ───────────────────────────────────
  // Overlay-sourced per-lease arrears (snapshot.tenantArrears, keyed by Lease.id). 60+ days past
  // due is a critical collection signal; a material balance under 60 days is a warning to monitor.
  // Defensive on BOTH the record's presence AND each bucket's value: tenantArrears is overlay-
  // sourced and is NOT re-parsed through Zod after the overlay merge (overlay.ts loads it with a
  // bare cast; applyOverlay spreads it raw — the documented QB-export / manual-entry path), so a
  // hand-edited or partial record can arrive with missing/non-numeric buckets. Trusting the field
  // types would make `undefined + number` → NaN, and every tier guard (`<= 0`, `> 0`, `>= floor`)
  // is false for NaN, silently SUPPRESSING a real delinquency — the worst direction for a
  // collections monitor. num() enforces the .default(0) intent for any non-finite bucket.
  //
  // Staleness gate: when ANY tenantArrears record is present but its asOfDate is null or older than
  // arStalenessMaxDays, the collection condition degrades to a single info-level stale-ar data
  // insight. No per-lease arrears alerts fire — stale data would produce misleading severity signals.
  // When no records exist at all, nothing fires (absence ≠ staleness).
  const arrears = s.tenantArrears ?? {};
  const arEntries = Object.values(arrears);
  // Staleness gate: only records that went through the Track-B import pipeline carry the asOfDate
  // field. Legacy/manually-entered records omit it entirely (undefined). Check staleness only when
  // at least one record has the field present, indicating it came through the stamped path.
  // undefined = pre-Track-B record = no freshness metadata = skip gate, evaluate normally.
  // null = Track-B ran, couldn't derive a date = treat as stale.
  // Date = Track-B record; check age against arStalenessMaxDays.
  // ALL stamped entries are evaluated — a single stale record in a mixed snapshot suppresses alerts.
  const stampedEntries = arEntries.filter((r) => 'asOfDate' in r);
  let skipArEval = false;
  if (stampedEntries.length > 0) {
    const staleAges = stampedEntries.map((r) => {
      const asOfMs = r.asOfDate ? new Date(r.asOfDate).getTime() : null;
      if (asOfMs === null || !Number.isFinite(asOfMs)) return null;
      return Math.floor((now - asOfMs) / DAY_MS);
    });
    const hasStale = staleAges.some((age) => age === null || age > T.arStalenessMaxDays);
    if (hasStale) {
      skipArEval = true;
      const finiteDays = staleAges.filter((d): d is number => d !== null);
      const worstAge = finiteDays.length > 0 ? Math.max(...finiteDays) : null;
      const detail = staleAges.some((d) => d === null)
        ? 'AR data: no import on record — run the QB AR export and import to enable collections monitoring.'
        : `AR data: last import was ${worstAge} days ago — refresh QB export to enable collections monitoring.`;
      out.push({
        id: 'ar-stale', severity: 'info', category: 'data',
        title: 'AR data stale — collections monitoring inactive',
        detail,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    }
  }
  // Each bucket goes through the SHARED coerceNonNegMoney (src/lib/money) — the exact same coercer
  // the overlay load boundary uses (parseArrears/coerceBudgets) — so the load path and this rule
  // agree on one coercion, ending the prior string/number asymmetry. A non-finite/missing bucket → 0
  // (no NaN-drop of a real balance), and a NEGATIVE bucket (an AR credit/prepayment) → 0 so it cannot
  // net DOWN the displayed total or drive `total <= 0` and suppress a genuine over-60 critical
  // (refute F3/edges). over60 is therefore always ≥ 0, so `total <= 0` skips only an all-zero record.
  if (!skipArEval) {
    const num = coerceNonNegMoney;
    for (const l of s.leases) {
      const ar = arrears[l.id];
      if (!ar) continue;
      // Aging buckets (src/contracts/quickbooks.ts): d30=1–30, d60=31–60, d90=61–90, d90plus=90+.
      // CRITICAL fires ONLY on dollars genuinely 60+ days past due (d90 + d90plus). The d30/d60 dollars
      // are ≤60 days late — routine collections follow-up — and fold into the under-60 material WARNING
      // tier. (refute F2: do NOT escalate a 31–60-day-late tenant to the critical 60+ tier.)
      const over60 = num(ar.d90) + num(ar.d90plus);
      const under60 = num(ar.d30) + num(ar.d60);
      const total = under60 + over60;
      if (total <= 0) continue;
      const who = l.company ?? l.tenantName;
      const where = `${l.propertyKey}${l.unit ? ` ${l.unit}` : ''}`;
      if (over60 > 0) {
        out.push({
          id: `arrears-${l.id}`, severity: 'critical', category: 'collections',
          title: `Tenant 60+ days past due — ${who}`,
          detail: `${where} · ${fmtUsd(over60)} is 60+ days past due (${fmtUsd(total)} total outstanding). Pursue collection.`,
          metric: fmtUsd(total), entityType: 'lease', entityId: l.id,
          impactAnnualUsd: total, spine: 'A', provenance: 'real',
        });
      } else if (total >= T.arrearsMaterialUsd) {
        out.push({
          id: `arrears-${l.id}`, severity: 'warning', category: 'collections',
          title: `Receivable outstanding — ${who}`,
          detail: `${where} · ${fmtUsd(total)} past due (under 60 days). Monitor for payment.`,
          metric: fmtUsd(total), entityType: 'lease', entityId: l.id,
          impactAnnualUsd: total, spine: 'A', provenance: 'real',
        });
      }
    }
  }

  // ── Revenue concentration (tenant > 15% of portfolio NOI) ───────────────────
  for (const t of tenantScorecards(s)) {
    if (t.pctNoi > T.tenantNoiConcentrationInfo) {
      out.push({
        id: `concentration-${t.id}`, severity: 'info', category: 'concentration',
        title: `Tenant concentration — ${t.name}`,
        detail: `${t.name} is ${fmtPct(t.pctNoi)} of portfolio NOI across ${t.properties.length} ${t.properties.length === 1 ? 'property' : 'properties'}.`,
        metric: fmtPct(t.pctNoi),
        impactAnnualUsd: null, spine: 'A', provenance: 'absent',
      });
    }
  }

  // ── Insurance ───────────────────────────────────────────────────────────────
  for (const p of s.insurance) {
    if (p.status === 'Expired' || p.status === 'Cancelled') {
      out.push({
        id: `ins-lapsed-${p.id}`, severity: 'critical', category: 'insurance',
        title: `Policy ${p.status.toLowerCase()} — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} · ${p.carrier ?? ''}. Confirm replacement coverage is bound.`,
        metric: fmtUsdCompact(p.premium), entityType: 'insurance', entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    } else if (p.expires !== null) {
      // Day-count from the policy's OWN expiry against the reference date — NOT the workbook's
      // raw daysToExpiry column (parse.ts:446), which is frozen at the workbook data date and
      // would render a stale positive "Nd" for an already-expired policy (frozen-dateline defect,
      // 2026-07: e.g. "renews Jun 20 (19d)" for a policy that lapsed 21 days ago) and could
      // contradict the warehouse ins-expiry-* insight (refDate-based) in the same brief.
      const days = daysBetween(p.expires, asOf);
      if (days < 0) {
        // F3: the ONLY other lapsed path (above) requires the workbook's own status column to
        // already read Expired/Cancelled — a manually-maintained field that can lag well behind
        // the actual expiry date. Without this branch, a policy that lapsed between the workbook
        // data date and the run date produced NO alert anywhere (the warehouse ins-expiry-*
        // condition also deliberately excludes days < 0 — that's Spine-A's job). Surface the
        // discrepancy explicitly rather than silently trusting the stale status text.
        out.push({
          id: `ins-lapsed-live-${p.id}`, severity: 'critical', category: 'insurance',
          title: `Policy lapsed — ${p.property}`,
          detail: `${p.coverage ?? 'Coverage'} expired ${fmtDate(p.expires)} (${-days}d ago) — workbook status still reads "${p.status}". Confirm replacement coverage is bound.`,
          metric: fmtUsdCompact(p.premium), entityType: 'insurance', entityId: p.id,
          action: { label: 'Review policy', kind: 'review' },
          impactAnnualUsd: null, spine: 'B', provenance: 'derived',
        });
      } else if (days < T.insuranceRenewWarnDays) {
        out.push({
          id: `ins-${p.id}`, severity: 'warning', category: 'insurance',
          title: `Insurance renewing soon — ${p.property}`,
          detail: `${p.coverage ?? 'Coverage'} renews ${fmtDate(p.expires)} (${days}d).`,
          entityType: 'insurance', entityId: p.id,
          action: { label: 'Review policy', kind: 'review' },
          impactAnnualUsd: null, spine: 'B', provenance: 'absent',
        });
      }
    } else if (p.daysToExpiry !== null && p.daysToExpiry >= 0 && p.daysToExpiry < T.insuranceRenewWarnDays) {
      // F6 (adversarial refute-financial-change finding): expires and daysToExpiry are
      // independently-parsed workbook columns (parse.ts col 6 vs col 10) — a row can carry a
      // populated daysToExpiry with a blank/unparseable Expires cell, which the `p.expires !==
      // null` branch above cannot compute a live day-count from. Without this fallback, such a
      // row silently produced NO alert at all, even though the pre-F3 code warned on it. No live
      // date to check against, so this stays on the workbook's own (frozen) count — say so.
      out.push({
        id: `ins-${p.id}`, severity: 'warning', category: 'insurance',
        title: `Insurance renewing soon — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} renews in ${p.daysToExpiry}d (workbook estimate — no expiry date on file).`,
        entityType: 'insurance', entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    }
  }

  // ── Cash concentration ──────────────────────────────────────────────────────
  if (s.cash.concentrationTopPct !== null && s.cash.concentrationTopPct > T.cashConcentrationWarn) {
    out.push({
      id: 'cash-concentration', severity: 'warning', category: 'concentration',
      title: `Cash concentration — ${s.cash.largestEntity}`,
      detail: `${fmtPct(s.cash.concentrationTopPct)} of total cash sits in one entity (above the ${fmtPct(T.cashConcentrationWarn)} ceiling).`,
      metric: fmtPct(s.cash.concentrationTopPct), entityType: 'cashEntity',
      impactAnnualUsd: null, spine: 'A', provenance: 'absent',
    });
  }

  // ── Data quality ────────────────────────────────────────────────────────────
  const reconFlags = s.dataQuality.filter((f) => f.entity === 'reconciliation');
  if (reconFlags.length > 0) {
    out.push({
      id: 'reconcile-fail', severity: 'critical', category: 'data',
      title: 'Reconciliation failure',
      detail: `${reconFlags.length} invariant ${reconFlags.length === 1 ? 'breach' : 'breaches'} (${reconFlags.map((f) => f.field).join(', ')}). Derived totals do not match the workbook.`,
      metric: String(reconFlags.length),
      impactAnnualUsd: null, spine: 'B', provenance: 'absent',
    });
  }
  const ageHrs = (now - new Date(s.meta.generatedAt).getTime()) / HOUR_MS;
  if (ageHrs > T.workbookStaleHours) {
    out.push({
      id: 'workbook-stale', severity: 'info', category: 'data',
      title: 'Workbook data is stale',
      detail: `Last parsed ${fmtDate(s.meta.generatedAt)} — ${Math.round(ageHrs)}h ago (over the ${T.workbookStaleHours}h limit). Refresh the source.`,
      metric: `${Math.round(ageHrs)}h`,
      impactAnnualUsd: null, spine: 'B', provenance: 'absent',
    });
  }

  // ── Deals ────────────────────────────────────────────────────────────────────
  for (const d of s.deals) {
    if (d.stage === 'LOI/PSA' && d.targetCloseDate) {
      const days = daysBetween(d.targetCloseDate, asOf);
      if (days >= 0 && days <= T.loiDeadlineWarnDays) {
        out.push({
          id: `loi-${d.id}`, severity: 'warning', category: 'deal',
          title: `LOI/PSA deadline — ${d.shortName ?? d.name}`,
          detail: `Target close ${fmtDate(d.targetCloseDate)} (${days}d). ${d.nextAction ?? 'Confirm next step.'}`,
          metric: `${days}d`, entityType: 'deal', entityId: d.id,
          impactAnnualUsd: null, spine: 'B', provenance: 'absent',
        });
      }
    }
  }
  const prior = opts.priorStages;
  if (prior && Object.keys(prior).length > 0) {
    for (const d of s.deals) {
      const from = prior[d.id];
      if (from !== undefined && from !== d.stage) {
        out.push({
          id: `move-${d.id}`, severity: 'info', category: 'deal',
          title: `Deal advanced — ${d.shortName ?? d.name}`,
          detail: `${from} → ${d.stage}. ${d.nextAction ?? ''}`.trim(),
          entityType: 'deal', entityId: d.id,
          impactAnnualUsd: null, spine: 'B', provenance: 'absent',
        });
      }
    }
  }

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => {
    const sevDiff = rank[a.severity] - rank[b.severity];
    if (sevDiff !== 0) return sevDiff;
    // Secondary key: impactAnnualUsd DESC, nulls last.
    const aAmt = a.impactAnnualUsd;
    const bAmt = b.impactAnnualUsd;
    if (aAmt !== null && bAmt !== null) {
      const amtDiff = bAmt - aAmt;
      if (amtDiff !== 0) return amtDiff;
      // fall through to the id tie-break below on an exact-amount tie (e.g. two past-due
      // balloons, both clamped to impact 0) — do NOT `return amtDiff` (0) here, or the
      // tie-break below never runs.
    } else if (aAmt !== null) {
      return -1; // a has dollar, b is null → a first
    } else if (bAmt !== null) {
      return 1;  // b has dollar, a is null → b first
    }
    // Tertiary key: id ASC. A tie on severity + impactAnnualUsd (e.g. two past-due balloons,
    // both clamped to impact 0 by the F2 fix) otherwise falls back to s.loans/s.leases/etc.
    // iteration order — deterministic given a fixed array, but not stable against a future
    // caller that reorders/merges input differently. Matches the id-based tie-breaker already
    // used in capital-allocation.ts and insurance-conditions.ts.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Additive metadata enrichment pass — fills `impactAnnualUsd`, `spine`, and `provenance`
 * on an insight that was constructed with placeholder defaults. Pure: returns a new object,
 * never mutates the input.
 *
 * Called at the consumption layer (useAlertView, brief pipeline) after evaluateConditions()
 * so the core engine stays snapshot-pure.
 *
 * Spine assignment:
 *   A (revenue-critical): lease, collections, occupancy, concentration
 *   B (compliance/cost):  debt, insurance, deal, data, anomaly
 *
 * Impact:
 *   collections → total outstanding arrears (real; from entityId → tenantArrears)
 *   lease       → annualRent of the matched lease (real)
 *   all others  → null / absent (no derivation attempted — avoids speculative dollar fabrication)
 */
export function fillImpact(insight: Insight, snapshot: PortfolioSnapshot): Insight {
  const SPINE_A_CATEGORIES: ReadonlySet<Insight['category']> = new Set([
    'lease', 'collections', 'occupancy', 'concentration',
  ]);

  const spine: Insight['spine'] = SPINE_A_CATEGORIES.has(insight.category) ? 'A' : 'B';

  // For categories where we already have a real dollar amount on the insight, pass it through.
  // For categories where we can look it up, do so. Otherwise null + absent.
  let impactAnnualUsd: number | null = insight.impactAnnualUsd;
  let provenance: Insight['provenance'] = insight.provenance;

  if (impactAnnualUsd === null && insight.entityId) {
    if (insight.category === 'collections') {
      const ar = snapshot.tenantArrears?.[insight.entityId];
      if (ar) {
        const total =
          coerceNonNegMoney(ar.d30) +
          coerceNonNegMoney(ar.d60) +
          coerceNonNegMoney(ar.d90) +
          coerceNonNegMoney(ar.d90plus);
        if (total > 0) {
          impactAnnualUsd = total;
          provenance = 'real';
        }
      }
    } else if (insight.category === 'lease') {
      const lease = snapshot.leases.find((l) => l.id === insight.entityId);
      if (lease && lease.annualRent > 0) {
        impactAnnualUsd = lease.annualRent;
        provenance = 'real';
      }
    }
  }

  return { ...insight, spine, impactAnnualUsd, provenance };
}
