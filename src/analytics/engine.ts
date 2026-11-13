import {
  cell,
  SCENARIO_PRESETS,
  type PortfolioSnapshot,
  type Lease,
  type Loan,
  type Property,
  type ScenarioName,
  type Confidence,
} from '@contracts/index';
import { evaluateConditions } from './conditions';
import { isInvestmentProperty } from './property-basis';
import { contractAnnualRent } from './lease-rent';
import { investmentLoanBalance, isAffiliateNoteProperty, isAffiliateBorrowerLoan, namesAffiliateLender } from './debt-basis';
import { hasBlankGovernorInput, incompleteGovernorRows, ltvIncompleteRows } from './governor-inputs';
import type {
  AnalyticsBundle,
  CriticalDate,
  DebtSummary,
  MarketSlice,
  MaturityBucket,
  PortfolioKpis,
  RolloverBucket,
  TenantShare,
} from './types';
import { DAY_MS } from '@/lib/time-constants';

const DERIVED = 'Analytics engine (derived from Master Workbook)';
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const yearsBetween = (isoEnd: string, isoFrom: string): number =>
  (new Date(isoEnd).getTime() - new Date(isoFrom).getTime()) / (365.25 * DAY_MS);
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

/**
 * Default renewal/termination notice window assumed when a lease has no explicit notice
 * provision in the source. Critical-date rows derived from it are estimates, not confirmed.
 */
export const DEFAULT_NOTICE_WINDOW_DAYS = 90;

/**
 * Apply a scenario's revenue / vacancy / exit-cap factors to the portfolio.
 * Returns a transformed snapshot so every downstream metric moves coherently.
 */
export function applyScenario(s: PortfolioSnapshot, scenario: ScenarioName): PortfolioSnapshot {
  if (scenario === 'Base') return s;
  const f = SCENARIO_PRESETS[scenario];
  const properties: Property[] = s.properties.map((p) => {
    // Non-investment rows (the residence; ratified 2026-09-23) have no revenue and no cap-rate exposure,
    // so a revenue / exit-cap shock cannot move them. Pass the row through untouched — otherwise the
    // other-holdings figure would be scaled by revenueFactor/exitCapFactor with no economic basis and
    // the residence would get a phantom scenario dscr/ltv recomputation (refute finding, 2026-09-23).
    if (!isInvestmentProperty(p)) return p;
    const noi = p.noi * f.revenueFactor;
    const occPct = Math.max(0, Math.min(1, 1 - (1 - p.occPct) * f.vacancyFactor));
    const capRate = p.capRate !== null ? p.capRate * f.exitCapFactor : null;
    // Scale the source-of-record workbook value by the scenario's revenue/exit-cap shock in BOTH
    // the capped and uncapped branches. The prior capped-property re-derivation (noi/capRate)
    // treated the going-in cap as the exit cap, producing a Base-boundary discontinuity and a
    // Downside that could RAISE value / LOWER LTV (audit H4 `scenario-value-basis-mix`).
    const oxfordValue = p.oxfordValue * (f.revenueFactor / f.exitCapFactor);
    // Recompute DSCR and LTV from the shocked noi/oxfordValue so governor alerts reflect
    // the scenario, not the stale Base-case values (audit: applyScenario stale governors).
    // A blank workbook input (parse flag, ./governor-inputs) is unknown, not $0: recomputing from it
    // would fabricate a DSCR of 0x (blank NOI) or drop a real loan (blank balance). Keep the workbook
    // DSCR / LTV cell instead, unshocked: the same figure Base shows, so a stressed scenario can never
    // drop a per-property alert that Base fires (refute wf_fe0c7b48-326). parse.ts already nulls a 0
    // ratio cell derived from a blank, so a fabricated 0x never reaches here (audit 2026-11-12 HIGH #2).
    const dscr = hasBlankGovernorInput(p, 'noi') || hasBlankGovernorInput(p, 'debtService')
      ? p.dscr
      : p.debtService > 0 ? noi / p.debtService : p.dscr;
    const ltv = hasBlankGovernorInput(p, 'loanBalance')
      ? p.ltv
      : (p.loanBalance > 0 && oxfordValue > 0) ? p.loanBalance / oxfordValue : p.ltv;
    return { ...p, noi, noiScenarioAdj: noi, occPct, capRate, oxfordValue, dscr, ltv };
  });
  return { ...s, properties, meta: { ...s.meta, scenario } };
}

