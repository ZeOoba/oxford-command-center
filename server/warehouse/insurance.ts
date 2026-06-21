// server/warehouse/insurance.ts
// Insurance policy persistence — Phase 5 G foundation.
// Writes PortfolioSnapshot.insurance policies to property_insurance_policies (migration 008).
// No alert conditions, no scoring, no financial-decision logic — pure data write path.
import type { InsurancePolicy } from '../../src/contracts/insurance';
import type { WarehouseDb } from './db';

export interface WarehouseInsurancePolicy {
  propertyId: string;
  insurer: string;
  policyNumber?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  premiumAnnual?: number | null;
  coverageTiv?: number | null;
  policyType: string;
  source: string;
  sourceDate: string;
  ingestedBy: string;
}

const INSERT_POLICY = `
  INSERT OR REPLACE INTO property_insurance_policies
    (property_id, insurer, policy_number, effective_date, expiration_date,
     premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_DQ = `
  INSERT INTO data_quality_issues (property_id, kind, detail, severity)
  VALUES (?, 'insurance-ingest-error', ?, 'error')
`;

/**
 * Map PortfolioSnapshot.insurance entries to WarehouseInsurancePolicy rows.
 * Called by the brain 'snapshot' listener before captureInsurance().
 */
export function snapshotPoliciesToWarehouse(
  policies: readonly InsurancePolicy[],
  sourceDate: string,
): WarehouseInsurancePolicy[] {
  return policies.map((p) => ({
    propertyId: p.id,
    insurer: p.carrier ?? 'Unknown',
    policyNumber: p.policyNo ?? null,
    effectiveDate: p.effective ?? null,
    expirationDate: p.expires ?? null,
    premiumAnnual: p.premium > 0 ? p.premium : null,
    coverageTiv: null,
    policyType: p.coverage ?? 'other',
    source: 'brain-server',
    sourceDate,
    ingestedBy: 'brain-server',
  }));
}

export function captureInsurance(db: WarehouseDb, policies: WarehouseInsurancePolicy[]): void {
  const insert = db.prepare(INSERT_POLICY);
  const dq = db.prepare(INSERT_DQ);
  for (const p of policies) {
    try {
      insert.run(
        p.propertyId,
        p.insurer,
        p.policyNumber ?? null,
        p.effectiveDate ?? null,
        p.expirationDate ?? null,
        p.premiumAnnual ?? null,
        p.coverageTiv ?? null,
        p.policyType,
        p.source,
        p.sourceDate,
        p.ingestedBy,
      );
    } catch (err) {
      try {
        dq.run(p.propertyId, err instanceof Error ? err.message : String(err));
      } catch {
        // dq insert failure is best-effort
      }
    }
  }
}
