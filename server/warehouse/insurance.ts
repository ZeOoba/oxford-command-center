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
  deductible?: number | null;
  coverageLimit?: number | null;
  policyType: string;
  source: string;
  sourceDate: string;
  ingestedBy: string;
  /** Per-policy TIV provenance notes (parse-time 'tiv' flags) — written to data_quality_issues as
   *  kind 'insurance-tiv-basis', one open row per distinct detail. */
  dataQualityNotes?: Array<{ detail: string; severity: 'info' | 'warn' | 'error' }>;
}

// Only rows with NO identifying key (policy_number or effective_date NULL) take this path — SQLite
// treats NULLs as distinct in UNIQUE(property_id, policy_number, effective_date), so they never
// collide; insurance-analysis.ts dedupeLatest collapses their repeat copies on content.
const INSERT_POLICY = `
  INSERT OR REPLACE INTO property_insurance_policies
    (property_id, insurer, policy_number, effective_date, expiration_date,
     premium_annual, coverage_tiv, deductible, coverage_limit, policy_type,
     source, source_date, ingested_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const EXISTING_POLICY = `
  SELECT id, coverage_tiv, deductible, coverage_limit, source, ingested_by
  FROM property_insurance_policies
  WHERE property_id = ? AND policy_number = ? AND effective_date = ?
`;

// UPDATE in place, never delete-and-reinsert: a REPLACE wiped every column the capture does not
// carry (--dec-pages deductible/coverage_limit) — refute wf_fb9dddc7-3a3. The id still ADVANCES
// to a fresh value, exactly as REPLACE used to re-mint it: insurance-analysis.ts dedupeLatest /
// collapseToCurrentTerm and insurance-conditions.ts isMoreCurrentRow break a same-source_date tie
// on the higher id as "captured most recently" (a same-day edit-and-revert must leave the
// reverted-to row current — refute wf_2086e104-f2a). No table references this id; rebid verdicts
// key on the policy's logical identity instead.
const UPDATE_POLICY = `
  UPDATE property_insurance_policies
  SET id = (SELECT MAX(COALESCE(MAX(p.id), 0),
                      COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'property_insurance_policies'), 0)) + 1
            FROM property_insurance_policies p),
      insurer = ?, expiration_date = ?, premium_annual = ?, coverage_tiv = ?, deductible = ?,
      coverage_limit = ?, policy_type = ?, source = ?, source_date = ?, ingested_by = ?,
      ingested_at = datetime('now')
  WHERE id = ?
`;

// Keep AUTOINCREMENT's high-water mark ahead of the advanced id so a later INSERT never reuses it.
const BUMP_SEQUENCE = `
  UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM property_insurance_policies)
  WHERE name = 'property_insurance_policies'
`;

const INSERT_DQ = `
  INSERT INTO data_quality_issues (property_id, kind, detail, severity)
  VALUES (?, 'insurance-ingest-error', ?, 'error')
`;

// Captures fire on every workbook refresh — an identical OPEN issue is never re-inserted.
const INSERT_DQ_ONCE = `
  INSERT INTO data_quality_issues (property_id, kind, detail, severity)
  SELECT ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1 FROM data_quality_issues
    WHERE property_id = ? AND kind = ? AND detail = ? AND status = 'open'
  )
