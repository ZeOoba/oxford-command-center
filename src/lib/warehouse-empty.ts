// src/lib/warehouse-empty.ts
//
// "Loaded, but the warehouse has nothing yet" predicates + copy (item 12, 2026-09-24). Distinct from the
// offline (static mirror → WarehouseUnavailableError) and error states, which each module already
// renders; these fire only on a SUCCESSFUL, EMPTY report, where the modules used to render a blank body.
import type { InsuranceAnalysisReport } from '@contracts/insurance-analysis';
import type { TaxAnalysisReport } from '@contracts/tax';
import type { LeaseMarketSummaryResponse } from '@contracts/lease-market';

export function isInsuranceAnalysisEmpty(r: Pick<InsuranceAnalysisReport, 'policiesN'>): boolean {
  return r.policiesN === 0;
}

export function isTaxAnalysisEmpty(
  r: Pick<TaxAnalysisReport, 'assessments' | 'appeals' | 'opportunities' | 'ledgerTaxAnnualUsd'>,
): boolean {
  return r.assessments.length === 0 && r.appeals.length === 0 && r.opportunities.length === 0 && r.ledgerTaxAnnualUsd === null;
}

/** Nothing ever ingested. Ingested-but-not-computed keeps LeaseMarketModule's existing compute notice. */
export function isLeaseMarketEmpty(s: Pick<LeaseMarketSummaryResponse, 'kpis' | 'freshness'>): boolean {
  return s.kpis.activeSpaces === 0 && s.freshness.every((f) => f.lastLandingDate === null);
}

export const EMPTY_COPY = {
  insurance: {
    title: 'Savings Board',
    message: 'No insurance policies in the warehouse yet.',
    detail: 'Re-bid candidates, the renewal watch and the own-book benchmark are computed from policy terms in the warehouse. Import the policy/premium history (and dec pages for TIV), then reload.',
    command: 'npx tsx scripts/import-insurance-data.ts --policies <policies.json>',
  },
  taxes: {
    title: 'Taxes',
    message: 'No property-tax data in the warehouse yet.',
    detail: 'Assessments, appeals and opportunities need assessment rows (template: docs/templates/property-tax-assessments.template.csv) or ledger Taxes rows.',
    command: 'npx tsx scripts/import-assessments.ts <assessments.csv>',
  },
  leaseMarket: {
    title: 'Lease Market',
    message: 'No CoStar exports have been ingested yet.',
    detail: 'Drop the CoStar exports in the lease-market intake folder, ingest them, then compute the signals.',
    command: 'npm run lease-market:ingest && npm run lease-market:compute',
  },
} as const;
