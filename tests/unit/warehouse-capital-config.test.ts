// tests/unit/warehouse-capital-config.test.ts
//
// PFI Phase 1 — Capital governance constants and calibration log.
// Pins: DSCR/LTV hard invariants, DB load round-trip, calibration-log append.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import {
  CAPITAL_CONFIG,
  appendCalibrationLog,
  loadCapitalConfig,
} from '../../server/warehouse/capital-config';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wh-cap-'));
  return openWarehouse(join(dir, 'f.sqlite'));
}

describe('CAPITAL_CONFIG compile-time constants — hard-invariant pin', () => {
  it('DSCR floor is exactly 1.25 (CLAUDE.md §4 hard invariant)', () => {
    expect(CAPITAL_CONFIG.dscrFloor).toBe(1.25);
  });

  it('LTV ceiling is exactly 0.40 (CLAUDE.md §4 hard invariant)', () => {
    expect(CAPITAL_CONFIG.ltvCeiling).toBe(0.40);
  });

  it('governor set is internally consistent (disposition < hold < acquisition hurdle)', () => {
    expect(CAPITAL_CONFIG.dispositionCapRate).toBeLessThan(CAPITAL_CONFIG.holdCapRate);
    expect(CAPITAL_CONFIG.holdCapRate).toBeLessThan(CAPITAL_CONFIG.acqIrr);
    expect(CAPITAL_CONFIG.acqIrr).toBeLessThan(CAPITAL_CONFIG.capexIrr);
  });

  it('payout is 0.0 — full reinvest (Gabriel-ratified 2026-06-13)', () => {
    expect(CAPITAL_CONFIG.payoutPct).toBe(0.0);
  });

  it('refi trigger is 150 bps', () => {
    expect(CAPITAL_CONFIG.refiTriggerBps).toBe(150);
  });
});

describe('loadCapitalConfig — DB round-trip via migration seed', () => {
  it('reads the version-1 seed row and matches the compile-time CAPITAL_CONFIG', () => {
    const db = freshDb(); // openWarehouse runs migrations, seeding version 1
    const cfg = loadCapitalConfig(db);
    expect(cfg.version).toBe(1);
    expect(cfg.effectiveFrom).toBe('2026-06-13');
    expect(cfg.dscrFloor).toBe(CAPITAL_CONFIG.dscrFloor);
    expect(cfg.ltvCeiling).toBe(CAPITAL_CONFIG.ltvCeiling);
    expect(cfg.dispositionCapRate).toBe(CAPITAL_CONFIG.dispositionCapRate);
    expect(cfg.holdCapRate).toBe(CAPITAL_CONFIG.holdCapRate);
    expect(cfg.acqIrr).toBe(CAPITAL_CONFIG.acqIrr);
    expect(cfg.capexIrr).toBe(CAPITAL_CONFIG.capexIrr);
    expect(cfg.refiTriggerBps).toBe(CAPITAL_CONFIG.refiTriggerBps);
    expect(cfg.payoutPct).toBe(CAPITAL_CONFIG.payoutPct);
  });

  it('returns the highest-version row when multiple versions exist', () => {
    const db = freshDb();
    // Insert a version-2 override (simulating a future re-ratification).
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling,
          disposition_cap_rate, hold_cap_rate, acq_irr, capex_irr,
          refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-12-01', 1.25, 0.40, 0.07, 0.08, 0.13, 0.16, 150, 0.0,
               'Hypothetical v2 for test')`,
    ).run();
    const cfg = loadCapitalConfig(db);
    expect(cfg.version).toBe(2);
    expect(cfg.dispositionCapRate).toBe(0.07); // the v2 value
  });
});

describe('appendCalibrationLog — audit trail', () => {
  it('writes a log entry readable from the DB', () => {
    const db = freshDb();
    appendCalibrationLog(db, {
      configTable: 'capital_config',
      paramKey: 'payout_pct',
      oldValue: 0.0,
      newValue: 0.1,
      rationale: 'Test: 10% distribution approved',
      sessionId: 'test-session-001',
    });

    const rows = db
      .prepare('SELECT * FROM calibration_log ORDER BY id DESC LIMIT 1')
      .all() as Array<{
        config_table: string;
        param_key: string;
        old_value: string;
        new_value: string;
        rationale: string;
        session_id: string;
      }>;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.config_table).toBe('capital_config');
    expect(r.param_key).toBe('payout_pct');
    expect(JSON.parse(r.old_value)).toBe(0.0);
    expect(JSON.parse(r.new_value)).toBe(0.1);
    expect(r.rationale).toBe('Test: 10% distribution approved');
    expect(r.session_id).toBe('test-session-001');
  });

  it('accepts null old_value for first-set entries', () => {
    const db = freshDb();
    appendCalibrationLog(db, {
      configTable: 'intel_config',
      paramKey: 'healthWeights.noiGrowth',
      oldValue: undefined,
      newValue: 0.20,
    });
    const row = db
      .prepare('SELECT old_value FROM calibration_log LIMIT 1')
      .get() as { old_value: string | null };
    expect(row.old_value).toBeNull();
  });

  it('multiple entries accumulate in order (append-only)', () => {
    const db = freshDb();
    appendCalibrationLog(db, { configTable: 'capital_config', paramKey: 'payout_pct', oldValue: 0.0, newValue: 0.05 });
    appendCalibrationLog(db, { configTable: 'capital_config', paramKey: 'payout_pct', oldValue: 0.05, newValue: 0.10 });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM calibration_log').get() as { n: number }).n;
    expect(count).toBe(2);
  });
});
