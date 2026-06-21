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
  // ── Phase 5 hurdle-rate governor ──
  hurdleRatePct: number;                 // default 0.08
  hurdleRateRatification: 'ratified' | 'proposed';
  hurdleRateRatifiedBy: string | null;
  hurdleRateRatifiedDate: string | null;
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
  // ── Phase 5 hurdle-rate governor (proposed — awaiting Gabriel ratification) ──
  hurdleRatePct: 0.08,
  hurdleRateRatification: 'proposed' as const,
  hurdleRateRatifiedBy: null as string | null,
  hurdleRateRatifiedDate: null as string | null,
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
              notes,
              hurdle_rate_pct           AS hurdleRatePct,
              hurdle_rate_ratification  AS hurdleRateRatification,
              hurdle_rate_ratified_by   AS hurdleRateRatifiedBy,
              hurdle_rate_ratified_date AS hurdleRateRatifiedDate
       FROM capital_config
       ORDER BY version DESC
       LIMIT 1`,
    )
    .get() as CapitalConfigRow | undefined;

  if (!row) {
    // DB empty (cold environment before migration ran) — return compile-time fallback.
    // CAPITAL_CONFIG already carries the hurdle-rate fields (proposed, 0.08); spread
    // picks them up automatically so the cold-start path is always fail-closed.
    return { ...CAPITAL_CONFIG, notes: null };
  }
  return row;
}

/** Mutable governor fields for a governed config change. effectiveFrom is the ratification date. */
export interface CapitalConfigUpdate {
  dscrFloor?: number;
  ltvCeiling?: number;
  dispositionCapRate?: number;
  holdCapRate?: number;
  acqIrr?: number;
  capexIrr?: number;
  refiTriggerBps?: number;
  payoutPct?: number;
  effectiveFrom: string;
  notes?: string;
}

// The numeric governor keys — used for finite-validation, change detection, and per-param logging.
const NUMERIC_KEYS = [
  'dscrFloor', 'ltvCeiling', 'dispositionCapRate', 'holdCapRate',
  'acqIrr', 'capexIrr', 'refiTriggerBps', 'payoutPct',
] as const;

/**
 * The ONLY governed write path for the financial governors. Validates a proposed change
 * against the CLAUDE.md §4 hard invariants (DSCR ≥ 1.25, LTV ≤ 0.40), the unit-interval
 * range of every rate/pct, and the disposition<hold<acqIrr<capexIrr ordering; then inserts
 * a NEW version row and writes one calibration_log entry per changed parameter — atomically.
 *
 * It NEVER mutates an existing row (append-only history) and REFUSES (throws, no write) any
 * breach. This is the live caller that gives appendCalibrationLog its audit purpose: every
 * future governor change flows through here, leaving an attributable trail. Current values
 * are unaffected — calling this with the ratified set is a no-op-reject.
 *
 * Deliberately NOT exposed as an HTTP route: governor changes require Gabriel ratification
 * (invariant 4), so the call site is supervised code, not an open endpoint.
 *
 * Selection semantics: loadCapitalConfig returns the HIGHEST version (monotonic ratification
 * order) — `effectiveFrom` is an audit anchor, not a selection key. To keep that audit timeline
 * coherent we reject a non-ISO or backdated effectiveFrom (earlier than the current live set's).
 */
export function writeCapitalConfig(
  db: WarehouseDb,
  update: CapitalConfigUpdate,
  meta: { rationale?: string; sessionId?: string },
): CapitalConfigRow {
  const current = loadCapitalConfig(db);

  // (1) Every provided numeric field must be finite — guards NaN/±Infinity slipping past < / >.
  for (const k of NUMERIC_KEYS) {
    const v = update[k];
    if (v !== undefined && !Number.isFinite(v)) {
      throw new Error(`capital-config: ${k} must be a finite number, got ${v}`);
    }
  }
  if (update.refiTriggerBps !== undefined &&
      (!Number.isInteger(update.refiTriggerBps) || update.refiTriggerBps < 0)) {
    throw new Error(`capital-config: refiTriggerBps must be a non-negative integer, got ${update.refiTriggerBps}`);
  }

  // (1b) effectiveFrom is the ratification-date anchor of the audit trail — validate it like a
  // first-class field, not a free string. Must be a real ISO date and not backdated before the
  // current live set (which would scramble the append-only governance timeline). Round-trip the
  // parse so a regex-passing but calendar-overflow value ('2026-02-30', non-leap '2025-02-29') is
  // rejected rather than silently rolled forward by Date() into the governance record.
  const efDate = new Date(update.effectiveFrom + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(update.effectiveFrom) ||
      Number.isNaN(efDate.getTime()) ||
      efDate.toISOString().slice(0, 10) !== update.effectiveFrom) {
    throw new Error(`capital-config: effectiveFrom must be a real ISO date (YYYY-MM-DD), got "${update.effectiveFrom}"`);
  }
  if (update.effectiveFrom < current.effectiveFrom) {
    throw new Error(
      `capital-config: effectiveFrom ${update.effectiveFrom} is before the current live set (${current.effectiveFrom}) — backdating is refused`,
    );
  }

  // Merge update over the current ratified set.
  const next: CapitalConfigRow = {
    version: current.version + 1,
    effectiveFrom: update.effectiveFrom,
    dscrFloor: update.dscrFloor ?? current.dscrFloor,
    ltvCeiling: update.ltvCeiling ?? current.ltvCeiling,
    dispositionCapRate: update.dispositionCapRate ?? current.dispositionCapRate,
    holdCapRate: update.holdCapRate ?? current.holdCapRate,
    acqIrr: update.acqIrr ?? current.acqIrr,
    capexIrr: update.capexIrr ?? current.capexIrr,
    refiTriggerBps: update.refiTriggerBps ?? current.refiTriggerBps,
    payoutPct: update.payoutPct ?? current.payoutPct,
    notes: update.notes ?? null,
    // Hurdle rate fields carry through from current — governed separately via ratification path.
    hurdleRatePct: current.hurdleRatePct,
    hurdleRateRatification: current.hurdleRateRatification,
    hurdleRateRatifiedBy: current.hurdleRateRatifiedBy,
    hurdleRateRatifiedDate: current.hurdleRateRatifiedDate,
  };

  // (2) HARD INVARIANTS (CLAUDE.md §4) — never write a breaching set.
  if (next.dscrFloor < 1.25) {
    throw new Error(`capital-config: DSCR floor ${next.dscrFloor} below hard invariant 1.25 — refused`);
  }
  if (next.ltvCeiling > 0.40) {
    throw new Error(`capital-config: LTV ceiling ${next.ltvCeiling} above hard invariant 0.40 — refused`);
  }

  // (2b) Sanity ceilings — catch a fat-finger before it silently locks out all acquisitions
  // (a DSCR floor of, say, 999 would reject every deal) or sets an absurd refi trigger. These
  // are conservative-direction values that pass the hard invariants but cannot be real intent.
  if (next.dscrFloor > 3) {
    throw new Error(`capital-config: DSCR floor ${next.dscrFloor} exceeds sane ceiling 3.0 — likely a fat-finger`);
  }
  if (next.refiTriggerBps > 1000) {
    throw new Error(`capital-config: refiTriggerBps ${next.refiTriggerBps} exceeds sane ceiling 1000 — likely a fat-finger`);
  }

  // (3) Unit-interval range on every rate/pct (DSCR floor excepted — it legitimately exceeds 1).
  const inUnit = (x: number) => x >= 0 && x <= 1;
  if (!inUnit(next.payoutPct)) throw new Error(`capital-config: payoutPct ${next.payoutPct} out of [0,1]`);
  if (![next.ltvCeiling, next.dispositionCapRate, next.holdCapRate, next.acqIrr, next.capexIrr].every(inUnit)) {
    throw new Error('capital-config: cap rates, IRR hurdles, and LTV must be within [0,1]');
  }

  // (4) Governor-set ordering: dispose below hold; return hurdles above the in-place cap rates.
  if (!(next.dispositionCapRate < next.holdCapRate &&
        next.holdCapRate < next.acqIrr &&
        next.acqIrr < next.capexIrr)) {
    throw new Error(
      'capital-config: governor set must satisfy disposition < hold < acqIrr < capexIrr ordering — refused',
    );
  }

  // (5) No-op guard — do not pollute version history when nothing actually changed.
  const changed = NUMERIC_KEYS.filter((k) => next[k] !== current[k]);
  if (changed.length === 0) {
    throw new Error('capital-config: no parameters changed — nothing to write');
  }

  // (6) Atomic: new version row + one calibration_log entry per changed parameter, or nothing.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling,
          disposition_cap_rate, hold_cap_rate, acq_irr, capex_irr,
          refi_trigger_bps, payout_pct, notes,
          hurdle_rate_pct, hurdle_rate_ratification,
          hurdle_rate_ratified_by, hurdle_rate_ratified_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      next.version, next.effectiveFrom, next.dscrFloor, next.ltvCeiling,
      next.dispositionCapRate, next.holdCapRate, next.acqIrr, next.capexIrr,
      next.refiTriggerBps, next.payoutPct, next.notes,
      next.hurdleRatePct, next.hurdleRateRatification,
      next.hurdleRateRatifiedBy, next.hurdleRateRatifiedDate,
    );
    for (const k of changed) {
      appendCalibrationLog(db, {
        configTable: 'capital_config',
        paramKey: k,
        oldValue: current[k],
        newValue: next[k],
        rationale: meta.rationale,
        sessionId: meta.sessionId,
      });
    }
  })();

  return loadCapitalConfig(db);
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