// ── Portfolio KPIs ────────────────────────────────────────────────────────────
/**
 * @param referenceDate Optional day-count reference (YYYY-MM-DD) for WALT (rent-weighted
 *   remaining term — a "years from now" figure). Defaults to `s.meta.asOf` for backward
 *   compatibility; callers with a run date (UI/AI/brief) pass it so WALT tracks today.
 */
export function portfolioKpis(
  s: PortfolioSnapshot,
  scenario: ScenarioName = 'Base',
  referenceDate?: string,
): PortfolioKpis {
  // Ratified 2026-09-23 (Gabriel): the residence is not an investment asset — it diluted weighted cap
  // (~24 bps) and occupancy. Solar stays in (income-producing). Residence is reported as "other holdings".
  // The predicate lives in ./property-basis so every investment surface shares one basis.
  const p = s.properties.filter(isInvestmentProperty);
  const other = s.properties.filter((x) => !isInvestmentProperty(x));
  // Under a non-Base scenario, workbook figures are modeled — mark them derived.
  const sourced: Confidence = scenario === 'Base' ? 'confirmed' : 'derived';
  const tag = (src: string) => (scenario === 'Base' ? src : `${src} · Scenario: ${scenario}`);
  const totalSf = sum(p.map((x) => x.sf));
  const occSf = sum(p.map((x) => x.sf * x.occPct));
  const noi = sum(p.map((x) => x.noi));
  const value = sum(p.map((x) => x.oxfordValue));
  // Ratified 2026-09-24 (Gabriel): Oxford-to-Oxford (affiliate) notes are excluded from Total Debt and
  // the aggregate LTV and disclosed separately — the single rule lives in ./debt-basis.
  const debt = sum(p.map(investmentLoanBalance));
  const affiliateDebt = sum(p.filter(isAffiliateNoteProperty).map((x) => x.loanBalance));
  const ltvIncomplete = ltvIncompleteRows(p);
  // A blank NOI (parse flag) is summed as $0: Σ NOI and the weighted cap rate are then incomplete,
  // with no bound direction since the true NOI may be negative (refute wf_406ad3ef-7de,
  // wf_c93c6154-6b8). Disclose it on both cells.
  const noiIncomplete = incompleteGovernorRows(p, ['noi']);
  const affiliateBlank = incompleteGovernorRows(p.filter((x) => namesAffiliateLender(x.lender)), ['loanBalance']);
  const noiGap = noiIncomplete.length > 0 ? `blank NOI on ${noiIncomplete.map((r) => r.name).join(', ')}` : null;
  const equity = sum(p.map((x) => x.equityInvested));
  const tenants = sum(p.map((x) => x.tenantCount));

  return {
    totalSf: cell(totalSf, 'Property NOI · Σ SF', 'confirmed'),
    occupancy: cell(totalSf ? occSf / totalSf : null, DERIVED, 'derived', { formula: 'Σ(sf·occ)/Σsf' }),
    noi: noiGap
      // No direction claim: a blank NOI may be negative, so Σ NOI is neither a lower nor an upper bound.
      ? cell(noi, tag('Property NOI · Σ NOI (Oxford)'), 'derived', { formula: `incomplete: excludes ${noiGap}` })
      : cell(noi, tag('Property NOI · Σ NOI (Oxford)'), sourced),
    value: cell(value, tag('Property NOI · Σ Oxford value'), sourced),
    // Fails closed (audit 2026-11-12 HIGH #2): a levered investment row whose Loan Balance cell is
    // blank would otherwise contribute $0 debt and falsely clear the aggregate LTV governor.
    ltv: ltvIncomplete.length > 0
      ? cell(null, DERIVED, 'derived', {
          formula: `incomplete: blank Loan Balance on ${ltvIncomplete.map((r) => r.name).join(', ')} — Σ third-party loan balance / Σ value (affiliate notes excluded)`,
        })
      : cell(value ? debt / value : null, DERIVED, 'derived', { formula: 'Σ third-party loan balance / Σ value (affiliate notes excluded)' }),
    weightedCapRate: cell(value ? noi / value : null, DERIVED, 'derived', {
      formula: noiGap ? `incomplete: ${noiGap} — Σ NOI / Σ value` : 'Σ NOI / Σ value',
    }),
    equityInvested: cell(equity, 'Property NOI · Σ equity invested', 'confirmed'),
    propertyCount: cell(p.length, 'Property NOI · row count', 'confirmed'),
    tenantCount: cell(tenants, 'Property NOI · Σ tenants', 'confirmed'),
    ltvIncomplete: ltvIncomplete,
    noiIncomplete,
    affiliateIncomplete: affiliateBlank,
    // With a blank third-party Loan Balance the sum is a LOWER BOUND, not a confirmed total.
    totalDebt: ltvIncomplete.length > 0
      ? cell(debt, 'Property NOI · Σ loan balance (affiliate notes excluded)', 'derived', {
          formula: `incomplete (lower bound): blank Loan Balance on ${ltvIncomplete.map((r) => r.name).join(', ')}`,
        })
      : cell(debt, 'Property NOI · Σ loan balance (affiliate notes excluded)', 'confirmed'),
    // An affiliate-lender row with a blank balance makes this incomplete (refute wf_2f05948b-aae). No
    // bound direction: affiliate balances are sign-agnostic, so a blank may hide a negative (refute wf_d7665e23-135).
    affiliateDebt: affiliateBlank.length > 0
      ? cell(affiliateDebt, 'Property NOI · Σ loan balance owed to an Oxford affiliate', 'derived', {
          formula: `incomplete: blank Loan Balance on ${affiliateBlank.map((r) => r.name).join(', ')}`,
        })
      : cell(affiliateDebt, 'Property NOI · Σ loan balance owed to an Oxford affiliate', 'confirmed'),
    totalCash: cell(s.cash.totalCash, 'Cash Balances · total', 'confirmed'),
    walt: cell(walt(s.leases, referenceDate ?? s.meta.asOf), DERIVED, 'derived', {
      formula: 'rent-weighted remaining term, active leases',
    }),
    // applyScenario passes non-investment rows through untouched, so this is a workbook figure in
    // EVERY scenario — never tagged/derived (refute fix, 2026-09-23).
    otherHoldingsValue: cell(sum(other.map((x) => x.oxfordValue)), 'Property NOI · Σ Oxford value (Residence)', 'confirmed'),
    otherHoldingsCount: cell(other.length, 'Property NOI · Residence row count', 'confirmed'),
  };
}

