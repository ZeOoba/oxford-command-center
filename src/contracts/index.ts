import { z } from 'zod';
import { DataQualityFlag, SCHEMA_VERSION } from './common';
import { Property } from './property';
import { Lease } from './lease';
import { Loan } from './loan';
import { CashSnapshot } from './cash';
import { InsurancePolicy } from './insurance';
import { Deal } from './deal';
import { Task } from './task';
import { Counterparty } from './counterparty';
import { Assumptions, ScenarioName } from './scenario';
import { RenewalStage } from './renewal';
import { CompSet } from './comps';
import { AcquisitionInput } from './acquisition';
import { QbActuals, TenantArrears } from './quickbooks';

export * from './common';
export * from './brain';
export * from './property';
export * from './lease';
export * from './loan';
export * from './cash';
export * from './insurance';
export * from './deal';
export * from './task';
export * from './counterparty';
export * from './macro';
export * from './scenario';
export * from './renewal';
export * from './comps';
export * from './quickbooks';
export * from './acquisition';
export * from './debt';
export * from './lease-forecast';
export * from './prospect-demand';
export * from './capital';
export * from './capital-allocation';
export * from './market-intelligence';
export * from './regional-macro';
export * from './notion-writeback';
export * from './tax';
export * from './insurance-analysis';
export * from './brain-report';

export const SnapshotMeta = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  asOf: z.string(), // ISO — the workbook "As of" date
  generatedAt: z.string(), // ISO — when this snapshot was built
  source: z.string(), // e.g. "Master Excel Template Company Wide -- Oxford.xlsx"
  scenario: ScenarioName,
});
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

/**
 * THE typed boundary between every data source and the UI.
 * The whole app renders from exactly this shape — mock, live-Excel, or future API.
 */
/** The ratified capital-governor boundaries the client alert engine reads (I10). */
export const GovernorSet = z.object({
  dscrFloor: z.number(),
  ltvCeiling: z.number(),
  version: z.number(),
  effectiveFrom: z.string(),
});
export type GovernorSet = z.infer<typeof GovernorSet>;

/**
 * FALLBACK governor set for legacy snapshots that predate the server-attached payload (I10).
 * A guarded mirror of the server's compile-time ratified set — tests/unit/conditions.test.ts
 * drift-pins it to server/warehouse/capital-config.ts CAPITAL_CONFIG; never edit one without
 * the other (CLAUDE.md §4).
 */
export const GOVERNOR_FALLBACK: GovernorSet = {
  dscrFloor: 1.25,
  ltvCeiling: 0.40,
  version: 1,
  effectiveFrom: '2026-06-13',
};

export const PortfolioSnapshot = z.object({
  meta: SnapshotMeta,
  assumptions: Assumptions,
  properties: z.array(Property),
  leases: z.array(Lease),
  loans: z.array(Loan),
  cash: CashSnapshot,
  insurance: z.array(InsurancePolicy),
  deals: z.array(Deal),
  tasks: z.array(Task),
  counterparties: z.array(Counterparty).default([]),
  /** Overlay-sourced lease renewal pipeline stages (Phase 2). Workbook has none → defaults empty. */
  renewalStages: z.record(z.string(), RenewalStage).default({}),
  /** Overlay-sourced free-text tenant notes (Phase 2), keyed by tenant slug. */
  tenantNotes: z.record(z.string(), z.string()).default({}),
  /** Overlay-sourced, AI-researched market comps per deal (Phase 3). Workbook has none → empty. */
  dealComps: z.record(z.string(), CompSet).default({}),
  /** Overlay-sourced per-deal acquisition underwriting inputs (Acquisition Workbench). Workbook has none → empty. */
  acquisitionInputs: z.record(z.string(), AcquisitionInput).default({}),
  /** Overlay-sourced per-property annual NOI budget targets (Phase 3 ②). */
  noiBudgets: z.record(z.string(), z.number()).default({}),
  /** Overlay-sourced per-lease AR aging (audit Fix #2 — collections), keyed by Lease.id. Workbook has none → empty. */
  tenantArrears: z.record(z.string(), TenantArrears).default({}),
  /** Server-attached QuickBooks actuals (Phase 3 ②); null when no export configured. */
  quickbooks: QbActuals.nullable().default(null),
  /** Server/bake-attached ratified governor set (I10); null on legacy payloads → GOVERNOR_FALLBACK. */
  governors: GovernorSet.nullable().default(null),
  /**
   * Phase 3 — user-supplied market rents ($/SF PSF, annual) from overlay.marketRents.
   * Keyed by leaseId (precedence) or propertyKey. Empty when no market rents have been entered.
   * Used by the under-market gap signal (L-4), rent-forecast renew_at_market, and the
   * LeaseForecastModule UI. No external API — overlay-only.
   */
  marketRents: z.record(z.string(), z.number()).default({}),
  dataQuality: z.array(DataQualityFlag),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshot>;
