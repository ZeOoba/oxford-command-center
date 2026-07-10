// src/contracts/tax-strategy.ts
//
// P4c C2 placeholder buildout — Tax STRATEGY contracts (cost-segregation opportunities,
// entity-structure strategies, filed-returns metadata). This is the placeholder-data-driven
// sibling of tax.ts (Phase 6, assessment/appeal only), which explicitly deferred filed
// returns + cost-seg to "cut list C2". This file re-opens exactly those C2 items under the
// placeholder-data regime, and it INHERITS the C2 confidentiality boundary that put them on
// the cut list in the first place. Three load-bearing rules, encoded in the schemas below —
// not left to convention:
//
//   (1) FILED RETURNS ARE METADATA-ONLY, PERMANENTLY. This is the C2 confidentiality
//       boundary. Return CONTENTS never enter this system — not in placeholder form, not
//       when real data lands. `FiledReturnMeta` carries only catalog metadata (year, entity,
//       preparer, status) plus a `storageNote`; there is deliberately NO field for return
//       contents. The real-data swap (Task 11) replaces the placeholder metadata with real
//       metadata + a SharePoint link-out ONLY — the documents themselves stay in SharePoint.
//
//   (2) `savingsFullAsset` / `savingsOxfordShare` ARE HARD-NULL IN v1 — typed `z.null()`,
//       so any non-null value is REJECTED by the schema itself. v1 makes no marginal-rate
//       assumption; it will not invent a tax-savings dollar figure. (Contrast tax.ts's
//       TaxOpportunity, where those same field names are `z.number().nullable()` because an
//       appeal's savings is a real, computable assessment delta. Same names, different basis
//       discipline — see the schema/type same-name convention this file matches.)
//
//   (3) The `firstYearAcceleration*` figures are DEDUCTION TIMING, not tax-savings dollars.
//       They quantify how much depreciation deduction a cost-seg study accelerates into year
//       one (reclassifiableBasis × bonusYearPct), NOT dollars of tax saved. Converting a
//       deduction to a tax dollar needs a marginal rate — which, per rule (2), v1 refuses to
//       assume. The Oxford-share variant applies the real ownership percentage, nothing more.
import { z } from 'zod';
import { Provenance } from './common';

/** Provenance of a strategy surface's inputs: live warehouse, placeholder fixture, or absent. */
export const StrategyDataSource = z.enum(['warehouse', 'placeholder', 'absent']);
export type StrategyDataSource = z.infer<typeof StrategyDataSource>;

// ── CostSegOpportunity ─────────────────────────────────────────────────────────
// One property's cost-segregation acceleration opportunity. `savings*` are HARD-NULL (rule 2);
// the acceleration figures are DEDUCTION TIMING (rule 3), never tax dollars. Nulls on the
// bonus/acceleration fields mean the placeholder schedule had no entry for the year — surfaced
// as `indeterminate`, never a guessed $0.
export const CostSegOpportunity = z.object({
  propertyId: z.string().min(1),
  propertyName: z.string().nullable(),
  depreciableBasis: z.number().nonnegative(),
  landAllocationPct: z.number().min(0).max(1),
  reclassifiablePct: z.number().min(0).max(1),
  reclassifiableBasis: z.number().nonnegative(),          // depreciableBasis × reclassifiablePct
  bonusYearPct: z.number().min(0).max(1).nullable(),      // from placeholder schedule; null when year missing
  firstYearAccelerationUsd: z.number().nonnegative().nullable(), // reclassifiableBasis × bonusYearPct — DEDUCTION acceleration, not tax dollars
  firstYearAccelerationOxfordShare: z.number().nonnegative().nullable(), // × real ownershipPct
  savingsFullAsset: z.null(),                             // v1: ALWAYS null — no marginal-rate assumption
  savingsOxfordShare: z.null(),                           // v1: ALWAYS null
  indeterminate: z.boolean(),
  basisNote: z.string(),
  prov: Provenance,
});
export type CostSegOpportunity = z.infer<typeof CostSegOpportunity>;

// ── EntityStrategyItem ─────────────────────────────────────────────────────────
// A qualitative entity/structuring strategy. Deliberately carries NO dollar figure — the
// `applicabilityNote` is prose only. Sizing an entity strategy needs marginal-rate + facts v1
// does not assume (rule 2's discipline, applied at the entity level).
export const EntityStrategyItem = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  kind: z.enum(['entity-structure', 'sec469', 'pipeline']),
  applicabilityNote: z.string(), // qualitative; no dollars by design
});
export type EntityStrategyItem = z.infer<typeof EntityStrategyItem>;

// ── FiledReturnMeta ────────────────────────────────────────────────────────────
// C2 confidentiality boundary (rule 1): metadata-only, PERMANENTLY. No field for return
// contents exists or ever will — `storageNote` points to the SharePoint link-out; the
// documents stay there.
export const FiledReturnMeta = z.object({
  id: z.string().min(1),
  taxYear: z.number().int(),
  entity: z.string(),
  preparer: z.string().nullable(),
  status: z.enum(['filed', 'extended', 'amended']),
  storageNote: z.string(),
});
export type FiledReturnMeta = z.infer<typeof FiledReturnMeta>;

// ── Report envelope ────────────────────────────────────────────────────────────
// GET /api/warehouse/tax/strategy response envelope. `advisoryOnly` is the literal `true`
// (belt-and-suspenders, mirroring tax.ts / insights.ts) — this surface never auto-executes.
export const TaxStrategyReport = z.object({
  asOf: z.string(),
  basisDataSource: StrategyDataSource,
  filedReturnsDataSource: StrategyDataSource,
  droppedFixtureRows: z.number().int().nonnegative(),
  scheduleNote: z.string(),
  costSeg: z.array(CostSegOpportunity),
  entityStrategies: z.array(EntityStrategyItem),
  filedReturns: z.array(FiledReturnMeta),
  advisoryOnly: z.literal(true),
});
export type TaxStrategyReport = z.infer<typeof TaxStrategyReport>;
