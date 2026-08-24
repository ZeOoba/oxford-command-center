// tests/unit/brain-report.test.ts
//
// Lane L2d — Command Brain report engine + API.
//
// Covers: monthly accuracySeries grouping (the scoreableN<5 honesty gate — NOT resolvedN, which
// also counts hit=null "not-scoreable" rows — incl. the n===MIN_PAIRS boundary), recalibration
// math (DISTINCT config_hash − 1, not raw row count), trackRecord's hit/miss/not-scoreable
// mapping, coverage-based confidence-by-market/manager (unknown → skip), versionLog's
// deterministic single-basis ordering (sortVersionEvents), the empty-warehouse
// no-throw/no-fabrication guarantee, and the feedback POST→GET round trip.
//
// All tests use a fresh in-memory-equivalent SQLite warehouse (tmpdir) — never touches
// data/warehouse/finance.sqlite. calibration_verdict/outcome/inputs_version rows are seeded via
// direct SQL (not logVerdicts/resolveManualOutcome) because this suite needs exact control over
// resolved_at timestamps (to place resolutions in specific months) and over config_hash forking
// (to test recalibration counting) — both are outside what those higher-level helpers expose.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { buildBrainReport, sortVersionEvents } from '../../server/warehouse/brain-report';
import { brainApi } from '../../server/warehouse/brain-api';
import { calibrationReport } from '../../server/warehouse/calibration';
import { BrainReport, type VersionEvent } from '@contracts/brain-report';

// ── DB fixtures ──────────────────────────────────────────────────────────────────────────────

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'brain-report-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Seed one calibration_inputs_version row (the reproducibility key table). Distinct config_hash
 *  values are what drives the recalibrations count (COUNT(DISTINCT config_hash) − 1). */
function seedInputsVersion(db: WarehouseDb, inputsVersion: string, configHash: string): void {
  db.prepare(`
    INSERT INTO calibration_inputs_version (inputs_version, ledger_fingerprint, config_hash, code_version, config_json)
    VALUES (?, ?, ?, 'test', '{}')
  `).run(inputsVersion, `fingerprint-${inputsVersion}`, configHash);
}

let dedupCounter = 0;

/** Seed one calibration_verdict row directly (bypasses logVerdicts — full control, no dedup-key
 *  collision risk across many rows in one test). Returns the new row's id. */
function seedVerdict(
  db: WarehouseDb,
  opts: { subjectId: string; verdictKind: string; inputsVersion: string; asOfPeriod?: string },
): number {
  dedupCounter += 1;
  db.prepare(`
    INSERT INTO calibration_verdict
      (subject_kind, subject_id, verdict_kind, verdict_subkind, verdict_engine,
       predicted_band, predicted_value, predicted_unit, confidence, direction,
       reasons_json, as_of_period, horizon_periods, inputs_version, emitted_by, dedup_key)
    VALUES ('property', ?, ?, '', 'scores', 'test-band', null, 'band', 0.7, 'up', '[]', ?, 1, ?, 'test', ?)
  `).run(
    opts.subjectId,
    opts.verdictKind,
    opts.asOfPeriod ?? '2024',
    opts.inputsVersion,
    `dedup-${dedupCounter}`,
  );
  const row = db.prepare('SELECT id FROM calibration_verdict ORDER BY id DESC LIMIT 1').get() as { id: number };
  return row.id;
}

/** Seed one blessed (is_resolution=1) calibration_outcome row with an explicit resolved_at, so the
 *  test controls exactly which month each resolution buckets into. */
function seedOutcome(
  db: WarehouseDb,
  verdictId: number,
  opts: { hit: 1 | 0 | null; resolvedAt: string; outcomePeriod?: string },
): void {
  db.prepare(`
    INSERT INTO calibration_outcome
      (calibration_id, realized_band, realized_value, realized_unit, outcome_period, horizon_actual,
       hit, abs_error, action_taken, resolved_by, resolution_basis, is_resolution, resolved_at)
    VALUES (?, 'realized-band', null, 'band', ?, 1, ?, null, 'none', 'auto:test', 'test-basis', 1, ?)
  `).run(verdictId, opts.outcomePeriod ?? '2025', opts.hit, opts.resolvedAt);
}

