// server/warehouse/lease-terms.ts
//
// The lease_terms read/seed layer for the PFI Lease-Run Pro Forma (migration 006).
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md (Data model & provenance).
//
// SEED ROSTER: the structured lease abstracts (tenant, rent schedule, options, notes, provenance) are
// real firm data, so they live in the gitignored operator table config/local/lease-term-seeds.json
// (ruling 2026-11-10: real firm data is never tracked; a real-data manifest path with a synthetic
// stand-in under fixtures/synthetic/). On the operator machine the real roster is rebuilt from the
// pre-untrack commit by scripts/extract-local-tables.ts. On real data the engine output is locked by
// the ratified golden (data/property-financials/golden.local.json, `leaseRun`: a snapshot of engine
// output that golden:ratify checks against the pre-untrack Excel-model figures from git history), and
// its math by tests/unit/lease-run.test.ts on synthetic seeds.
//
// These are OWNED ORA assets (ratified in property-master.ts). No confidential active-deal terms.
//
// Each row is .parse()'d through the LeaseTerm contract on load, so a malformed table fails closed.
// seedLeaseTerms(db) writes the roster idempotently, mirroring seedPropertyMaster. Migration 006
// creates the TABLE only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeaseTerm } from '../../src/contracts/lease-run';
import type { WarehouseDb } from './db';

/** Repo-relative path of the operator lease-term roster (a real-data manifest path). */
export const LEASE_TERM_SEEDS_REL = 'config/local/lease-term-seeds.json';

/** The lease-term roster, in file order (stable for deterministic seeding / rollup). Throws when the
 *  table is missing or a row fails the LeaseTerm contract: seeding must never silently write nothing
 *  over a populated warehouse, nor write a partial roster. */
export function loadLeaseTermSeeds(root: string = process.cwd()): LeaseTerm[] {
  const path = join(root, LEASE_TERM_SEEDS_REL);
  if (!existsSync(path)) {
    throw new Error(
      `lease-terms: ${LEASE_TERM_SEEDS_REL} is missing. It is a local-only operator table: rebuild it with ` +
        '`npx tsx scripts/extract-local-tables.ts <pre-pull ref>` (docs/ops/2026-11-11-real-data-untrack-pull-runbook.md).',
    );
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(rows)) throw new Error(`lease-terms: ${LEASE_TERM_SEEDS_REL} must hold a JSON array of LeaseTerm rows`);
  return rows.map((r) => LeaseTerm.parse(r));
}

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
 * ON CONFLICT updates the schedule/options/notes so a re-seed refreshes the abstract. The roster
 * defaults to the operator table (loadLeaseTermSeeds); tests pass their own.
 */
export function seedLeaseTerms(db: WarehouseDb, seeds: readonly LeaseTerm[] = loadLeaseTermSeeds()): number {
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
  return tx(seeds);
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
