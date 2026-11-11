// server/warehouse/lease-terms.ts
//
// The lease_terms read/seed layer for the PFI Lease-Run Pro Forma (migration 006).
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Data model & provenance).
//
// SEED PROVENANCE: the SUNBURST_SEED / FISHEL_SEED structured lease economics are transcribed
// verbatim from the 2026-06-14 lease-sweep encoding in Claude_Workspace/01_Workspace/
// build_proformas.py (the `sunburst` / `fishel` config dicts that drive the v1.0 Excel models).
// The engine MUST reconcile to those models to the dollar — see tests/unit/lease-run.test.ts.
//
// These are OWNED ORA assets (401-sunburst-hwy-cambridge-md / 7658-fishel-dr-n-dublin-oh,
// ratified in property-master.ts). No confidential active-deal terms appear here.
//
// The seed lives in TypeScript (not raw SQL) so it is type-checked against the LeaseTerm
// contract and reused by the golden test directly. seedLeaseTerms(db) writes it idempotently,
// mirroring seedPropertyMaster. Migration 006 creates the TABLE only.
import { LeaseTerm } from '../../src/contracts/lease-run';
import type { WarehouseDb } from './db';

// ── 401 Sunburst Hwy — Cambridge, MD (absolute NNN; 5,130 SF) ──────────────────────────────
// Contractual LY'27–LY'33 are hard data ($15.00/SF → $17.00/SF step on 4/1/2028). Option years
// LY'34–LY'43 are UNEXERCISED (no fixed rate in the lease) → option_assumed: the engine grows
// the expiring rate at renewalMarketGrowthPct. Floors (Opt1 68,940; Opt2 77,208) are recorded on
// the renewal options but sit BELOW current contractual rent (stale), so the growth proxy governs.
export const SUNBURST_SEED: LeaseTerm = LeaseTerm.parse({
  propertyId: '401-sunburst-hwy-cambridge-md',
  suite: null,
  tenant: 'Tenant 092 LLC (automotive service/tire)',
  rentableSf: 5130,
  structure: 'absolute_nnn',
  commencement: '2019-12-23',
  currentExpiry: '2033-03-31',
  rentSchedule: [
    { periodStart: '2026-04-01', periodEnd: '2027-03-31', leaseYearLabel: "LY '27", annualBaseRent: 76950, status: 'contractual' },
    { periodStart: '2027-04-01', periodEnd: '2028-03-31', leaseYearLabel: "LY '28", annualBaseRent: 76950, status: 'contractual' },
    { periodStart: '2028-04-01', periodEnd: '2029-03-31', leaseYearLabel: "LY '29", annualBaseRent: 87210, status: 'contractual' },
    { periodStart: '2029-04-01', periodEnd: '2030-03-31', leaseYearLabel: "LY '30", annualBaseRent: 87210, status: 'contractual' },
    { periodStart: '2030-04-01', periodEnd: '2031-03-31', leaseYearLabel: "LY '31", annualBaseRent: 87210, status: 'contractual' },
    { periodStart: '2031-04-01', periodEnd: '2032-03-31', leaseYearLabel: "LY '32", annualBaseRent: 87210, status: 'contractual' },
    { periodStart: '2032-04-01', periodEnd: '2033-03-31', leaseYearLabel: "LY '33", annualBaseRent: 87210, status: 'contractual' },
    // Option 1 (5 yr) — FRV/floor, unexercised → assumption (grown off the expiring rate).
    { periodStart: '2033-04-01', periodEnd: '2034-03-31', leaseYearLabel: "LY '34", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2034-04-01', periodEnd: '2035-03-31', leaseYearLabel: "LY '35", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2035-04-01', periodEnd: '2036-03-31', leaseYearLabel: "LY '36", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2036-04-01', periodEnd: '2037-03-31', leaseYearLabel: "LY '37", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2037-04-01', periodEnd: '2038-03-31', leaseYearLabel: "LY '38", annualBaseRent: null, status: 'option_assumed' },
    // Option 2 (5 yr) — FRV/floor, unexercised → assumption.
    { periodStart: '2038-04-01', periodEnd: '2039-03-31', leaseYearLabel: "LY '39", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2039-04-01', periodEnd: '2040-03-31', leaseYearLabel: "LY '40", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2040-04-01', periodEnd: '2041-03-31', leaseYearLabel: "LY '41", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2041-04-01', periodEnd: '2042-03-31', leaseYearLabel: "LY '42", annualBaseRent: null, status: 'option_assumed' },
    { periodStart: '2042-04-01', periodEnd: '2043-03-31', leaseYearLabel: "LY '43", annualBaseRent: null, status: 'option_assumed' },
  ],
  renewalOptions: [
    { termYears: 5, rentBasis: 'frv_or_floor', floorAnnual: 68940, notice: 'per lease' },
    { termYears: 5, rentBasis: 'frv_or_floor', floorAnnual: 77208, notice: 'per lease' },
  ],
  diligenceNotes: [
    'Confirm the two 5-yr renewal options survive the Addendum #1 term extension to 3/31/2033 (counsel).',
    'Confirm Landlord entity succession (Seafire → Fairground Village Center, LLC) in chain of title.',
    'No security deposit or guaranty found.',
    'Option rent = greater of FRV or floor; both floors are BELOW current contractual rent (stale) → FRV governs.',
  ],
  provenance: { sourceFile: '2026-06-14 lease-sweep (401 Sunburst lease + Addendum #1 + 2nd Amendment)', abstractDate: '2026-06-14', note: 'Absolute NNN; figures NET to landlord.' },
});

// ── 7658 Fishel Dr N — Dublin, OH (NNN; 24,000 SF) ─────────────────────────────────────────
// ALL base rent is hard data: Initial term (LY'26) + Renewal 1 exercised via tenant notice 3/11/2026
// (LY'27–LY'31, locked through 9/30/2031) + Option 2 (LY'32–LY'36) at the lease's pre-agreed §2.2
// FIXED rates. Opt 2 is unexercised but contractual-rate → option_contractual (data, NOT assumption).
export const FISHEL_SEED: LeaseTerm = LeaseTerm.parse({
  propertyId: '7658-fishel-dr-n-dublin-oh',
  suite: null,
  tenant: 'Tenant 153 LLC',
  rentableSf: 24000,
  structure: 'nnn',
  commencement: '2021-10-01',
  currentExpiry: '2031-09-30',
  rentSchedule: [
    { periodStart: '2025-10-01', periodEnd: '2026-09-30', leaseYearLabel: "LY '26", annualBaseRent: 102480, status: 'contractual' },
    { periodStart: '2026-10-01', periodEnd: '2027-09-30', leaseYearLabel: "LY '27", annualBaseRent: 104529.6, status: 'renewal_exercised' },
    { periodStart: '2027-10-01', periodEnd: '2028-09-30', leaseYearLabel: "LY '28", annualBaseRent: 106620.24, status: 'renewal_exercised' },
    { periodStart: '2028-10-01', periodEnd: '2029-09-30', leaseYearLabel: "LY '29", annualBaseRent: 108752.64, status: 'renewal_exercised' },
    { periodStart: '2029-10-01', periodEnd: '2030-09-30', leaseYearLabel: "LY '30", annualBaseRent: 110927.64, status: 'renewal_exercised' },
    { periodStart: '2030-10-01', periodEnd: '2031-09-30', leaseYearLabel: "LY '31", annualBaseRent: 113146.2, status: 'renewal_exercised' },
    // Option 2 (5 yr) — unexercised but at FIXED §2.2 rates → DATA, not an assumption.
    { periodStart: '2031-10-01', periodEnd: '2032-09-30', leaseYearLabel: "LY '32", annualBaseRent: 115409.16, status: 'option_contractual' },
    { periodStart: '2032-10-01', periodEnd: '2033-09-30', leaseYearLabel: "LY '33", annualBaseRent: 117717.36, status: 'option_contractual' },
    { periodStart: '2033-10-01', periodEnd: '2034-09-30', leaseYearLabel: "LY '34", annualBaseRent: 120071.64, status: 'option_contractual' },
    { periodStart: '2034-10-01', periodEnd: '2035-09-30', leaseYearLabel: "LY '35", annualBaseRent: 122473.08, status: 'option_contractual' },
    { periodStart: '2035-10-01', periodEnd: '2036-09-30', leaseYearLabel: "LY '36", annualBaseRent: 124922.52, status: 'option_contractual' },
  ],
  renewalOptions: [
    { termYears: 5, rentBasis: 'fixed', floorAnnual: null, notice: '§2.2 pre-agreed rates' },
  ],
  diligenceNotes: [
    'Confirm ORA (7658 Fishel, LLC) formally acknowledged the renewal notice and updated the rent roll.',
    "Confirm tenant's building-insurance certificate does not conflict with ORA's lender-required coverage.",
    'Confirm 24,000 SF against survey/rent roll.',
    'No security deposit or guaranty found.',
  ],
  provenance: { sourceFile: '2026-06-14 lease-sweep (7658 Fishel lease + tenant renewal notice 3/11/2026)', abstractDate: '2026-06-14', note: 'NNN in economic effect; tenant carries casualty insurance.' },
});

/** The v1 seed roster. Order is stable for deterministic seeding/rollup. */
export const LEASE_TERM_SEEDS: readonly LeaseTerm[] = [SUNBURST_SEED, FISHEL_SEED];

// ── Persistence (idempotent; mirrors seedPropertyMaster) ──────────────────────────────────
interface LeaseTermRow {
  property_id: string;
  suite: string | null;
  tenant: string;
  rentable_sf: number;
  structure: string;
  commencement: string;
  current_expiry: string;
  rent_schedule: string; // JSON
  renewal_options: string; // JSON
  diligence_notes: string; // JSON
  provenance: string | null; // JSON
}

function toRow(t: LeaseTerm): LeaseTermRow {
  return {
    property_id: t.propertyId,
    suite: t.suite,
    tenant: t.tenant,
    rentable_sf: t.rentableSf,
    structure: t.structure,
    commencement: t.commencement,
    current_expiry: t.currentExpiry,
    rent_schedule: JSON.stringify(t.rentSchedule),
    renewal_options: JSON.stringify(t.renewalOptions),
    diligence_notes: JSON.stringify(t.diligenceNotes),
    provenance: t.provenance ? JSON.stringify(t.provenance) : null,
  };
}

/** Reconstruct a LeaseTerm from a DB row, .parse()'d through the contract (fail-closed on bad JSON). */
function fromRow(r: LeaseTermRow): LeaseTerm {
  return LeaseTerm.parse({
    propertyId: r.property_id,
    suite: r.suite,
    tenant: r.tenant,
    rentableSf: r.rentable_sf,
    structure: r.structure,
    commencement: r.commencement,
    currentExpiry: r.current_expiry,
    rentSchedule: JSON.parse(r.rent_schedule),
    renewalOptions: JSON.parse(r.renewal_options),
    diligenceNotes: JSON.parse(r.diligence_notes),
    provenance: r.provenance ? JSON.parse(r.provenance) : null,
  });
}

/**
 * Seed lease_terms idempotently. Requires property_master to already hold the FK targets
 * (foreign_keys=ON) — call seedPropertyMaster(db) first. One row per (property_id, suite-or-'').
 * ON CONFLICT updates the schedule/options/notes so a re-seed refreshes the abstract.
 */
export function seedLeaseTerms(db: WarehouseDb): number {
  const up = db.prepare(`
    INSERT INTO lease_terms
      (property_id, suite, tenant, rentable_sf, structure, commencement, current_expiry,
       rent_schedule, renewal_options, diligence_notes, provenance)
    VALUES
      (@property_id, @suite, @tenant, @rentable_sf, @structure, @commencement, @current_expiry,
       @rent_schedule, @renewal_options, @diligence_notes, @provenance)
    ON CONFLICT(property_id, suite_key) DO UPDATE SET
      tenant=excluded.tenant, rentable_sf=excluded.rentable_sf, structure=excluded.structure,
      commencement=excluded.commencement, current_expiry=excluded.current_expiry,
      rent_schedule=excluded.rent_schedule, renewal_options=excluded.renewal_options,
      diligence_notes=excluded.diligence_notes, provenance=excluded.provenance,
      updated_at=datetime('now')
  `);
  const tx = db.transaction((terms: readonly LeaseTerm[]) => {
    let n = 0;
    for (const t of terms) {
      up.run(toRow(t));
      n += 1;
    }
    return n;
  });
  return tx(LEASE_TERM_SEEDS);
}

/** All lease terms for one property (single-tenant today → 0 or 1 rows; multi-tenant later → many). */
export function getLeaseTerms(db: WarehouseDb, propertyId: string): LeaseTerm[] {
  const rows = db
    .prepare('SELECT * FROM lease_terms WHERE property_id = ? ORDER BY suite_key')
    .all(propertyId) as LeaseTermRow[];
  return rows.map(fromRow);
}

/** Distinct property ids that have any lease terms, for the ownership rollup. */
export function listLeaseTermPropertyIds(db: WarehouseDb): string[] {
  const rows = db
    .prepare('SELECT DISTINCT property_id FROM lease_terms ORDER BY property_id')
    .all() as Array<{ property_id: string }>;
  return rows.map((r) => r.property_id);
}
