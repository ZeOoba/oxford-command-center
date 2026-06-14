// server/warehouse/capital-config.ts
//
// PFI Phase 1 — Capital governance constants: the ratified financial governors
// for ORA's acquisition, disposition, refi, and CapEx decision framework.
//
// HARD INVARIANTS per CLAUDE.md §4: dscrFloor and ltvCeiling must NEVER be changed
// without explicit Gabriel ratification. Any change also requires: a new row in the
// capital_config DB table, and a calibration_log entry via appendCalibrationLog().
//
// Governor set ratified 2026-06-13:
//   DISPOSITION <6.5% | HOLD 6.5–7.5% | ACQ-IRR ≥12% | CAPEX-IRR ≥15%
//   Refi trigger: +150 bps | Payout: 0% (full reinvest, Gabriel confirmed)
import type { WarehouseDb } from './db';

export interface CapitalConfigRow {
  version: number;
  effectiveFrom: string;
  dscrFloor: number;
  ltvCeiling: number;
  dispositionCapRate: number;
  holdCapRate: number;
  acqIrr: number;
  capexIrr: number;
  refiTriggerBps: number;
  payoutPct: number;
  notes: string | null;
}

/** Compile-time ratified constants — authoritative live view (version 1, 2026-06-13). */
export const CAPITAL_CONFIG = {
  version: 1,
  effectiveFrom: '2026-06-13',
  // HARD INVARIANTS (CLAUDE.md §4 — never mutate without explicit permission)
  dscrFloor: 1.25,
  ltvCeiling: 0.40,
  // Governor set
  dispositionCapRate: 0.065,
  holdCapRate: 0.075,
  acqIrr: 0.12,
  capexIrr: 0.15,
  refiTriggerBps: 150,
  payoutPct: 0.0,
} as const;

export type CapitalConfig = typeof CAPITAL_CONFIG;

/** Load the latest ratified config from the DB (falls back to compile-time constant if DB is empty). */
export function loadCapitalConfig(db: WarehouseDb): CapitalConfigRow {
  const row = db
    .prepare(
      `SELECT version,
              effective_from        AS effectiveFrom,
              dscr_floor            AS dscrFloor,
              ltv_ceiling           AS ltvCeiling,
              disposition_cap_rate  AS dispositionCapRate,
              hold_cap_rate         AS holdCapRate,
              acq_irr               AS acqIrr,
              capex_irr             AS capexIrr,
              refi_trigger_bps      AS refiTriggerBps,
              payout_pct            AS payoutPct,
              notes
       FROM capital_config
       ORDER BY version DESC
       LIMIT 1`,
    )
    .get() as CapitalConfigRow | undefined;

  if (!row) {
    // DB empty (cold environment before migration ran) — return compile-time fallback.
    return { ...CAPITAL_CONFIG, notes: null };
  }
  return row;
}

/** Append an entry to the calibration_log when any governance parameter changes. */
export function appendCalibrationLog(
  db: WarehouseDb,
  params: {
    configTable: string;
    paramKey: string;
    oldValue?: unknown;
    newValue: unknown;
    rationale?: string;
    sessionId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO calibration_log
       (config_table, param_key, old_value, new_value, rationale, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.configTable,
    params.paramKey,
    params.oldValue !== undefined && params.oldValue !== null
      ? JSON.stringify(params.oldValue)
      : null,
    JSON.stringify(params.newValue),
    params.rationale ?? null,
    params.sessionId ?? null,
  );
}
