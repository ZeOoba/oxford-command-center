// server/warehouse/tax-strategy.ts
//
// P4c / C2 — Tax STRATEGY engine. Produces the TaxStrategyReport wire contract
// (src/contracts/tax-strategy.ts) from Task 2's placeholder resolvers plus real
// property_master ownership data.
//
// THREE LOAD-BEARING RULES (mirror the contract header — a future edit must not break them):
//
//   (1) savingsFullAsset / savingsOxfordShare are HARD-NULL, ALWAYS. v1 makes no marginal-rate
//       assumption and will not invent a tax-savings dollar. The contract types them z.null(),
//       so any non-null value is rejected at parse; this engine never even computes one.
//
//   (2) firstYearAcceleration* are DEDUCTION TIMING, not tax dollars — how much depreciation a
//       cost-seg study pulls into year one (reclassifiableBasis × bonusYearPct), and its Oxford
//       variant applies the REAL roster ownershipPct, nothing more. A missing bonus-schedule year
//       yields null + indeterminate, never a guessed $0.
//
//   (3) filed returns are METADATA-ONLY (C2 confidentiality boundary) — mapped 1:1 from the
//       resolver, no contents ever.
//
// NO DB WRITES. NO CALIBRATION imports/calls anywhere in this file — pure read + compute. The
// engine reads via Task 2's resolvers (which own the fs/db access) and getPropertyMaster, then
// Zod-parses its own output before returning (boundary discipline, mirrors the loss engine).
import {
  TaxStrategyReport,
  type CostSegOpportunity,
  type EntityStrategyItem,
  type FiledReturnMeta,
} from '../../src/contracts/tax-strategy';
import { resolveDepreciableBasis, resolveFiledReturns, type DataSource } from './placeholder-data';
import { getPropertyMaster } from './property-master';
import type { WarehouseDb } from './db';

// Static qualitative entity/structuring strategies. Deliberately carry NO dollar figure — sizing
// any of these needs a marginal rate + facts v1 does not assume (contract rule 2, entity level).
// The exact phrase below is asserted by the contract's consumers and the tests; do not reword it.
const QUALITATIVE_PHRASE =
  'Qualitative placeholder — review with accountant; no dollar impact is computed by design.';

const ENTITY_STRATEGIES: readonly EntityStrategyItem[] = [
  {
    id: 'es-entity-review',
    title: 'Holding-entity structure review',
    detail:
      'Review the single-purpose LLC / holding structure for each asset against basis-step-up, ' +
      'estate, and state-nexus considerations. Structuring choices change timing and character of ' +
      'income, not modeled here.',
    kind: 'entity-structure',
    applicabilityNote: `${QUALITATIVE_PHRASE} Applicability depends on entity facts (ownership chain, state footprint) outside this dataset.`,
  },
  {
    id: 'es-sec469-grouping',
    title: 'Section 469 passive-activity grouping election',
    detail:
      'Consider a §469 grouping election and material-participation / real-estate-professional ' +
      'posture so passive losses (including accelerated cost-seg deductions) can offset the intended ' +
      'income. Sizing requires each owner’s participation facts.',
    kind: 'sec469',
    applicabilityNote: `${QUALITATIVE_PHRASE} Whether grouping helps turns on each principal’s participation profile, not known here.`,
  },
  {
    id: 'es-pipeline-1031',
    title: 'Acquisition-pipeline 1031 planning',
    detail:
      'Sequence dispositions and acquisitions across the pipeline for §1031 like-kind deferral ' +
      '(carryover basis, 45/180-day windows, qualified intermediary). Deferral value depends on ' +
      'realized gain and replacement timing.',
    kind: 'pipeline',
    applicabilityNote: `${QUALITATIVE_PHRASE} Deferral opportunity depends on realized gains and replacement timing not modeled in v1.`,
  },
];

/** Provenance source label for the basis figures — future-proofed for a real-data path even though
 *  resolveDepreciableBasis is fixture-only in v1 (source is 'placeholder', or 'absent' with no rows). */
function basisProvSource(source: DataSource): string {
  return source === 'warehouse' ? 'warehouse' : 'depreciable-basis.placeholder.json';
}

