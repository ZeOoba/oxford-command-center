import type { Cell } from '@contracts/index';

export type InsightSeverity = 'critical' | 'warning' | 'info';
export type InsightCategory =
  | 'debt'
  | 'lease'
  | 'insurance'
  | 'concentration'
  | 'occupancy'
  | 'cash'
  | 'deal'
  | 'data'
  | 'anomaly'
  | 'collections'
  | 'capex';

export interface InsightAction {
  label: string;
  kind: 'draft-renewal' | 'open-refi' | 'review' | 'open-record';
}

export interface Insight {
  id: string;
  severity: InsightSeverity;
  category: InsightCategory;
  title: string;
  detail: string;
  metric?: string;
  entityType?: 'property' | 'lease' | 'loan' | 'insurance' | 'deal' | 'cashEntity';
  entityId?: string;
  action?: InsightAction;
  impactAnnualUsd: number | null;
  spine: 'A' | 'B';
  provenance: 'real' | 'derived' | 'absent';
}

export interface PortfolioKpis {
  totalSf: Cell;
  occupancy: Cell;
  noi: Cell;
  value: Cell;
  ltv: Cell;
  weightedCapRate: Cell;
  equityInvested: Cell;
  propertyCount: Cell;
  tenantCount: Cell;
  totalDebt: Cell;
  /** Σ property-row loan balances owed to an Oxford affiliate lender (src/analytics/debt-basis.ts) —
   *  excluded from totalDebt / ltv and disclosed beside them (ratified 2026-09-24). */
  affiliateDebt: Cell;
  totalCash: Cell;
  walt: Cell;
  /** Non-investment holdings (the residence) — shown alongside, never inside, investment metrics. */
  otherHoldingsValue: Cell;
  otherHoldingsCount: Cell;
}

export interface RolloverBucket {
  period: string; // e.g. "2026 H2", "2027", "2030+" (beyond-horizon catch-all)
  count: number;
  expiringSf: number;
  expiringRent: number;
}

export type CriticalDateKind = 'Notice Deadline' | 'Expiration' | 'Escalation';

export interface CriticalDate {
  id: string;
  leaseId: string;
  tenant: string;
  propertyKey: string;
  unit: string | null;
  kind: CriticalDateKind;
  date: string; // ISO (YYYY-MM-DD)
  daysToDate: number; // signed — negative is overdue (e.g. a holdover lease)
  annualRent: number;
  /** Present on Notice Deadline rows — the assumed window. Derived/estimated, not from source. */
  noticeWindowDays?: number;
}

export interface TenantShare {
  company: string;
  annualRent: number;
  share: number; // 0..1
  leases: number;
  sf: number;
}

export interface MarketSlice {
  market: string;
  value: number;
  pct: number;
}

export interface MaturityBucket {
  period: string; // year or "Demand"
  balance: number;
  count: number;
  hasBalloon: boolean;
}

export interface DebtSummary {
  /** Σ THIRD-PARTY borrower loans (affiliate notes excluded — ratified 2026-09-24). */
  externalDebt: number;
  /** Σ borrower loans owed to an Oxford affiliate lender — disclosed beside externalDebt. */
  affiliateDebt: number;
  affiliateCount: number;
  internalOutstanding: number;
  lenderDeployed: number;
  /** Third-party borrower loans only (same basis as externalDebt). */
  annualDebtService: number;
  /** Balance-weighted over third-party borrower loans only (same basis as externalDebt). */
  weightedAvgRate: number | null;
  /** Position view: every borrower (incl. affiliate) + lender loan with its maturity bucket. */
  ladder: MaturityBucket[];
}

export interface AnalyticsBundle {
  kpis: PortfolioKpis;
  leaseStatus: Record<string, number>;
  rollover: RolloverBucket[];
  criticalDates: CriticalDate[];
  revenueAtRisk: { within90dRent: number; expiredRent: number; pctOfRent: number };
  topTenants: TenantShare[];
  tenantHHI: number;
  marketByNoi: MarketSlice[];
  marketBySf: MarketSlice[];
  marketByValue: MarketSlice[];
  debt: DebtSummary;
  insights: Insight[];
}
