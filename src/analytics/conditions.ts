import type { PortfolioSnapshot } from '@contracts/index';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtMonths, fmtDate } from './format';
import type { Insight, InsightSeverity } from './types';
import { tenantScorecards } from '@/brain/tenants';
import { coerceNonNegMoney } from '@/lib/money';

const DAY_MS = 86_400_000;
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
} as const;

export interface EvaluateOpts {
  /** Wall-clock now (ms) for the workbook-stale check. Defaults to Date.now(); injected in tests. */
  now?: number;
  /** dealId → stage at last brief. Supplied only by the email brief to emit stage-move alerts. */
  priorStages?: Record<string, string>;
}

/**
 * The single canonical alert engine. Pure. Replaces generateInsights + extendedInsights.
 * Date math uses the snapshot's asOf (stable across a refresh); only the workbook-stale check
 * uses wall-clock now.
 */
export function evaluateConditions(s: PortfolioSnapshot, opts: EvaluateOpts = {}): Insight[] {
  const T = ALERT_THRESHOLDS;
  const asOf = s.meta.asOf;
  const now = opts.now ?? Date.now();
  const out: Insight[] = [];

  // ── Debt ──────────────────────────────────────────────────────────────────
  for (const l of s.loans) {
    if (l.balloon && l.maturity) {
      const days = daysBetween(l.maturity, asOf);
      if (days <= T.balloonWarningDays) {
        out.push({
          id: `balloon-${l.id}`,
          severity: days < T.balloonCriticalDays ? 'critical' : 'warning',
          category: 'debt',
          title: `Balloon due — ${l.name}`,
          detail: `${fmtUsd(l.absBalance)} balance, balloon ${fmtDate(l.maturity)} (${fmtMonths(l.monthsToMaturity ?? days / 30)}). Prepare refinance or payoff.`,
          metric: fmtUsd(l.absBalance),
          entityType: 'loan',
          entityId: l.id,
          action: { label: 'Open refi workspace', kind: 'open-refi' },
        });
      }
    }
  }

  for (const p of s.properties) {
    if (p.dscr !== null && p.dscr < T.dscrFloor) {
      out.push({
        id: `dscr-floor-${p.id}`, severity: 'critical', category: 'debt',
        title: `DSCR below floor — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (below ${T.dscrFloor.toFixed(2)}x floor). Lender-remedy risk — act now.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    } else if (p.dscr !== null && p.dscr < T.dscrWatch) {
      out.push({
        id: `dscr-${p.id}`, severity: 'warning', category: 'debt',
        title: `DSCR below 1.25 — ${p.name}`,
        detail: `Debt-service coverage is ${p.dscr.toFixed(2)}x (covenant watch). Review the loan.`,
        metric: `${p.dscr.toFixed(2)}x`, entityType: 'property', entityId: p.id,
      });
    }
    if (p.ltv !== null && p.ltv > T.ltvCeiling) {
      out.push({
        id: `ltv-${p.id}`, severity: 'warning', category: 'debt',
        title: `LTV above 65% — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)} (above the ${fmtPct(T.ltvCeiling)} ceiling).`,
        metric: fmtPct(p.ltv), entityType: 'property', entityId: p.id,
      });
    } else if (p.ltv !== null && p.ltv > T.ltvGovernor) {
      // B3 Option B: above the ratified LTV governor (≤40%) but within the operational ceiling —
      // an info-level signal so a governor deviation is visible without warning-noise on every levered property.
      out.push({
        id: `ltv-governor-${p.id}`, severity: 'info', category: 'debt',
        title: `LTV above governor — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(p.ltv)} — above the ${fmtPct(T.ltvGovernor)} portfolio governor (LTV ≤ 40%).`,
        metric: fmtPct(p.ltv), entityType: 'property', entityId: p.id,
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
        });
      }
    }
    if (l.escalationDate && daysBetween(l.escalationDate, asOf) < 0) {
      out.push({
        id: `escalation-${l.id}`, severity: 'warning', category: 'lease',
        title: `Escalation date passed — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} escalation was due ${fmtDate(l.escalationDate)}. Confirm the bump was applied.`,
        entityType: 'lease', entityId: l.id,
      });
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
    const DAY_MS_AR = 86_400_000;
    const staleAges = stampedEntries.map((r) => {
      const asOfMs = r.asOfDate ? new Date(r.asOfDate).getTime() : null;
      if (asOfMs === null || !Number.isFinite(asOfMs)) return null;
      return Math.floor((now - asOfMs) / DAY_MS_AR);
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
        });
      } else if (total >= T.arrearsMaterialUsd) {
        out.push({
          id: `arrears-${l.id}`, severity: 'warning', category: 'collections',
          title: `Receivable outstanding — ${who}`,
          detail: `${where} · ${fmtUsd(total)} past due (under 60 days). Monitor for payment.`,
          metric: fmtUsd(total), entityType: 'lease', entityId: l.id,
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
      });
    } else if (p.daysToExpiry !== null && p.daysToExpiry >= 0 && p.daysToExpiry < T.insuranceRenewWarnDays) {
      out.push({
        id: `ins-${p.id}`, severity: 'warning', category: 'insurance',
        title: `Insurance renewing soon — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} renews ${fmtDate(p.expires)} (${p.daysToExpiry}d).`,
        entityType: 'insurance', entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
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
    });
  }
  const ageHrs = (now - new Date(s.meta.generatedAt).getTime()) / HOUR_MS;
  if (ageHrs > T.workbookStaleHours) {
    out.push({
      id: 'workbook-stale', severity: 'info', category: 'data',
      title: 'Workbook data is stale',
      detail: `Last parsed ${fmtDate(s.meta.generatedAt)} — ${Math.round(ageHrs)}h ago (over the ${T.workbookStaleHours}h limit). Refresh the source.`,
      metric: `${Math.round(ageHrs)}h`,
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
        });
      }
    }
  }

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