const ACCELERATION_FORMULA =
  'reclassifiableBasis = depreciableBasis × reclassifiablePct; ' +
  'firstYearAccelerationUsd = reclassifiableBasis × bonusYearPct; ' +
  'firstYearAccelerationOxfordShare = firstYearAccelerationUsd × ownershipPct — DEDUCTION timing, not tax dollars';

/** Per-row basis note: the resolver's schedule note plus the deduction-timing (not tax dollars) reminder. */
function buildBasisNote(scheduleNote: string): string {
  const prefix = scheduleNote.length > 0 ? `${scheduleNote} ` : '';
  return (
    `${prefix}These are deduction-timing (first-year acceleration) figures — the depreciation deduction ` +
    `pulled into year one — not tax dollars saved; converting to tax saved requires a marginal-rate ` +
    `assumption this layer does not make.`
  );
}

/**
 * Build the tax STRATEGY report for `asOf` (ISO date; currentYear = its leading 4 digits).
 * Reads placeholder basis/filed-returns fixtures (Task 2) + real property_master ownership.
 * No DB writes, no calibration. Zod-parses its own output before returning.
 */
export function buildTaxStrategyReport(db: WarehouseDb, asOf: string): TaxStrategyReport {
  const currentYear = parseInt(asOf.slice(0, 4), 10);

  const basis = resolveDepreciableBasis(db);
  const filed = resolveFiledReturns();

  // Real roster: propertyName + ownershipPct. getPropertyMaster returns DB rows (win on id) plus
  // canon seed records, so it is a SUPERSET of the property_master table the basis resolver filters
  // against — every surviving basis row therefore resolves here. The not-found branch is defensive
  // only (unreachable by construction) and, if it ever fired, is disclosed in droppedFixtureRows.
  const masterById = new Map(getPropertyMaster(db).map((p) => [p.id, p]));

  // bonusYearPct is constant across rows (keyed on the report year, not the row) — resolve once.
  const bonusYearPct = basis.bonusPctByYear[String(currentYear)] ?? null;
  const provSource = basisProvSource(basis.source);
  const rowBasisNote = buildBasisNote(basis.scheduleNote);

  let defensiveDrops = 0;
  const costSeg: CostSegOpportunity[] = [];
  for (const row of basis.rows) {
    const master = masterById.get(row.propertyId);
    if (master === undefined) {
      // Should not happen (resolver already filtered to table ids); count + skip defensively.
      defensiveDrops += 1;
      continue;
    }

    const reclassifiableBasis = row.depreciableBasis * row.reclassifiablePct;
    const firstYearAccelerationUsd = bonusYearPct === null ? null : reclassifiableBasis * bonusYearPct;
    const firstYearAccelerationOxfordShare =
      firstYearAccelerationUsd === null ? null : firstYearAccelerationUsd * master.ownershipPct;

    costSeg.push({
      propertyId: row.propertyId,
      propertyName: master.name,
      depreciableBasis: row.depreciableBasis,
      landAllocationPct: row.landAllocationPct,
      reclassifiablePct: row.reclassifiablePct,
      reclassifiableBasis,
      bonusYearPct,
      firstYearAccelerationUsd,
      firstYearAccelerationOxfordShare,
      savingsFullAsset: null, // rule 1 — ALWAYS null
      savingsOxfordShare: null, // rule 1 — ALWAYS null
      indeterminate: bonusYearPct === null,
      basisNote: rowBasisNote,
      prov: {
        source: provSource,
        confidence: 'estimated',
        formula: ACCELERATION_FORMULA,
      },
    });
  }

  // Deterministic ordering (total order by propertyId) — stable across refreshes.
  costSeg.sort((a, b) => a.propertyId.localeCompare(b.propertyId));

  const filedReturns: FiledReturnMeta[] = filed.rows.map((r) => ({
    id: r.id,
    taxYear: r.taxYear,
    entity: r.entity,
    preparer: r.preparer,
    status: r.status,
    storageNote: r.storageNote,
  }));

  return TaxStrategyReport.parse({
    asOf,
    basisDataSource: basis.source,
    filedReturnsDataSource: filed.source,
    droppedFixtureRows: basis.droppedRows + defensiveDrops,
    scheduleNote: basis.scheduleNote,
    costSeg,
    entityStrategies: ENTITY_STRATEGIES,
    filedReturns,
    advisoryOnly: true,
  });
}
