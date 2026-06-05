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
  dataQuality: z.array(DataQualityFlag),
});
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshot>;