`;

/** Two REAL dollar amounts within a cent are the same figure. */
const AMOUNT_TOLERANCE = 0.01;

interface ExistingPolicy {
  id: number;
  coverage_tiv: number | null;
  deductible: number | null;
  coverage_limit: number | null;
  source: string;
  ingested_by: string;
}

/**
 * Map PortfolioSnapshot.insurance entries to WarehouseInsurancePolicy rows.
 * Called by the brain 'snapshot' listener before captureInsurance().
 */
export function snapshotPoliciesToWarehouse(
  policies: readonly InsurancePolicy[],
  sourceDate: string,
): WarehouseInsurancePolicy[] {
  return policies.map((p) => {
    const notes = p.flags
      .filter((f) => f.field === 'tiv')
      .map((f) => ({ detail: `tiv: ${f.issue}`, severity: f.severity }));
    return {
      propertyId: p.id,
      insurer: p.carrier ?? 'Unknown',
      policyNumber: p.policyNo ?? null,
      effectiveDate: p.effective ?? null,
      expirationDate: p.expires ?? null,
      premiumAnnual: p.premium > 0 ? p.premium : null,
      coverageTiv: p.tiv ?? null,
      deductible: p.deductible ?? null,
      coverageLimit: p.coverageLimit ?? null,
      policyType: p.coverage ?? 'other',
      source: 'brain-server',
      sourceDate,
      ingestedBy: 'brain-server',
      ...(notes.length ? { dataQualityNotes: notes } : {}),
    };
  });
}

/**
 * DEC-PAGE PRECEDENCE (rulings 2026-09-24, Gabriel — "dec page wins", then "provenance-aware"
 * after refute wf_fb9dddc7-3a3). A keyed row (policy_number + effective_date) is UPDATEd in place
 * (its id advances — see UPDATE_POLICY):
 *  - coverage_tiv written by another writer (scripts/import-insurance-data.ts — a declaration) is
 *    never erased or overwritten by a capture; a differing capture value is logged once as
 *    'insurance-tiv-conflict', and that row keeps its source/ingested_by, the provenance the
 *    protection rests on. A TIV a capture wrote follows the workbook on the next capture — a
 *    corrected Premium History cell flows through, and a term the tab no longer resolves goes null.
 *  - deductible / coverage_limit are written by --dec-pages without a provenance mark, so a stored
 *    value is never erased by a null and never overwritten ('insurance-decpage-conflict').
 *  - A second row with the same key in one capture is skipped and logged — two workbook rows
 *    must never blend into one policy row.
 * Rows with no key are inserted (see INSERT_POLICY).
 */
export function captureInsurance(db: WarehouseDb, policies: WarehouseInsurancePolicy[]): void {
  const insert = db.prepare(INSERT_POLICY);
  const findExisting = db.prepare(EXISTING_POLICY);
  const update = db.prepare(UPDATE_POLICY);
  const bumpSequence = db.prepare(BUMP_SEQUENCE);
  const dq = db.prepare(INSERT_DQ);
  const dqOnce = db.prepare(INSERT_DQ_ONCE);
  const logOnce = (propertyId: string, kind: string, detail: string, severity: string): void => {
    try {
      dqOnce.run(propertyId, kind, detail, severity, propertyId, kind, detail);
    } catch {
      // dq insert failure is best-effort
    }
  };
  const seen = new Set<string>();
  for (const p of policies) {
    try {
      if (!p.policyNumber || !p.effectiveDate) {
        insert.run(
          p.propertyId, p.insurer, p.policyNumber ?? null, p.effectiveDate ?? null, p.expirationDate ?? null,
          p.premiumAnnual ?? null, p.coverageTiv ?? null, p.deductible ?? null, p.coverageLimit ?? null,
          p.policyType, p.source, p.sourceDate, p.ingestedBy,
        );
      } else {
        const key = `${p.propertyId}|${p.policyNumber}|${p.effectiveDate}`;
        if (seen.has(key)) {
          logOnce(
            p.propertyId,
            'insurance-ingest-duplicate-key',
            `policy ${p.policyNumber} eff ${p.effectiveDate}: a second ${p.source} row (${p.policyType}) carries the same key in one capture — skipped, first row kept`,
            'warn',
          );
          continue;
        }
        seen.add(key);
        const prior = findExisting.get(p.propertyId, p.policyNumber, p.effectiveDate) as ExistingPolicy | undefined;
        if (!prior) {
          insert.run(
            p.propertyId, p.insurer, p.policyNumber, p.effectiveDate, p.expirationDate ?? null,
            p.premiumAnnual ?? null, p.coverageTiv ?? null, p.deductible ?? null, p.coverageLimit ?? null,
            p.policyType, p.source, p.sourceDate, p.ingestedBy,
          );
        } else {
          const term = `policy ${p.policyNumber} eff ${p.effectiveDate}`;
          const keep = (field: string, kind: string, known: number | null, incoming: number | null): number | null => {
            if (known === null) return incoming;
            if (incoming !== null && Math.abs(incoming - known) > AMOUNT_TOLERANCE) {
              logOnce(
                p.propertyId,
                kind,
                `${term}: kept existing ${field} ${known}; ${p.source} capture carried ${incoming} (dec-page precedence — correct via import-insurance-data if the existing value is wrong)`,
                'warn',
              );
            }
            return known;
          };
          const decTiv = prior.coverage_tiv !== null && prior.ingested_by !== p.ingestedBy;
          const tiv = decTiv
            ? keep('TIV', 'insurance-tiv-conflict', prior.coverage_tiv, p.coverageTiv ?? null)
            : p.coverageTiv ?? null;
          update.run(
            p.insurer,
            p.expirationDate ?? null,
            p.premiumAnnual ?? null,
            tiv,
            keep('deductible', 'insurance-decpage-conflict', prior.deductible, p.deductible ?? null),
            keep('coverage limit', 'insurance-decpage-conflict', prior.coverage_limit, p.coverageLimit ?? null),
            p.policyType,
            decTiv ? prior.source : p.source,
            p.sourceDate,
            decTiv ? prior.ingested_by : p.ingestedBy,
            prior.id,
          );
          bumpSequence.run();
        }
      }
      for (const n of p.dataQualityNotes ?? []) logOnce(p.propertyId, 'insurance-tiv-basis', n.detail, n.severity);
    } catch (err) {
      try {
        dq.run(p.propertyId, err instanceof Error ? err.message : String(err));
      } catch {
        // dq insert failure is best-effort
      }
    }
  }
}