/** Seed one resolved verdict+outcome pair in a single call — the common case in this suite. */
function seedResolved(
  db: WarehouseDb,
  opts: { subjectId: string; inputsVersion: string; hit: 1 | 0 | null; resolvedAt: string; verdictKind?: string },
): number {
  const id = seedVerdict(db, {
    subjectId: opts.subjectId,
    verdictKind: opts.verdictKind ?? 'capital-action',
    inputsVersion: opts.inputsVersion,
  });
  seedOutcome(db, id, { hit: opts.hit, resolvedAt: opts.resolvedAt });
  return id;
}

// ── buildBrainReport — accuracySeries + overall stats ───────────────────────────────────────

describe('buildBrainReport — accuracySeries (the resolvedN<5 honesty gate)', () => {
  it('groups resolutions by month; a month with 6 resolved (4 hits) gets hitRate ≈ 0.667', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    const janHits: Array<1 | 0> = [1, 1, 1, 1, 0, 0];
    janHits.forEach((hit, i) => {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit,
        resolvedAt: `2026-01-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const jan = report.accuracySeries.find((p) => p.month === '2026-01');
    expect(jan).toBeDefined();
    expect(jan!.resolvedN).toBe(6);
    expect(jan!.hitRate).not.toBeNull();
    expect(jan!.hitRate!).toBeCloseTo(4 / 6, 5);
  });

  it('a month with only 2 resolved gets hitRate=null (gap, not a misleading number) while resolvedN is still reported', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-02-05T00:00:00Z' });
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 0, resolvedAt: '2026-02-20T00:00:00Z' });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const feb = report.accuracySeries.find((p) => p.month === '2026-02');
    expect(feb).toBeDefined();
    expect(feb!.resolvedN).toBe(2);
    expect(feb!.hitRate).toBeNull();
  });

  it('a month with exactly MIN_PAIRS (5) resolved is NOT gated (n<5 is strict) — hitRate is a real number', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    for (let i = 0; i < 5; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: 1,
        resolvedAt: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const mar = report.accuracySeries.find((p) => p.month === '2026-03');
    expect(mar).toBeDefined();
    expect(mar!.resolvedN).toBe(5);
    expect(mar!.hitRate).toBe(1);
  });

  it('months with zero resolutions never appear in the series (gaps, not zero-filled rows)', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-01-10T00:00:00Z' });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.accuracySeries).toHaveLength(1);
    expect(report.accuracySeries.some((p) => p.month === '2026-02')).toBe(false);
  });
});

// ── FINDING 1 regression: gate on scoreableN (hit ∈ {0,1}), never resolvedN ─────────────────────
//
// The bug: hitRate was hits/resolvedN, where resolvedN counts EVERY is_resolution=1 row
// including hit=null ("not-scoreable" — e.g. every resolved 'hold' verdict). That both
// understates hitRate relative to calibrationReport.overallHitRate (which is hits/scoreable,
// scoreable excluding hit=null — calibration.ts:934,1014-1018,1069) AND applies the MIN_PAIRS
// honesty gate to the wrong count, so a month of mostly not-scoreable resolutions could publish
// a rate computed on a single real data point.
describe('buildBrainReport — accuracySeries FINDING 1 regression (scoreableN, not resolvedN, is the gate + denominator)', () => {
  it('4 not-scoreable (hit=null) + 1 scoreable resolution: resolvedN=5 (gate would pass under the old bug) but scoreableN=1 — hitRate stays null', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    for (let i = 0; i < 4; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: null,
        resolvedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    seedResolved(db, {
      subjectId: '1100-rarig-ave-columbus-oh',
      inputsVersion: 'iv-1',
      hit: 1,
      resolvedAt: '2026-08-20T00:00:00Z',
    });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const aug = report.accuracySeries.find((p) => p.month === '2026-08');
    expect(aug).toBeDefined();
    expect(aug!.resolvedN).toBe(5);
    expect(aug!.scoreableN).toBe(1);
    // Gated: scoreableN(1) < MIN_PAIRS(5) — even though resolvedN(5) alone would have passed
    // the old (buggy) gate.
    expect(aug!.hitRate).toBeNull();
  });

  it('4 not-scoreable + 4 scoreable (3 hits, 1 miss), scoreableN=4 < MIN_PAIRS: the old buggy resolvedN=8 gate would have published hitRate=3/8=0.375 — the fix instead honestly gaps it (null), never a misleading number', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    for (let i = 0; i < 4; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: null,
        resolvedAt: `2026-09-${String(1 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const scoreableHits: Array<1 | 0> = [1, 1, 1, 0];
    scoreableHits.forEach((hit, i) => {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit,
        resolvedAt: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const sep = report.accuracySeries.find((p) => p.month === '2026-09');
    expect(sep).toBeDefined();
    expect(sep!.resolvedN).toBe(8);
    expect(sep!.scoreableN).toBe(4);
    // Correctly gated on scoreableN(4) < MIN_PAIRS(5) — NOT the old bug's 3/8=0.375 (which
    // resolvedN=8 alone would have let through).
    expect(sep!.hitRate).toBeNull();
  });

  it('4 not-scoreable + 5 scoreable (4 hits, 1 miss), scoreableN=5 clears MIN_PAIRS: hitRate is 4/5=0.8, matching calibrationReport.overallHitRate over the same rows — NOT the old resolvedN-denominator value 4/9', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    for (let i = 0; i < 4; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: null,
        resolvedAt: `2026-09-${String(1 + i).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const scoreableHits: Array<1 | 0> = [1, 1, 1, 1, 0];
    scoreableHits.forEach((hit, i) => {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit,
        resolvedAt: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      });
    });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const sep = report.accuracySeries.find((p) => p.month === '2026-09');
    expect(sep).toBeDefined();
    expect(sep!.resolvedN).toBe(9);
    expect(sep!.scoreableN).toBe(5);
    expect(sep!.hitRate).toBeCloseTo(0.8, 10);
    // Guards directly against the old wrong-denominator regression (4 hits / 9 resolvedN).
    expect(sep!.hitRate).not.toBeCloseTo(4 / 9, 5);

    // This db has ONLY this month's rows, so calibrationReport's own (hits, scoreable) totals
    // are exactly this month's — the two numbers this report emits for "the accuracy rate" must
    // agree exactly, never diverge.
    const overall = calibrationReport(db);
    expect(overall.overallHitRate).toBeCloseTo(0.8, 10);
    expect(sep!.hitRate).toBe(overall.overallHitRate);
  });
});

// ── recalibrations ───────────────────────────────────────────────────────────────────────────

describe('buildBrainReport — recalibrations (DISTINCT config_hash − 1, floored at 0)', () => {
  it('3 distinct config_hash rows → 2 recalibrations', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    seedInputsVersion(db, 'iv-2', 'hash-2');
    seedInputsVersion(db, 'iv-3', 'hash-3');

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.recalibrations).toBe(2);
  });

  it('multiple inputs_version rows sharing ONE config_hash (import forking) do not inflate the count', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    seedInputsVersion(db, 'iv-2', 'hash-1'); // same hash, different fingerprint (a re-import)

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.recalibrations).toBe(0);
  });

  it('an empty calibration_inputs_version table floors recalibrations at 0 (never negative)', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.recalibrations).toBe(0);
  });
});

// ── trackRecord ──────────────────────────────────────────────────────────────────────────────

describe('buildBrainReport — trackRecord (hit=1→hit, hit=0→miss, hit=null→not-scoreable)', () => {
  it('maps every hit value to exactly the three defined outcomes, newest first', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-04-01T00:00:00Z' });
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 0, resolvedAt: '2026-04-02T00:00:00Z' });
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: null, resolvedAt: '2026-04-03T00:00:00Z' });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.trackRecord).toHaveLength(3);

    // Newest (resolvedAt DESC) first.
    expect(report.trackRecord[0]!.resolvedAt).toBe('2026-04-03T00:00:00Z');
    expect(report.trackRecord[0]!.outcome).toBe('not-scoreable');
    expect(report.trackRecord[1]!.outcome).toBe('miss');
    expect(report.trackRecord[2]!.outcome).toBe('hit');

    const outcomes = report.trackRecord.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['hit', 'miss', 'not-scoreable']);
    // No fourth state exists anywhere in the output.
    for (const r of report.trackRecord) {
      expect(['hit', 'miss', 'not-scoreable']).toContain(r.outcome);
    }
  });
});

// ── confidenceByMarket / confidenceByManager ────────────────────────────────────────────────

describe('buildBrainReport — coverage-based confidence cohorts', () => {
  it('groups resolved property verdicts by market/manager; sampleN and coverageConfidence follow the documented curve', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');

    // '1100 rarig' → market 'Columbus OH', manager 'Kohr Royer Griffith'.
    for (let i = 0; i < 3; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: 1,
        resolvedAt: `2026-05-0${i + 1}T00:00:00Z`,
      });
    }
    // '29000 information lane' → market 'Mid-Atlantic', manager 'Thomas Park'.
    seedResolved(db, { subjectId: '29000-information-lane-easton-md', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-05-04T00:00:00Z' });
    // A property_id NOT in property_master — must be skipped entirely (unknown → skip).
    seedResolved(db, { subjectId: 'unknown-property-xyz', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-05-05T00:00:00Z' });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');

    const columbus = report.confidenceByMarket.find((r) => r.key === 'Columbus OH');
    expect(columbus).toBeDefined();
    expect(columbus!.sampleN).toBe(3);
    expect(columbus!.coverageConfidence).toBeCloseTo(3 / 20, 5);
    expect(columbus!.basisNote).toBe('coverage-based, not predictive skill');

    const midAtlantic = report.confidenceByMarket.find((r) => r.key === 'Mid-Atlantic');
    expect(midAtlantic).toBeDefined();
    expect(midAtlantic!.sampleN).toBe(1);

    // sampleN across all buckets never includes the unresolvable subject.
    const totalMarketSample = report.confidenceByMarket.reduce((sum, r) => sum + r.sampleN, 0);
    expect(totalMarketSample).toBe(4);

    const krg = report.confidenceByManager.find((r) => r.key === 'Kohr Royer Griffith');
    expect(krg).toBeDefined();
    expect(krg!.sampleN).toBe(3);

    const thomasPark = report.confidenceByManager.find((r) => r.key === 'Thomas Park');
    expect(thomasPark).toBeDefined();
    expect(thomasPark!.sampleN).toBe(1);
  });

  it('coverageConfidence is capped at 0.95 even with a large sampleN', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    for (let i = 0; i < 25; i++) {
      seedResolved(db, {
        subjectId: '1100-rarig-ave-columbus-oh',
        inputsVersion: 'iv-1',
        hit: 1,
        resolvedAt: `2026-06-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const columbus = report.confidenceByMarket.find((r) => r.key === 'Columbus OH');
    expect(columbus!.sampleN).toBe(25);
    expect(columbus!.coverageConfidence).toBe(0.95);
  });
});

// ── openQuestions ────────────────────────────────────────────────────────────────────────────

describe('buildBrainReport — openQuestions (honest gap surfacing)', () => {
  it('surfaces open data-quality issues, all 4 dormant generator families, and floor-indeterminate acq scores', () => {
    const db = freshDb();
    seedPropertyMaster(db);

    db.prepare(`
      INSERT INTO data_quality_issues (kind, detail, severity, status)
      VALUES ('unmapped-account', 'Account 9999 has no mapping rule', 'warn', 'open')
    `).run();
    // A resolved issue must NOT appear.
    db.prepare(`
      INSERT INTO data_quality_issues (kind, detail, severity, status, resolved_at)
      VALUES ('unmapped-account', 'Account 1111 — already fixed', 'warn', 'resolved', datetime('now'))
    `).run();

    db.prepare(`
      INSERT INTO acq_candidates (id, source, address, county, state)
      VALUES ('parcel:test:1', 'manual', '123 Test St', 'Test County', 'OH')
    `).run();
    db.prepare(`
      INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json)
      VALUES ('parcel:test:1', 'test-inputs', '{}')
    `).run();
    const scoreInputId = (
      db.prepare('SELECT id FROM acq_score_inputs ORDER BY id DESC LIMIT 1').get() as { id: number }
    ).id;
    db.prepare(`
      INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json)
      VALUES ('parcel:test:1', ?, 'test-inputs', 50, 'T2', 'WATCH', 1, '{}')
    `).run(scoreInputId);

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');

    const dq = report.openQuestions.filter((q) => q.kind === 'data-quality');
    expect(dq).toHaveLength(1);
    expect(dq[0]!.detail).toBe('Account 9999 has no mapping rule');
    expect(dq[0]!.wouldClose).toBe('Account 9999 has no mapping rule');

    const dormant = report.openQuestions.filter((q) => q.kind === 'dormant-generator');
    expect(dormant).toHaveLength(4);
    const codes = dormant.map((d) => d.title.slice(0, 2)).sort();
    expect(codes).toEqual(['CR', 'DR', 'TE', 'TR']);
    for (const d of dormant) {
      expect(d.wouldClose).toBe('a generator + resolved outcomes for this family');
    }

    const floor = report.openQuestions.filter((q) => q.kind === 'floor-indeterminate');
    expect(floor).toHaveLength(1);
    expect(floor[0]!.wouldClose).toBe('the missing underwriting inputs');
    expect(floor[0]!.title).toContain('123 Test St');
  });

  it('dedupes floor-indeterminate to the LATEST row per candidate (refute finding: I1 re-key duplicated rows)', () => {
    // The I1 governor-fingerprint fix mints a new acq_scores row per governor regime, so a
    // candidate re-scored after a governor change (or the one-time post-deploy re-key) leaves an
    // older floor_indeterminate=1 row behind it. Without a per-candidate dedup, the SAME candidate
    // was double-listed — crowding out other candidates under OPEN_QUESTION_GROUP_CAP.
    const db = freshDb();
    seedPropertyMaster(db);

    db.prepare(`
      INSERT INTO acq_candidates (id, source, address, county, state)
      VALUES ('parcel:test:dup', 'manual', '999 Dup Ave', 'Test County', 'OH')
    `).run();
    for (const iv of ['iv-old', 'iv-new']) {
      db.prepare(`
        INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json)
        VALUES ('parcel:test:dup', ?, '{}')
      `).run(iv);
      const scoreInputId = (
        db.prepare('SELECT id FROM acq_score_inputs WHERE inputs_version = ?').get(iv) as { id: number }
      ).id;
      db.prepare(`
        INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json, scored_at)
        VALUES ('parcel:test:dup', ?, ?, 50, 'T2', 'WATCH', 1, '{}', ?)
      `).run(scoreInputId, iv, iv === 'iv-old' ? '2026-06-01T00:00:00Z' : '2026-07-01T00:00:00Z');
    }

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const floor = report.openQuestions.filter((q) => q.kind === 'floor-indeterminate' && q.title.includes('999 Dup Ave'));
    expect(floor).toHaveLength(1); // not 2 — only the latest (iv-new) row surfaces
  });

  it('the LIMIT truncation is total-ordered (scored_at, id) — deterministic under same-second ties (refute fix)', () => {
    // The I1 governor-fingerprint fix can re-key an entire candidate pool within the same
    // wall-clock second (a governor-ratification re-score batch). Without an `id DESC` tiebreak
    // on the OUTER ORDER BY (the inner per-candidate dedup subquery already had one), which 10 of
    // N tied candidates survive OPEN_QUESTION_GROUP_CAP was SQLite's unspecified tie-iteration
    // order — nondeterministic across runs on identical data.
    const db = freshDb();
    seedPropertyMaster(db);
    const TIED_AT = '2026-07-01T00:00:00Z';
    for (let i = 1; i <= 11; i++) {
      const id = `parcel:test:tie-${i}`;
      db.prepare(`INSERT INTO acq_candidates (id, source, address, county, state) VALUES (?, 'manual', ?, 'Test County', 'OH')`)
        .run(id, `${i} Tie St`);
      db.prepare(`INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES (?, ?, '{}')`)
        .run(id, `iv-tie-${i}`);
      const scoreInputId = (db.prepare('SELECT id FROM acq_score_inputs WHERE inputs_version = ?').get(`iv-tie-${i}`) as { id: number }).id;
      db.prepare(`
        INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json, scored_at)
        VALUES (?, ?, ?, 50, 'T2', 'WATCH', 1, '{}', ?)
      `).run(id, scoreInputId, `iv-tie-${i}`, TIED_AT);
    }
    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const tied = report.openQuestions.filter((q) => q.kind === 'floor-indeterminate' && q.title.includes('Tie St'));
    expect(tied).toHaveLength(10); // capped
    // Total order (scored_at DESC, id DESC) means the HIGHEST-id (most-recently-inserted) rows
    // win a same-second tie — candidate #1 (lowest id) is the one excluded by the cap. Exact
    // "N Tie St" match (not substring — "1 Tie St" is a substring of "11 Tie St").
    const addresses = new Set(tied.map((q) => q.title.replace('Floor indeterminate — ', '')));
    expect(addresses.has('1 Tie St')).toBe(false);
    expect(addresses.has('11 Tie St')).toBe(true);
  });
});

// ── versionLog ───────────────────────────────────────────────────────────────────────────────

describe('buildBrainReport — versionLog', () => {
  it('merges calibration_log config-changes with inputs_version first-seen events', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    db.prepare(`
      INSERT INTO calibration_log (config_table, param_key, old_value, new_value, rationale)
      VALUES ('capital_config', 'dscr_floor', '1.20', '1.25', 'ratified update')
    `).run();

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.versionLog.some((v) => v.kind === 'config-change')).toBe(true);
    expect(report.versionLog.some((v) => v.kind === 'inputs-version')).toBe(true);
    const configChange = report.versionLog.find((v) => v.kind === 'config-change')!;
    expect(configChange.detail).toContain('dscr_floor');
    expect(configChange.detail).toContain('1.20');
    expect(configChange.detail).toContain('1.25');
  });

  // ── FINDING 2 regression: single comparison basis (no Date.parse/localeCompare mixing) ──────
  //
  // The bug: the old comparator used numeric `Date.parse` when both sides parsed, but fell back
  // to `b.at.localeCompare(a.at)` when either side was NaN — two different bases in the SAME
  // comparator, which is non-transitive in general and broke Array.sort's ordering guarantee
  // (reviewers constructed a 3-event cycle that sorted differently depending on input order).

  it('a same-day mix of the two real DB timestamp shapes (calibration_log "...T...Z" vs calibration_inputs_version\'s space-separated datetime(\'now\')) still orders newest-first', () => {
    // Empirically confirmed shapes (better-sqlite3, in-process): datetime('now') never emits
    // 'T'/'Z'; strftime('%Y-%m-%dT%H:%M:%SZ','now') always does. Under a naive raw string sort
    // (no normalization), the space-separated string sorts BEFORE any 'T' string regardless of
    // the time that follows (' ' = 0x20 < 'T' = 0x54) — so a same-day inputs-version event that
    // is chronologically LATER than a config-change event would wrongly sort as earlier.
    const db = freshDb();
    seedPropertyMaster(db);
    db.prepare(`
      INSERT INTO calibration_log (config_table, param_key, old_value, new_value, rationale, logged_at)
      VALUES ('capital_config', 'dscr_floor', '1.20', '1.25', 'ratified', '2026-04-01T09:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO calibration_inputs_version
        (inputs_version, ledger_fingerprint, config_hash, code_version, config_json, created_at)
      VALUES ('iv-late', 'fp-late', 'hash-late', 'test', '{}', '2026-04-01 10:00:00')
    `).run();

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.versionLog).toHaveLength(2);
    // 10:00 (inputs-version) is genuinely later in the day than 09:00 (config-change).
    expect(report.versionLog[0]!.kind).toBe('inputs-version');
    expect(report.versionLog[1]!.kind).toBe('config-change');
  });
});

describe('sortVersionEvents — FINDING 2 regression (deterministic, order-independent total order)', () => {
  const jan: VersionEvent = { at: '2026-01-05T10:00:00Z', kind: 'config-change', detail: 'jan' };
  const mar: VersionEvent = { at: '2026-03-01T00:00:00Z', kind: 'inputs-version', detail: 'mar' };
  const feb: VersionEvent = { at: '2026-02-15T12:00:00Z', kind: 'config-change', detail: 'feb' };

  it('produces the identical, correctly newest-first ordering regardless of input insertion order', () => {
    const order1 = sortVersionEvents([jan, mar, feb]);
    const order2 = sortVersionEvents([feb, jan, mar]);
    const order3 = sortVersionEvents([mar, feb, jan]);

    expect(order1.map((e) => e.detail)).toEqual(['mar', 'feb', 'jan']);
    expect(order2).toEqual(order1);
    expect(order3).toEqual(order1);
  });

  it('two events on the same calendar day, in both insertion orders, sort identically and chronologically', () => {
    const early: VersionEvent = { at: '2026-04-01T09:00:00Z', kind: 'config-change', detail: 'early' };
    const late: VersionEvent = { at: '2026-04-01T10:00:00Z', kind: 'inputs-version', detail: 'late' };

    expect(sortVersionEvents([early, late]).map((e) => e.detail)).toEqual(['late', 'early']);
    expect(sortVersionEvents([late, early]).map((e) => e.detail)).toEqual(['late', 'early']);
  });
});

// ── empty warehouse ──────────────────────────────────────────────────────────────────────────

describe('buildBrainReport — empty warehouse (never throws, never fabricates)', () => {
  it('parses through the BrainReport contract with nulls/empties and advisoryOnly=true', () => {
    const db = freshDb();
    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    const parsed = BrainReport.parse(report);

    expect(parsed.overallHitRate).toBeNull();
    expect(parsed.overallCi).toBeNull();
    expect(parsed.resolvedTotal).toBe(0);
    expect(parsed.watchedSignals).toBe(0);
    expect(parsed.recalibrations).toBe(0);
    expect(parsed.accuracySeries).toEqual([]);
    expect(parsed.trackRecord).toEqual([]);
    expect(parsed.confidenceByMarket).toEqual([]);
    expect(parsed.confidenceByManager).toEqual([]);
    // Dormant-generator questions are always emitted (a codebase fact, not warehouse data).
    expect(parsed.openQuestions.filter((q) => q.kind === 'dormant-generator')).toHaveLength(4);
    expect(parsed.versionLog).toEqual([]);
    expect(parsed.advisoryOnly).toBe(true);
  });
});

// ── dataAsOf (2026-08-24 integrity sweep, Finding 10) ────────────────────────────────────────

describe('buildBrainReport — dataAsOf (data freshness, distinct from asOf/report-generation time)', () => {
  it('is null on an empty warehouse (no imports yet — never fabricated)', () => {
    const db = freshDb();
    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(report.dataAsOf).toBeNull();
  });

  it('is the MAX(imported_at) across import_batches, independent of the asOf report-generation param', () => {
    const db = freshDb();
    const insertBatch = db.prepare(`
      INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, version, status)
      VALUES (?, ?, ?, ?, 1, 'committed')
    `);
    insertBatch.run('a.xlsx', 'hash-a', '/raw/a.xlsx', '2026-08-10T12:00:00Z');
    insertBatch.run('b.xlsx', 'hash-b', '/raw/b.xlsx', '2026-08-17T09:30:00Z'); // latest
    insertBatch.run('c.xlsx', 'hash-c', '/raw/c.xlsx', '2026-08-01T00:00:00Z');

    // asOf (report-generation time) is far later than any import — this is exactly the stalled-
    // pipeline shape Finding 10 describes: a bake keeps restamping a fresh asOf over stale data.
    const report = buildBrainReport(db, '2026-08-24T15:00:00Z');
    expect(report.dataAsOf).toBe('2026-08-17T09:30:00Z');
    expect(report.dataAsOf).not.toBe(report.asOf);
  });

  it('ignores a newer pending-review import — its ledger is inactive, so it is not actually served (PR #302 review finding)', () => {
    const db = freshDb();
    const insertBatch = db.prepare(`
      INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, version, status)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    insertBatch.run('committed.xlsx', 'hash-committed', '/raw/committed.xlsx', '2026-08-10T12:00:00Z', 'committed');
    // Landed LATER than the committed import, but never promoted -- its ledger_entries stayed
    // is_active=0 (see ingest.ts), so it is not part of what the warehouse actually serves. An
    // unfiltered MAX(imported_at) would report THIS timestamp, making dataAsOf look fresher than
    // the served data actually is -- the exact staleness-masking bug this field exists to close.
    insertBatch.run('pending.xlsx', 'hash-pending', '/raw/pending.xlsx', '2026-08-20T00:00:00Z', 'pending-review');

    const report = buildBrainReport(db, '2026-08-24T15:00:00Z');
    expect(report.dataAsOf).toBe('2026-08-10T12:00:00Z');
  });
});

// ── report parses through the contract on populated data too ────────────────────────────────

describe('buildBrainReport — contract parity', () => {
  it('a fully-populated report still parses cleanly through BrainReport', () => {
    const db = freshDb();
    seedPropertyMaster(db);
    seedInputsVersion(db, 'iv-1', 'hash-1');
    seedInputsVersion(db, 'iv-2', 'hash-2');
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-1', hit: 1, resolvedAt: '2026-01-01T00:00:00Z' });
    seedResolved(db, { subjectId: '1100-rarig-ave-columbus-oh', inputsVersion: 'iv-2', hit: 0, resolvedAt: '2026-01-02T00:00:00Z' });

    const report = buildBrainReport(db, '2026-07-06T00:00:00Z');
    expect(() => BrainReport.parse(report)).not.toThrow();
  });
});

// ── brain-api routes ─────────────────────────────────────────────────────────────────────────

describe('brainApi — GET /report', () => {
  it('returns 200 with a Zod-valid BrainReport on an empty warehouse', async () => {
    const db = freshDb();
    const app = brainApi(() => db);
    const res = await app.request('/report');
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(() => BrainReport.parse(body)).not.toThrow();
  });

  it('returns 503 when the warehouse is unavailable', async () => {
    const app = brainApi(() => { throw new Error('cannot open warehouse db'); });
    const res = await app.request('/report');
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({ error: 'warehouse unavailable' });
  });
});

describe('brainApi — feedback POST → GET round trip', () => {
  it('a posted decision is Zod-valid and appears in the subsequent GET list', async () => {
    const db = freshDb();
    const app = brainApi(() => db);

    const postRes = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectKind: 'insight', subjectId: 'cf-1-some-property', decision: 'accept', note: 'looks right' }),
    });
    expect(postRes.status).toBe(200);
    const created = (await postRes.json()) as { id: string; subjectKind: string; decision: string };
    expect(created.subjectKind).toBe('insight');
    expect(created.decision).toBe('accept');
    expect(created.id).toBeTruthy();

    const getRes = await app.request('/feedback');
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { feedback: Array<{ id: string; subjectId: string; note: string | null }> };
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0]!.id).toBe(created.id);
    expect(body.feedback[0]!.subjectId).toBe('cf-1-some-property');
    expect(body.feedback[0]!.note).toBe('looks right');
  });

  it('duplicate decisions for the same subject are both retained (append-only, latest wins is a UI concern)', async () => {
    const db = freshDb();
    const app = brainApi(() => db);

    await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectKind: 'alert', subjectId: 'alert-1', decision: 'dismiss', note: null }),
    });
    await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectKind: 'alert', subjectId: 'alert-1', decision: 'accept', note: 'changed my mind' }),
    });

    const getRes = await app.request('/feedback');
    const body = (await getRes.json()) as { feedback: Array<{ subjectId: string; decision: string }> };
    const forSubject = body.feedback.filter((f) => f.subjectId === 'alert-1');
    expect(forSubject).toHaveLength(2);
  });

  it('an invalid feedback body → 400', async () => {
    const db = freshDb();
    const app = brainApi(() => db);
    const res = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectKind: 'bogus', subjectId: 'x', decision: 'accept' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /feedback on an empty warehouse → 200 {feedback:[]}', async () => {
    const db = freshDb();
    const app = brainApi(() => db);
    const res = await app.request('/feedback');
    expect(res.status).toBe(200);
    expect((await res.json()) as { feedback: unknown[] }).toEqual({ feedback: [] });
  });

  it('an unopenable warehouse → every route returns 503, never throws', async () => {
    const app = brainApi(() => { throw new Error('cannot open warehouse db'); });
    for (const path of ['/report', '/feedback']) {
      const res = await app.request(path);
      expect(res.status).toBe(503);
    }
    const postRes = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectKind: 'insight', subjectId: 'x', decision: 'accept' }),
    });
    expect(postRes.status).toBe(503);
  });
});
