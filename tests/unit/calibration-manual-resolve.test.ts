// tests/unit/calibration-manual-resolve.test.ts
// Phase 2 UI/ops: the MANUAL resolution write path (resolveManualOutcome) behind
// POST /calibration/:id/resolve. Spec §3.2.
//
// Discipline this file pins down (the adversarial surface):
//   • Append-only — a verdict row is NEVER mutated; resolution is a calibration_outcome insert.
//   • Supersede — blessing/overriding flips the prior is_resolution=1 row to 0 and inserts a new
//     is_resolution=1 row IN ONE TRANSACTION; the partial unique index never throws.
//   • Idempotent — a byte-identical re-submit is a no-op (no duplicate, no second supersede).
//   • Double-resolution / already-resolved verdict — cannot crash, cannot create two blessed rows.
//   • Grain rule — a full-year verdict CANNOT be resolved against a YTD (YYYY-MM) outcome period.
//   • Zod validation — empty body / no-judgment body / nonexistent verdict are rejected cleanly.
//
// DB-backed via tmpdir sqlite, synthetic data only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeInputsVersion,
  logVerdicts,
  resolveManualOutcome,
  type ResolveManualResult,
} from '../../server/warehouse/calibration';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import type { CalibrationVerdict } from '../../src/contracts/warehouse';

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
];

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cal-manres-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  return db;
}

/** Log one capital-action verdict and return its calibration_verdict.id. */
function seedVerdict(db: WarehouseDb, over: Partial<CalibrationVerdict> = {}): number {
  const iv = computeInputsVersion(db);
  const verdict: CalibrationVerdict = {
    subjectKind: 'property',
    subjectId: '1100-rarig',
    verdictKind: 'capital-action',
    verdictSubkind: '',
    verdictEngine: 'scores',
    predictedBand: 'disposition-candidate',
    predictedValue: null,
    predictedUnit: 'band',
    confidence: 0.7,
    direction: 'down',
    reasons: ['low NOI margin'],
    asOfPeriod: '2024',
    horizonPeriods: 1,
    inputsVersion: iv.inputsVersion,
    emittedBy: 'snapshot:test',
    ...over,
  };
  const r = logVerdicts(db, [verdict]);
  expect(r.written).toBe(1);
  const row = db.prepare('SELECT id FROM calibration_verdict ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

/** Narrow a result to its success branch (throws on failure) so .superseded/.duplicate type-check. */
function ok(r: ResolveManualResult): Extract<ResolveManualResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
}

function blessedCount(db: WarehouseDb, id: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(id) as { c: number }).c;
}
function totalOutcomes(db: WarehouseDb, id: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome WHERE calibration_id = ?').get(id) as { c: number }).c;
}

describe('resolveManualOutcome — happy path (§3.2)', () => {
  it('records a blessed outcome for a pending verdict and never mutates the verdict row', () => {
    const db = freshDb();
    const id = seedVerdict(db);
    const verdictBefore = db.prepare('SELECT * FROM calibration_verdict WHERE id = ?').get(id);

    const res = ok(resolveManualOutcome(db, {
      calibrationId: id,
      realizedBand: 'noi-flat-or-declined',
      realizedValue: -0.04,
      realizedUnit: 'pct-change',
      outcomePeriod: '2025',
      hit: 1,
      actionTaken: 'none',
      actionDetail: null,
      treatmentNote: 'left alone — clean test',
      resolutionBasis: 'analyst-judgment',
      resolvedBy: 'manual:gabriel',
    }));

    expect(res.ok).toBe(true);
    expect(res.superseded).toBe(false);
    expect(res.duplicate).toBe(false);
    expect(blessedCount(db, id)).toBe(1);

    // APPEND-ONLY: the verdict row is byte-identical (never UPDATEd).
    const verdictAfter = db.prepare('SELECT * FROM calibration_verdict WHERE id = ?').get(id);
    expect(verdictAfter).toEqual(verdictBefore);
  });
});

