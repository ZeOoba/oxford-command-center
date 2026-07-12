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
import { todayEastern } from '../../server/warehouse/time-constants';
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
import { DAY_MS } from '../../server/warehouse/time-constants';

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
    const dscr = p.debtService > 0 ? noi / p.debtService : p.dscr;
    const ltv = (p.loanBalance > 0 && oxfordValue > 0) ? p.loanBalance / oxfordValue : p.ltv;
    return { ...p, noi, noiScenarioAdj: noi, occPct, capRate, oxfordValue, dscr, ltv };
  });
  return { ...s, properties, meta: { ...s.meta, scenario } };
}

// ── Portfolio KPIs ────────────────────────────────────────────────────────────
/** `asOf` (defaults to real today, injectable in tests) anchors WALT's remaining-term math —
 * NEVER s.meta.asOf, a frozen workbook-label constant that does not track the calendar. */
export function portfolioKpis(
  s: PortfolioSnapshot,
  scenario: ScenarioName = 'Base',
  asOf: string = todayEastern(),
): PortfolioKpis {
  const p = s.properties;
  // Under a non-Base scenario, workbook figures are modeled — mark them derived.
  const sourced: Confidence = scenario === 'Base' ? 'confirmed' : 'derived';
  const tag = (src: string) => (scenario === 'Base' ? src : `${src} · Scenario: ${scenario}`);
  const totalSf = sum(p.map((x) => x.sf));
  const occSf = sum(p.map((x) => x.sf * x.occPct));
  const noi = sum(p.map((x) => x.noi));
  const value = sum(p.map((x) => x.oxfordValue));
  const debt = sum(p.map((x) => x.loanBalance));
  const equity = sum(p.map((x) => x.equityInvested));
  const tenants = sum(p.map((x) => x.tenantCount));

  return {
    totalSf: cell(totalSf, 'Property NOI · Σ SF', 'confirmed'),
    occupancy: cell(totalSf ? occSf / totalSf : null, DERIVED, 'derived', { formula: 'Σ(sf·occ)/Σsf' }),
    noi: cell(noi, tag('Property NOI · Σ NOI (Oxford)'), sourced),
    value: cell(value, tag('Property NOI · Σ Oxford value'), sourced),
    ltv: cell(value ? debt / value : null, DERIVED, 'derived', { formula: 'Σ loan balance / Σ value' }),
    weightedCapRate: cell(value ? noi / value : null, DERIVED, 'derived', { formula: 'Σ NOI / Σ value' }),
    equityInvested: cell(equity, 'Property NOI · Σ equity invested', 'confirmed'),
    propertyCount: cell(p.length, 'Property NOI · row count', 'confirmed'),
    tenantCount: cell(tenants, 'Property NOI · Σ tenants', 'confirmed'),
    totalDebt: cell(debt, 'Property NOI · Σ loan balance', 'confirmed'),
    totalCash: cell(s.cash.totalCash, 'Cash Balances · total', 'confirmed'),
    walt: cell(walt(s.leases, asOf), DERIVED, 'derived', {
      formula: 'rent-weighted remaining term, active leases',
    }),
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
    b.expiringRent += l.annualRent;
    buckets.set(k, b);
  }
  return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export function revenueAtRisk(leases: Lease[]) {
  const totalRent = sum(leases.map((l) => l.annualRent));
  const within90dRent = sum(
    leases.filter((l) => l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= 3).map((l) => l.annualRent),
  );
  const expiredRent = sum(leases.filter((l) => l.status === 'Expired').map((l) => l.annualRent));
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
    const base = { leaseId: l.id, tenant, propertyKey: l.propertyKey, unit: l.unit, annualRent: l.annualRent };

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
  const borrowers = loans.filter((l) => l.direction === 'borrower');
  const lenders = loans.filter((l) => l.direction === 'lender');
  const internal = loans.filter((l) => l.direction === 'internal');

  const externalDebt = sum(borrowers.map((l) => l.absBalance));
  const lenderDeployed = sum(lenders.map((l) => l.absBalance));
  const internalOutstanding = sum(internal.map((l) => l.absBalance));
  const annualDebtService = sum(borrowers.map((l) => (l.monthlyPmt ?? 0) * 12));

  const rated = borrowers.filter((l) => l.rate !== null && l.absBalance > 0);
  const wb = sum(rated.map((l) => l.absBalance));
  const weightedAvgRate = wb ? sum(rated.map((l) => (l.rate as number) * l.absBalance)) / wb : null;

  // Maturity ladder (borrowers + lenders with a real maturity; demand bucketed separately)
  const ladder = new Map<string, MaturityBucket>();
  for (const l of [...borrowers, ...lenders]) {
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
    internalOutstanding,
    lenderDeployed,
    annualDebtService,
    weightedAvgRate,
    ladder: sortedLadder,
  };
}

// ── Compose the full bundle ─────────────────────────────────────────────────────
/** `now` (ms epoch, defaults to Date.now(), injectable in tests) anchors every day-count below —
 * NEVER snapshot.meta.asOf, a frozen workbook-label constant that does not track the calendar. */
export function buildAnalytics(
  snapshot: PortfolioSnapshot,
  scenario: ScenarioName = 'Base',
  now: number = Date.now(),
): AnalyticsBundle {
  const s = applyScenario(snapshot, scenario);
  const asOf = todayEastern(now);
  return {
    kpis: portfolioKpis(s, scenario, asOf),
    leaseStatus: leaseStatusBreakdown(s.leases),
    rollover: rolloverSchedule(s.leases, asOf),
    criticalDates: criticalDates(s.leases, asOf),
    revenueAtRisk: revenueAtRisk(s.leases),
    topTenants: topTenants(s.leases),
    tenantHHI: tenantHHI(s.leases),
    marketByNoi: marketAllocation(s.properties, 'noi'),
    marketBySf: marketAllocation(s.properties, 'sf'),
    marketByValue: marketAllocation(s.properties, 'value'),
    debt: debtSummary(s.loans),
    insights: evaluateConditions(s, { now }),
  };
}
