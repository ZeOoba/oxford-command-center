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
import { fmtUsdCompact, fmtPct, fmtMonths, fmtDate } from './format';
import type {
  AnalyticsBundle,
  DebtSummary,
  Insight,
  MarketSlice,
  MaturityBucket,
  PortfolioKpis,
  RolloverBucket,
  TenantShare,
} from './types';

const DERIVED = 'Analytics engine (derived from Master Workbook)';
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const yearsBetween = (isoEnd: string, isoFrom: string): number =>
  (new Date(isoEnd).getTime() - new Date(isoFrom).getTime()) / (365.25 * 86_400_000);

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
    const oxfordValue = capRate && capRate > 0 ? noi / capRate : p.oxfordValue * (f.revenueFactor / f.exitCapFactor);
    return { ...p, noi, noiScenarioAdj: noi, occPct, capRate, oxfordValue };
  });
  return { ...s, properties, meta: { ...s.meta, scenario } };
}

// ── Portfolio KPIs ────────────────────────────────────────────────────────────
export function portfolioKpis(s: PortfolioSnapshot, scenario: ScenarioName = 'Base'): PortfolioKpis {
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
    walt: cell(walt(s.leases, s.meta.asOf), DERIVED, 'derived', {
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
    if (y < baseYear || y > baseYear + horizonYears) return null;
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

// ── Insights / alerts ─────────────────────────────────────────────────────────
export function generateInsights(s: PortfolioSnapshot): Insight[] {
  const out: Insight[] = [];
  const { balloonAlertMonths, concentrationRed, concentrationYellow } = s.assumptions.thresholds;

  // Balloons due within alert window
  for (const l of s.loans) {
    if (l.balloon && l.monthsToMaturity !== null && l.monthsToMaturity <= balloonAlertMonths) {
      out.push({
        id: `balloon-${l.id}`,
        severity: l.monthsToMaturity <= 9 ? 'critical' : 'warning',
        category: 'debt',
        title: `Balloon due — ${l.name}`,
        detail: `${fmtUsdCompact(l.absBalance)} balloon in ${fmtMonths(l.monthsToMaturity)} (${fmtDate(l.maturity)}). Prepare refinance or payoff.`,
        metric: fmtUsdCompact(l.absBalance),
        entityType: 'loan',
        entityId: l.id,
        action: { label: 'Open refi workspace', kind: 'open-refi' },
      });
    }
  }

  // Leases expiring within 90 days / expired
  for (const l of s.leases) {
    if (l.status === 'Expired') {
      out.push({
        id: `expired-${l.id}`,
        severity: 'warning',
        category: 'lease',
        title: `Lease expired — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} · ${fmtUsdCompact(l.annualRent)}/yr holding over. Resolve renewal or vacate.`,
        metric: fmtUsdCompact(l.annualRent),
        entityType: 'lease',
        entityId: l.id,
        action: { label: 'Draft renewal', kind: 'draft-renewal' },
      });
    } else if (l.monthsToExpiry !== null && l.monthsToExpiry >= 0 && l.monthsToExpiry <= 3) {
      out.push({
        id: `expiring-${l.id}`,
        severity: 'warning',
        category: 'lease',
        title: `Lease expiring — ${l.company ?? l.tenantName}`,
        detail: `${l.propertyKey} ${l.unit ?? ''} expires ${fmtDate(l.leaseEnd)} (${fmtMonths(l.monthsToExpiry)}). ${fmtUsdCompact(l.annualRent)}/yr at risk.`,
        metric: fmtMonths(l.monthsToExpiry),
        entityType: 'lease',
        entityId: l.id,
        action: { label: 'Draft renewal', kind: 'draft-renewal' },
      });
    }
  }

  // Insurance lapses / imminent renewals
  for (const p of s.insurance) {
    if (p.status === 'Expired' || p.status === 'Cancelled') {
      out.push({
        id: `ins-${p.id}`,
        severity: p.status === 'Cancelled' ? 'critical' : 'warning',
        category: 'insurance',
        title: `Policy ${p.status.toLowerCase()} — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} · ${p.carrier ?? ''}. Confirm replacement coverage is bound.`,
        metric: fmtUsdCompact(p.premium),
        entityType: 'insurance',
        entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
      });
    } else if (p.status === 'Renew Now') {
      out.push({
        id: `ins-${p.id}`,
        severity: 'warning',
        category: 'insurance',
        title: `Renew now — ${p.property}`,
        detail: `${p.coverage ?? 'Coverage'} renews ${fmtDate(p.expires)} (${fmtMonths((p.daysToExpiry ?? 0) / 30)}).`,
        entityType: 'insurance',
        entityId: p.id,
        action: { label: 'Review policy', kind: 'review' },
      });
    }
  }

  // Cash concentration
  if (s.cash.concentrationTopPct !== null && s.cash.concentrationTopPct >= concentrationYellow) {
    out.push({
      id: 'cash-concentration',
      severity: s.cash.concentrationTopPct >= concentrationRed ? 'critical' : 'info',
      category: 'concentration',
      title: `Cash concentration — ${s.cash.largestEntity}`,
      detail: `${fmtPct(s.cash.concentrationTopPct)} of total cash sits in one entity.`,
      metric: fmtPct(s.cash.concentrationTopPct),
      entityType: 'cashEntity',
    });
  }

  // Low occupancy
  for (const p of s.properties) {
    if (p.occPct < 0.85 && p.sf > 0) {
      out.push({
        id: `occ-${p.id}`,
        severity: 'info',
        category: 'occupancy',
        title: `Occupancy below 85% — ${p.name}`,
        detail: `${fmtPct(p.occPct)} occupied. Review vacancy and leasing.`,
        metric: fmtPct(p.occPct),
        entityType: 'property',
        entityId: p.id,
      });
    }
  }

  const rank: Record<Insight['severity'], number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── Compose the full bundle ─────────────────────────────────────────────────────
export function buildAnalytics(snapshot: PortfolioSnapshot, scenario: ScenarioName = 'Base'): AnalyticsBundle {
  const s = applyScenario(snapshot, scenario);
  return {
    kpis: portfolioKpis(s, scenario),
    leaseStatus: leaseStatusBreakdown(s.leases),
    rollover: rolloverSchedule(s.leases, s.meta.asOf),
    revenueAtRisk: revenueAtRisk(s.leases),
    topTenants: topTenants(s.leases),
    tenantHHI: tenantHHI(s.leases),
    marketByNoi: marketAllocation(s.properties, 'noi'),
    marketBySf: marketAllocation(s.properties, 'sf'),
    marketByValue: marketAllocation(s.properties, 'value'),
    debt: debtSummary(s.loans),
    insights: generateInsights(s),
  };
}