describe('resolveManualOutcome — supersede / override (append-only, §3.2)', () => {
  it('blessing a SECOND outcome flips the prior is_resolution=1 to 0 and preserves it (one blessed at a time)', () => {
    const db = freshDb();
    const id = seedVerdict(db);

    resolveManualOutcome(db, {
      calibrationId: id, realizedBand: 'noi-grew', realizedValue: 0.03, realizedUnit: 'pct-change',
      outcomePeriod: '2025', hit: 0, actionTaken: 'unknown', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    const res2 = ok(resolveManualOutcome(db, {
      calibrationId: id, realizedBand: 'noi-flat-or-declined', realizedValue: -0.02, realizedUnit: 'pct-change',
      outcomePeriod: '2025', hit: 1, actionTaken: 'acted-aligned', actionDetail: 're-leased anchor',
      treatmentNote: 'verdict was right; we intervened', resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    }));

    expect(res2.ok).toBe(true);
    expect(res2.superseded).toBe(true);
    expect(res2.duplicate).toBe(false);
    // EXACTLY one blessed; the superseded row is preserved (append-only — total = 2).
    expect(blessedCount(db, id)).toBe(1);
    expect(totalOutcomes(db, id)).toBe(2);
    // The live blessed row is the second one.
    const live = db.prepare('SELECT realized_value, hit, action_taken FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(id) as { realized_value: number; hit: number; action_taken: string };
    expect(live.action_taken).toBe('acted-aligned');
    expect(live.hit).toBe(1);
  });

  it('can override an AUTO resolution (resolved_by auto:*) the same way — verdict still never mutated', () => {
    const db = freshDb();
    const id = seedVerdict(db);
    // Simulate a pre-existing AUTO resolution.
    db.prepare(`INSERT INTO calibration_outcome
      (calibration_id, realized_band, realized_value, realized_unit, outcome_period, horizon_actual,
       hit, abs_error, action_taken, resolved_by, resolution_basis, is_resolution)
      VALUES (?, 'noi-grew', 0.05, 'pct-change', '2025', 1, 0, NULL, 'unknown', 'auto:next-period', 'realized-noi-trend', 1)`).run(id);

    const res = ok(resolveManualOutcome(db, {
      calibrationId: id, realizedBand: 'noi-flat-or-declined', realizedValue: -0.01, realizedUnit: 'pct-change',
      outcomePeriod: '2025', hit: 1, actionTaken: 'none', actionDetail: null,
      treatmentNote: 'auto miss was contaminated; corrected', resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    }));
    expect(res.superseded).toBe(true);
    expect(blessedCount(db, id)).toBe(1);
    const live = db.prepare('SELECT resolved_by FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1').get(id) as { resolved_by: string };
    expect(live.resolved_by).toBe('manual:gabriel');
  });
});

describe('resolveManualOutcome — idempotency (no double-resolution)', () => {
  it('a BYTE-IDENTICAL re-submit is a no-op: no duplicate row, no second supersede', () => {
    const db = freshDb();
    const id = seedVerdict(db);
    const body = {
      calibrationId: id, realizedBand: 'noi-flat-or-declined', realizedValue: -0.04, realizedUnit: 'pct-change' as const,
      outcomePeriod: '2025', hit: 1 as const, actionTaken: 'none' as const, actionDetail: null, treatmentNote: 'clean',
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    };
    const r1 = ok(resolveManualOutcome(db, body));
    const r2 = ok(resolveManualOutcome(db, body));
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.superseded).toBe(false);
    // Idempotent: still exactly one outcome row total, still one blessed.
    expect(totalOutcomes(db, id)).toBe(1);
    expect(blessedCount(db, id)).toBe(1);
  });
});

describe('resolveManualOutcome — validation + grain guard (adversarial)', () => {
  it('rejects a body with NO realized signal (no band, no value, no hit)', () => {
    const db = freshDb();
    const id = seedVerdict(db);
    const res = resolveManualOutcome(db, {
      calibrationId: id, realizedBand: null, realizedValue: null, realizedUnit: null,
      outcomePeriod: '2025', hit: null, actionTaken: 'unknown', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/realized|judgment/i);
    expect(totalOutcomes(db, id)).toBe(0);
  });

  it('rejects resolving a NONEXISTENT verdict id (no orphan outcome row)', () => {
    const db = freshDb();
    const res = resolveManualOutcome(db, {
      calibrationId: 99999, realizedBand: 'x', realizedValue: null, realizedUnit: null,
      outcomePeriod: '2025', hit: 1, actionTaken: 'none', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found|no such/i);
    expect((db.prepare('SELECT COUNT(*) AS c FROM calibration_outcome').get() as { c: number }).c).toBe(0);
  });

  it('GRAIN RULE: a FULL-YEAR verdict cannot be resolved against a YTD (YYYY-MM) outcome period', () => {
    const db = freshDb();
    const id = seedVerdict(db, { asOfPeriod: '2024' }); // full-year verdict
    const res = resolveManualOutcome(db, {
      calibrationId: id, realizedBand: 'noi-flat-or-declined', realizedValue: -0.5, realizedUnit: 'pct-change',
      outcomePeriod: '2025-06', // YTD partial — the spurious ≈−50% trap
      hit: 1, actionTaken: 'none', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/grain|same-grain|full-year/i);
    expect(totalOutcomes(db, id)).toBe(0);
  });

  it('GRAIN RULE: the outcome period must be STRICTLY LATER than the verdict as_of period', () => {
    const db = freshDb();
    const id = seedVerdict(db, { asOfPeriod: '2024' });
    const res = resolveManualOutcome(db, {
      calibrationId: id, realizedBand: 'noi-grew', realizedValue: 0.02, realizedUnit: 'pct-change',
      outcomePeriod: '2024', // same period — not a future outcome
      hit: 1, actionTaken: 'none', actionDetail: null, treatmentNote: null,
      resolutionBasis: 'analyst-judgment', resolvedBy: 'manual:gabriel',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/later|future|after/i);
    expect(totalOutcomes(db, id)).toBe(0);
  });
});

describe('resolveManualOutcome — unexpected DB failure', () => {
  it('returns a generic error, never the raw SQLite message (table names)', () => {
    const db = freshDb();
    const id = seedVerdict(db);
    db.exec('DROP TABLE calibration_outcome'); // force the transaction to throw
    const res = resolveManualOutcome(db, {
      calibrationId: id,
      realizedBand: 'noi-flat-or-declined',
      realizedValue: -0.04,
      realizedUnit: 'pct-change',
      outcomePeriod: '2025',
      hit: 1,
      actionTaken: 'none',
      actionDetail: null,
      treatmentNote: 'x',
      resolutionBasis: 'analyst-judgment',
      resolvedBy: 'manual:gabriel',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/calibration_outcome|no such table/i);
      expect(res.error).not.toMatch(/not found/i); // must not be misrouted to the 404 branch
    }
  });
});