/** Rent-weighted remaining lease term in years, over non-expired leases. */
export function walt(leases: Lease[], asOf: string): number | null {
  const active = leases.filter((l) => l.leaseEnd && l.status !== 'Expired');
  const wRent = sum(active.map((l) => l.annualRent));
  if (!wRent) return null;
  return sum(active.map((l) => l.annualRent * Math.max(0, yearsBetween(l.leaseEnd!, asOf)))) / wRent;
}

export function leaseStatusBreakdown(leases: Lease[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of leases) out[l.status] = (out[l.status] ?? 0) + 1;
  return out;
}

/** Lease rollover by half-year then year buckets, forward from asOf. */
export function rolloverSchedule(leases: Lease[], asOf: string, horizonYears = 4): RolloverBucket[] {
  const from = new Date(asOf);
  const baseYear = from.getUTCFullYear();
  const buckets = new Map<string, RolloverBucket>();
  const keyFor = (d: Date): string | null => {
    const y = d.getUTCFullYear();
    if (y < baseYear) return null;
    // Beyond the horizon: bucket into a catch-all instead of silently dropping the rent.
    if (y > baseYear + horizonYears) return `${baseYear + horizonYears}+`;
    if (y === baseYear) return `${y} ${d.getUTCMonth() < 6 ? 'H1' : 'H2'}`;
    return `${y}`;
  };
  for (const l of leases) {
    if (!l.leaseEnd) continue;
    const d = new Date(l.leaseEnd);
    const k = keyFor(d);
    if (!k) continue;
    const b = buckets.get(k) ?? { period: k, count: 0, expiringSf: 0, expiringRent: 0 };
    b.count++;
    b.expiringSf += l.sf;
    b.expiringRent += contractAnnualRent(l);
    buckets.set(k, b);
  }
  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * @param asOf Optional run-date reference (YYYY-MM-DD). When supplied, the "within 90 days"
 *   test is computed day-accurately from `leaseEnd` against it (falling back to the baked
 *   `monthsToExpiry` only when `leaseEnd` is null) — this keeps the exposure on the same
 *   run-date basis as every other surface and is drift-free vs the parse-time column. When
 *   omitted, the original baked-`monthsToExpiry` behavior is preserved for backward compatibility.
 */
export function revenueAtRisk(leases: Lease[], asOf?: string) {
  const totalRent = sum(leases.map((l) => contractAnnualRent(l)));
  const within90d = (l: Lease): boolean => {
    if (asOf && l.leaseEnd) {
      const days = daysBetween(l.leaseEnd, asOf);
      return days >= 0 && days <= 90;
    }
    return l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= 3;
  };
  const within90dRent = sum(leases.filter(within90d).map((l) => contractAnnualRent(l)));
  const expiredRent = sum(leases.filter((l) => l.status === 'Expired').map((l) => contractAnnualRent(l)));
  return { within90dRent, expiredRent, pctOfRent: totalRent ? within90dRent / totalRent : 0 };
}

/**
 * The actionable date calendar for the lease book: renewal/termination notice deadlines,
 * expirations (including overdue holdovers), and escalation effective dates — each as a row
 * sorted by urgency (soonest/overdue first). Notice deadlines are derived from a default
 * window when the source carries no explicit provision; escalations and notice deadlines that
 * have already passed are omitted (no longer actionable), but overdue expirations are kept
 * because a holdover tenancy is still an open item.
 */
export function criticalDates(
  leases: Lease[],
  asOf: string,
  opts: { horizonDays?: number; noticeWindowDays?: number } = {},
): CriticalDate[] {
  const horizonDays = opts.horizonDays ?? 365;
  const noticeWindowDays = opts.noticeWindowDays ?? DEFAULT_NOTICE_WINDOW_DAYS;
  const within = (days: number) => days <= horizonDays;
  const out: CriticalDate[] = [];

  for (const l of leases) {
    const tenant = l.company ?? l.tenantName;
    const base = { leaseId: l.id, tenant, propertyKey: l.propertyKey, unit: l.unit, annualRent: contractAnnualRent(l) };

    if (l.leaseEnd) {
      const expDays = daysBetween(l.leaseEnd, asOf);
      // Expiration: upcoming within horizon, or overdue (holdover).
      if (within(expDays)) {
        out.push({ id: `exp-${l.id}`, kind: 'Expiration', date: l.leaseEnd, daysToDate: expDays, ...base });
      }
      // Notice deadline = expiration − notice window; only while still ahead of us.
      const noticeDate = new Date(new Date(l.leaseEnd).getTime() - noticeWindowDays * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const noticeDays = daysBetween(noticeDate, asOf);
      if (noticeDays >= 0 && within(noticeDays)) {
        out.push({ id: `notice-${l.id}`, kind: 'Notice Deadline', date: noticeDate, daysToDate: noticeDays, noticeWindowDays, ...base });
      }
    }

    // Escalation effective date — future only (a past escalation has already applied).
    if (l.escalationDate) {
      const escDays = daysBetween(l.escalationDate, asOf);
      if (escDays >= 0 && within(escDays)) {
        out.push({ id: `esc-${l.id}`, kind: 'Escalation', date: l.escalationDate, daysToDate: escDays, ...base });
      }
    }
  }

  return out.sort((a, b) => a.daysToDate - b.daysToDate);
}

// ── Concentration ─────────────────────────────────────────────────────────────
export function topTenants(leases: Lease[], n = 8): TenantShare[] {
  const totalRent = sum(leases.map((l) => l.annualRent));
  const byCo = new Map<string, TenantShare>();
  for (const l of leases) {
    const company = l.company ?? l.tenantName;
    const t = byCo.get(company) ?? { company, annualRent: 0, share: 0, leases: 0, sf: 0 };
    t.annualRent += l.annualRent;
    t.leases++;
    t.sf += l.sf;
    byCo.set(company, t);
  }
  const all = [...byCo.values()].map((t) => ({ ...t, share: totalRent ? t.annualRent / totalRent : 0 }));
  return all.sort((a, b) => b.annualRent - a.annualRent).slice(0, n);
}

/** Herfindahl–Hirschman Index of tenant revenue concentration (0–10,000). */
export function tenantHHI(leases: Lease[]): number {
  const totalRent = sum(leases.map((l) => l.annualRent));
  if (!totalRent) return 0;
  const byCo = new Map<string, number>();
  for (const l of leases) {
    const company = l.company ?? l.tenantName;
    byCo.set(company, (byCo.get(company) ?? 0) + l.annualRent);
  }
  return sum([...byCo.values()].map((r) => (r / totalRent) ** 2)) * 10_000;
}

export function marketAllocation(properties: Property[], metric: 'noi' | 'sf' | 'value'): MarketSlice[] {
  const pick = (p: Property) => (metric === 'noi' ? p.noi : metric === 'sf' ? p.sf : p.oxfordValue);
  const total = sum(properties.map(pick));
  const byMkt = new Map<string, number>();
  for (const p of properties) byMkt.set(p.market, (byMkt.get(p.market) ?? 0) + pick(p));
  return [...byMkt.entries()]
    .map(([market, value]) => ({ market, value, pct: total ? value / total : 0 }))
    .sort((a, b) => b.value - a.value);
}

// ── Debt ──────────────────────────────────────────────────────────────────────
export function debtSummary(loans: Loan[]): DebtSummary {
  const borrowersAll = loans.filter((l) => l.direction === 'borrower');
  // Ratified 2026-09-24: External Debt and its rate/service figures are THIRD-PARTY only; affiliate
  // (Oxford-to-Oxford) borrower notes are carried separately so Overview and Capital › Debt reconcile.
  const affiliates = borrowersAll.filter(isAffiliateBorrowerLoan);
  const borrowers = borrowersAll.filter((l) => !isAffiliateBorrowerLoan(l));
  const lenders = loans.filter((l) => l.direction === 'lender');
  const internal = loans.filter((l) => l.direction === 'internal');

  const externalDebt = sum(borrowers.map((l) => l.absBalance));
  const affiliateDebt = sum(affiliates.map((l) => l.absBalance));
  const lenderDeployed = sum(lenders.map((l) => l.absBalance));
  const internalOutstanding = sum(internal.map((l) => l.absBalance));
  const annualDebtService = sum(borrowers.map((l) => (l.monthlyPmt ?? 0) * 12));

  const rated = borrowers.filter((l) => l.rate !== null && l.absBalance > 0);
  const wb = sum(rated.map((l) => l.absBalance));
  const weightedAvgRate = wb ? sum(rated.map((l) => (l.rate as number) * l.absBalance)) / wb : null;

  // Maturity ladder (borrowers + lenders with a real maturity; demand bucketed separately)
  const ladder = new Map<string, MaturityBucket>();
  for (const l of [...borrowersAll, ...lenders]) {
    const key = l.maturity ? String(new Date(l.maturity).getUTCFullYear()) : 'Demand';
    const b = ladder.get(key) ?? { period: key, balance: 0, count: 0, hasBalloon: false };
    b.balance += l.absBalance;
    b.count++;
    b.hasBalloon = b.hasBalloon || l.balloon;
    ladder.set(key, b);
  }
  const sortedLadder = [...ladder.values()].sort((a, b) => {
    if (a.period === 'Demand') return 1;
    if (b.period === 'Demand') return -1;
    return Number(a.period) - Number(b.period);
  });

  return {
    externalDebt,
    affiliateDebt,
    affiliateCount: affiliates.length,
    internalOutstanding,
    lenderDeployed,
    annualDebtService,
    weightedAvgRate,
    ladder: sortedLadder,
  };
}

// ── Compose the full bundle ─────────────────────────────────────────────────────
/**
 * @param referenceDate Optional day-count reference (YYYY-MM-DD) for the critical-dates
 *   calendar and insight day-counts — the Daily Brief passes its RUN date so "Nd" counts
 *   track today rather than the frozen workbook data date (frozen-dateline defect, 2026-07).
 *   Defaults to `s.meta.asOf` (the workbook data date) for backward compatibility with
 *   existing callers (UI, AI tools). walt/rollover intentionally remain on `meta.asOf` —
 *   they are coarse (years / half-year buckets) and no consumer renders them as day counts.
 */
export function buildAnalytics(
  snapshot: PortfolioSnapshot,
  scenario: ScenarioName = 'Base',
  referenceDate?: string,
): AnalyticsBundle {
  const s = applyScenario(snapshot, scenario);
  // ONE basis for every day-count/relative surface in the bundle. `ref` drives walt, rollover,
  // and criticalDates (all "N from now" figures); when no run date is injected it falls back to
  // the workbook data date, leaving legacy callers unchanged. revenueAtRisk gets the RAW
  // `referenceDate` (undefined-preserving) so its default path keeps the baked-monthsToExpiry
  // behavior; a provided run date switches it to day-accurate leaseEnd math.
  const ref = referenceDate ?? s.meta.asOf;
  // Market allocations sit beside the KPI headlines, so they share portfolioKpis' investment-only
  // basis (ratified 2026-09-23): each series sums to kpis.value / totalSf / noi, never past it.
  const investment = s.properties.filter(isInvestmentProperty);
  return {
    kpis: portfolioKpis(s, scenario, ref),
    leaseStatus: leaseStatusBreakdown(s.leases),
    rollover: rolloverSchedule(s.leases, ref),
    criticalDates: criticalDates(s.leases, ref),
    revenueAtRisk: revenueAtRisk(s.leases, referenceDate),
    topTenants: topTenants(s.leases),
    tenantHHI: tenantHHI(s.leases),
    marketByNoi: marketAllocation(investment, 'noi'),
    marketBySf: marketAllocation(investment, 'sf'),
    marketByValue: marketAllocation(investment, 'value'),
    debt: debtSummary(s.loans),
    // Thread the same reference date so the bundle is internally coherent: when a caller
    // (the brief) injects a run date, insight day-counts and criticalDates agree. Undefined
    // → evaluateConditions defaults to s.meta.asOf (unchanged for UI/tool callers).
    insights: evaluateConditions(s, { referenceDate }),
  };
}
