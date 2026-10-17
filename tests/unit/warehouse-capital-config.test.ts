// tests/unit/warehouse-capital-config.test.ts
//
// PFI Phase 1 — Capital governance constants and calibration log.
// Pins: DSCR/LTV hard invariants, DB load round-trip, calibration-log append.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { GOVERNOR_FALLBACK, RATIFIED_GOVERNORS } from '@contracts/index';
import {
  CAPITAL_CONFIG,
  CapitalConfigMissingError,
  appendCalibrationLog,
  loadCapitalConfig,
  writeCapitalConfig,
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

describe('writeCapitalConfig — governed mutation (hard-invariant enforcement + audit trail)', () => {
  it('writes a new version row merging the update over the current config', () => {
    const db = freshDb(); // seeded version 1
    const next = writeCapitalConfig(
      db,
      { payoutPct: 0.10, effectiveFrom: '2026-12-01', notes: 'Distribution approved' },
      { rationale: '10% payout ratified', sessionId: 's1' },
    );
    expect(next.version).toBe(2);
    expect(next.payoutPct).toBe(0.10);
    // Unchanged params carry forward from version 1.
    expect(next.dscrFloor).toBe(1.25);
    expect(next.acqIrr).toBe(CAPITAL_CONFIG.acqIrr);
    // loadCapitalConfig now returns the new version.
    expect(loadCapitalConfig(db).version).toBe(2);
  });

  it('logs a calibration entry for EACH changed parameter, none for unchanged', () => {
    const db = freshDb();
    writeCapitalConfig(
      db,
      { payoutPct: 0.10, refiTriggerBps: 175, effectiveFrom: '2026-12-01' },
      { rationale: 'two-param change', sessionId: 's1' },
    );
    const logs = db
      .prepare('SELECT param_key, old_value, new_value FROM calibration_log ORDER BY param_key')
      .all() as Array<{ param_key: string; old_value: string; new_value: string }>;
    expect(logs.map((l) => l.param_key)).toEqual(['payoutPct', 'refiTriggerBps']);
    const payout = logs.find((l) => l.param_key === 'payoutPct')!;
    expect(JSON.parse(payout.old_value)).toBe(0.0);
    expect(JSON.parse(payout.new_value)).toBe(0.10);
  });

  it('REFUSES (throws) to write a DSCR floor below the 1.25 hard invariant', () => {
    const db = freshDb();
    expect(() =>
      writeCapitalConfig(db, { dscrFloor: 1.20, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow(/dscr|1\.25|invariant/i);
    // No new version, no log entry written on rejection.
    expect(loadCapitalConfig(db).version).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM calibration_log').get() as { n: number }).n).toBe(0);
  });

  it('REFUSES (throws) to write an LTV ceiling above the 0.40 hard invariant', () => {
    const db = freshDb();
    expect(() =>
      writeCapitalConfig(db, { ltvCeiling: 0.45, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow(/ltv|0\.40|invariant/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES (throws) an LTV ceiling of 0 — it would make the acquisition DSCR proxy Infinity and clear every deal', () => {
    const db = freshDb();
    expect(() => writeCapitalConfig(db, { ltvCeiling: 0, effectiveFrom: '2026-12-01' }, {})).toThrow(/> 0/);
    expect(() => writeCapitalConfig(db, { ltvCeiling: -0.1, effectiveFrom: '2026-12-01' }, {})).toThrow();
  });

  it('CAPITAL_CONFIG and GOVERNOR_FALLBACK both derive from RATIFIED_GOVERNORS (single source, no literal copies)', () => {
    expect(CAPITAL_CONFIG.dscrFloor).toBe(RATIFIED_GOVERNORS.dscrFloor);
    expect(CAPITAL_CONFIG.ltvCeiling).toBe(RATIFIED_GOVERNORS.ltvCeiling);
    expect(GOVERNOR_FALLBACK.dscrFloor).toBe(RATIFIED_GOVERNORS.dscrFloor);
    expect(GOVERNOR_FALLBACK.ltvCeiling).toBe(RATIFIED_GOVERNORS.ltvCeiling);
    expect(GOVERNOR_FALLBACK.version).toBe(RATIFIED_GOVERNORS.version);
    expect(GOVERNOR_FALLBACK.effectiveFrom).toBe(RATIFIED_GOVERNORS.effectiveFrom);
  });

  it('ALLOWS tightening: DSCR floor 1.30 (higher than 1.25) and LTV 0.35 (lower than 0.40) are accepted', () => {
    const db = freshDb();
    const next = writeCapitalConfig(
      db,
      { dscrFloor: 1.30, ltvCeiling: 0.35, effectiveFrom: '2026-12-01' },
      {},
    );
    expect(next.dscrFloor).toBe(1.30);
    expect(next.ltvCeiling).toBe(0.35);
  });

  it('REFUSES a non-finite numeric value (NaN must not slip past the < / > guards)', () => {
    const db = freshDb();
    expect(() =>
      writeCapitalConfig(db, { dscrFloor: NaN, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow();
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES a governor set that violates the disposition<hold<acqIrr<capexIrr ordering', () => {
    const db = freshDb();
    // hold below disposition — inverted ordering.
    expect(() =>
      writeCapitalConfig(db, { holdCapRate: 0.05, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow(/order|disposition|hold|consistent/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES a no-op write (no parameters actually changed) — does not pollute version history', () => {
    const db = freshDb();
    expect(() =>
      writeCapitalConfig(db, { payoutPct: 0.0, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow(/no change|unchanged|nothing/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES payoutPct outside [0,1]', () => {
    const db = freshDb();
    expect(() => writeCapitalConfig(db, { payoutPct: 1.5, effectiveFrom: '2026-12-01' }, {})).toThrow();
    expect(() => writeCapitalConfig(db, { payoutPct: -0.1, effectiveFrom: '2026-12-01' }, {})).toThrow();
  });

  it('is atomic: a rejected write leaves neither a version row nor a partial calibration log', () => {
    const db = freshDb();
    // refiTriggerBps valid but dscrFloor invalid — the whole write must roll back.
    expect(() =>
      writeCapitalConfig(db, { refiTriggerBps: 200, dscrFloor: 1.0, effectiveFrom: '2026-12-01' }, {}),
    ).toThrow();
    expect(loadCapitalConfig(db).version).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM calibration_log').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM capital_config').get() as { n: number }).n).toBe(1);
  });

  // Adversarial round-3 findings: effectiveFrom is the audit-trail anchor and must be a real,
  // non-backdated ISO date; the governors need fat-finger sanity ceilings.
  it('REFUSES an empty or non-ISO effectiveFrom (audit-trail anchor must be a real date)', () => {
    const db = freshDb();
    expect(() => writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: '' }, {})).toThrow(/effectiveFrom|ISO date/i);
    expect(() => writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: 'not-a-date' }, {})).toThrow(/effectiveFrom|ISO date/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES a calendar-overflow effectiveFrom that the regex passes but no calendar has (2026-02-30)', () => {
    const db = freshDb();
    // JS Date silently rolls '2026-02-30' to Mar 2; the round-trip guard must reject it so a
    // non-existent date never enters the governance audit trail. A real leap day is still accepted.
    expect(() => writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: '2026-02-30' }, {})).toThrow(/effectiveFrom|real ISO date/i);
    expect(() => writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: '2025-02-29' }, {})).toThrow(/effectiveFrom|real ISO date/i);
    expect(loadCapitalConfig(db).version).toBe(1);
    // Sanity: a genuine leap day (2028 is a leap year) is accepted.
    const ok = writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: '2028-02-29' }, {});
    expect(ok.version).toBe(2);
  });

  it('REFUSES a backdated effectiveFrom earlier than the current live set (timeline integrity)', () => {
    const db = freshDb(); // seed version 1 effectiveFrom '2026-06-13'
    expect(() =>
      writeCapitalConfig(db, { payoutPct: 0.1, effectiveFrom: '2026-01-01' }, {}),
    ).toThrow(/backdat|before the current/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES a fat-finger DSCR floor above the sane ceiling (would lock out all acquisitions)', () => {
    const db = freshDb();
    expect(() => writeCapitalConfig(db, { dscrFloor: 999, effectiveFrom: '2026-12-01' }, {})).toThrow(/ceiling|fat-finger/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });

  it('REFUSES a fat-finger refiTriggerBps above the sane ceiling', () => {
    const db = freshDb();
    expect(() => writeCapitalConfig(db, { refiTriggerBps: 1_000_000, effectiveFrom: '2026-12-01' }, {})).toThrow(/ceiling|fat-finger/i);
    expect(loadCapitalConfig(db).version).toBe(1);
  });
});


// Audit 2026-10-13 G6 — owner decision: an EMPTY capital_config table FAILS CLOSED. It must never
// silently fall back to the compile-time defaults (the old comment even called that path
// "fail-closed" while describing hurdle fields as 'proposed, 0.08' that are in fact 'ratified').
describe('loadCapitalConfig — empty capital_config table fails closed (audit 2026-10-13 G6)', () => {
  it('throws CapitalConfigMissingError instead of returning compile-time defaults', () => {
    const db = freshDb();
    db.prepare('DELETE FROM capital_config').run();
    expect(() => loadCapitalConfig(db)).toThrow(CapitalConfigMissingError);
    expect(() => loadCapitalConfig(db)).toThrow(/capital_config is empty/);
  });

  it('writeCapitalConfig refuses to mint a version on an empty table (no row written)', () => {
    const db = freshDb();
    db.prepare('DELETE FROM capital_config').run();
    expect(() => writeCapitalConfig(db, { dscrFloor: 1.30, effectiveFrom: '2026-10-13' }, {})).toThrow(CapitalConfigMissingError);
    expect((db.prepare('SELECT COUNT(*) AS n FROM capital_config').get() as { n: number }).n).toBe(0);
  });
});
