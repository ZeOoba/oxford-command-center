// tests/unit/calibration-refit.test.ts
// The OFFLINE re-fit (scripts/calibration-refit.ts) — spec §4.3. It reads resolved outcomes and
// PROPOSES recalibrated health weights as a REPORT ONLY. The load-bearing guarantees this file pins:
//   • It NEVER writes intel-config.ts (or ANY governor file). The proposal is advisory; only Gabriel,
//     in a separate hook-gated edit, may change weights. This is the single most important property.
//   • The proposal obeys the anti-overfit constraints: weights sum to 1.0 (±tiny FP), and NO single
//     weight moves more than ±0.05 from the current ratified value (the calibration-process governor).
//   • DSCR 1.25 / LTV 0.40 governors are OUT OF SCOPE — the refit's surface is healthWeights only and
//     it never emits or touches a DSCR/LTV value.
//   • Empty / insufficient data → it returns the CURRENT weights unchanged with an explicit caveat,
//     never a degenerate all-zero or NaN proposal.
import { readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { proposeRefit, MAX_WEIGHT_MOVE } from '../../scripts/calibration-refit';
import { computeInputsVersion, logVerdicts, resolveManualOutcome } from '../../server/warehouse/calibration';
import { INTEL_CONFIG } from '../../server/warehouse/intel-config';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import type { CalibrationVerdict } from '../../src/contracts/warehouse';

const SEED = [{ account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' }];
const INTEL_CONFIG_PATH = resolve(__dirname, '../../server/warehouse/intel-config.ts');

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cal-refit-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  return db;
}

/** Log a verdict and immediately resolve it manually with a given hit, returning its id. */
function logAndResolve(db: WarehouseDb, over: Partial<CalibrationVerdict>, hit: 0 | 1): void {
  const iv = computeInputsVersion(db);
  const verdict: CalibrationVerdict = {
    subjectKind: 'property', subjectId: `p-${Math.random().toString(36).slice(2, 8)}`,
    verdictKind: 'capital-action', verdictSubkind: '', verdictEngine: 'scores',
    predictedBand: 'disposition-candidate', predictedValue: null, predictedUnit: 'band',
    confidence: 0.7, direction: 'down', reasons: [], asOfPeriod: '2024', horizonPeriods: 1,
    inputsVersion: iv.inputsVersion, emittedBy: 'snapshot:test', ...over,
  };
  logVerdicts(db, [verdict]);
  const id = (db.prepare('SELECT id FROM calibration_verdict ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const r = resolveManualOutcome(db, {
    calibrationId: id, realizedBand: hit ? 'noi-flat-or-declined' : 'noi-grew',
    realizedValue: hit ? -0.03 : 0.04, realizedUnit: 'pct-change', outcomePeriod: '2025',
    hit, actionTaken: 'none', actionDetail: null, treatmentNote: null,
    resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
  });
  expect(r.ok).toBe(true);
}

describe('calibration-refit — NEVER writes governors (the load-bearing guard)', () => {
  it('proposeRefit has ZERO filesystem side effects: intel-config.ts is byte-identical after a run', () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) logAndResolve(db, {}, i % 2 === 0 ? 1 : 0);

    const before = readFileSync(INTEL_CONFIG_PATH, 'utf8');
    const mtimeBefore = statSync(INTEL_CONFIG_PATH).mtimeMs;

    const proposal = proposeRefit(db);

    const after = readFileSync(INTEL_CONFIG_PATH, 'utf8');
    expect(after).toBe(before);                       // content untouched
    expect(statSync(INTEL_CONFIG_PATH).mtimeMs).toBe(mtimeBefore); // not even re-touched
    // The proposal is a plain advisory object — no DSCR/LTV anywhere in its surface.
    const json = JSON.stringify(proposal);
    expect(json).not.toMatch(/dscr/i);
    expect(json).not.toMatch(/ltv/i);
  });
});

describe('calibration-refit — anti-overfit constraints (§4.3)', () => {
  it('proposed weights sum to 1.0 and no single weight moves more than ±0.05 from current', () => {
    const db = freshDb();
    // Skew the evidence so the optimizer WANTS to move a weight hard — the cap must clamp it.
    for (let i = 0; i < 20; i++) logAndResolve(db, {}, 1);

    const { proposedWeights } = proposeRefit(db);
    const sum = Object.values(proposedWeights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);

    for (const [k, v] of Object.entries(proposedWeights)) {
      const current = (INTEL_CONFIG.healthWeights as Record<string, number>)[k] ?? 0;
      expect(Math.abs(v - current)).toBeLessThanOrEqual(MAX_WEIGHT_MOVE + 1e-9);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('calibration-refit — insufficient data is a safe no-op', () => {
  it('on an empty warehouse it returns the CURRENT weights unchanged with an explicit caveat', () => {
    const db = freshDb();
    const proposal = proposeRefit(db);
    expect(proposal.proposedWeights).toEqual(INTEL_CONFIG.healthWeights);
    expect(proposal.sufficientData).toBe(false);
    expect(proposal.note).toMatch(/insufficient|accumulat|no resolved/i);
  });
});
