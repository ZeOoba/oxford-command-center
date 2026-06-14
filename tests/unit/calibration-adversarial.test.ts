// tests/unit/calibration-adversarial.test.ts
// ADVERSARIAL REFUTE pass for the Phase-2 UI/ops layer. Each test tries to BREAK an invariant the
// rest of the suite asserts holds — the financial-code refute discipline. What survives is documented
// in the PR.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { computeInputsVersion, logVerdicts, resolveManualOutcome, type ResolveManualResult } from '../../server/warehouse/calibration';
import { isForbiddenOutPath, MAX_WEIGHT_MOVE } from '../../scripts/calibration-refit';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import type { CalibrationVerdict } from '../../src/contracts/warehouse';

const SEED = [{ account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' }];

function db(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cal-adv-'));
  const d = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(d);
  seedMappings(d, SEED);
  return d;
}
function seedVerdict(d: WarehouseDb, asOfPeriod: string, subjectId = 'p1'): number {
  const iv = computeInputsVersion(d);
  const v: CalibrationVerdict = {
    subjectKind: 'property', subjectId, verdictKind: 'capital-action', verdictSubkind: '',
    verdictEngine: 'scores', predictedBand: 'disposition-candidate', predictedValue: null, predictedUnit: 'band',
    confidence: 0.7, direction: 'down', reasons: [], asOfPeriod, horizonPeriods: 1,
    inputsVersion: iv.inputsVersion, emittedBy: 'snapshot:test',
  };
  logVerdicts(d, [v]);
  return (d.prepare('SELECT id FROM calibration_verdict WHERE subject_id = ? ORDER BY id DESC LIMIT 1').get(subjectId) as { id: number }).id;
}
function ok(r: ResolveManualResult): Extract<ResolveManualResult, { ok: true }> {
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('REFUTE: can a resolve create TWO blessed rows for one verdict?', () => {
  it('rapid distinct resolutions still leave EXACTLY one blessed row (partial unique index holds)', () => {
    const d = db();
    const id = seedVerdict(d, '2024');
    for (let i = 0; i < 5; i++) {
      ok(resolveManualOutcome(d, {
        calibrationId: id, realizedBand: `b${i}`, realizedValue: i / 100, realizedUnit: 'pct-change',
        outcomePeriod: '2025', hit: (i % 2) as 0 | 1, actionTaken: 'none', actionDetail: null,
        treatmentNote: null, resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
      }));
    }
    const blessed = (d.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(id) as { c: number }).c;
    expect(blessed).toBe(1);
    // All five attempts are preserved (append-only): 1 blessed + 4 superseded.
    const total = (d.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ?').get(id) as { c: number }).c;
    expect(total).toBe(5);
  });
});

describe('REFUTE: can the GRAIN rule be bypassed in EITHER direction?', () => {
  it('YTD verdict + full-year outcome is ALSO rejected (reverse-grain), not just full-year + YTD', () => {
    const d = db();
    const id = seedVerdict(d, '2024-06'); // YTD verdict
    const r = resolveManualOutcome(d, {
      calibrationId: id, realizedBand: 'x', realizedValue: -0.1, realizedUnit: 'pct-change',
      outcomePeriod: '2025', // full-year outcome — different grain
      hit: 1, actionTaken: 'none', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/grain/i);
  });

  it('a same-grain month outcome that is EARLIER than the verdict is rejected (not strictly later)', () => {
    const d = db();
    const id = seedVerdict(d, '2024-06');
    const r = resolveManualOutcome(d, {
      calibrationId: id, realizedBand: 'x', realizedValue: -0.1, realizedUnit: 'pct-change',
      outcomePeriod: '2024-03', // earlier same-grain
      hit: 1, actionTaken: 'none', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/later/i);
  });
});

describe('REFUTE: can a spoofed body calibrationId mismatch the path id?', () => {
  it('the PATH id wins — a body calibrationId pointing elsewhere cannot redirect the write', async () => {
    const d = db();
    const idA = seedVerdict(d, '2024', 'pA');
    const idB = seedVerdict(d, '2024', 'pB');
    const app = warehouseRoutes(() => d);
    // POST to A's path but try to smuggle B's id in the body.
    const res = await app.request(`/calibration/${idA}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calibrationId: idB, realizedBand: 'x', realizedValue: -0.04, realizedUnit: 'pct-change', outcomePeriod: '2025', hit: 1, actionTaken: 'none' }),
    });
    expect(res.status).toBe(200);
    // The outcome attached to A, NOT B.
    const aResolved = (d.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(idA) as { c: number }).c;
    const bResolved = (d.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(idB) as { c: number }).c;
    expect(aResolved).toBe(1);
    expect(bResolved).toBe(0);
  });
});

describe('REFUTE: can the refit be tricked into writing a governor / config file?', () => {
  it('isForbiddenOutPath blocks intel-config / config / governor / overlay / env-looking targets', () => {
    for (const p of [
      'server/warehouse/intel-config.ts', 'intel-config.ts', './data/overlay.json',
      'config.json', 'some/governor.ts', '.env', 'settings.json', 'INTEL_CONFIG.ts',
    ]) {
      expect(isForbiddenOutPath(p)).toBe(true);
    }
  });
  it('a plain report path is allowed', () => {
    expect(isForbiddenOutPath('outputs/2026-q3-calibration-refit-report.txt')).toBe(false);
    expect(isForbiddenOutPath('refit-proposal.json')).toBe(false);
  });
  it('MAX_WEIGHT_MOVE is the spec ±0.05 calibration-process governor', () => {
    expect(MAX_WEIGHT_MOVE).toBe(0.05);
  });
});
