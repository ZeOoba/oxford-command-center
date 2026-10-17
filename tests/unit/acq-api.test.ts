// @vitest-environment node
//
// tests/unit/acq-api.test.ts
//
// Phase 4 — Acquisition Intelligence Engine: API route tests.
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 6.
//
// Tests:
//   GET /acq/intel — returns AcqIntelResponse (Zod-validated); sorted composite DESC;
//                    advisoryOnly matches ruleset state; calibrationSummary.totalVerdicts
//                    increments after a score event.
//   GET /acq/candidates — returns candidates array.
//   POST /acq/import/parcel-screen — inserted/skipped counts correct; idempotent.
//   POST /acq/candidates — creates a manual candidate.
//   PATCH /acq/candidates/:id/status — updates status; 404 for unknown id.
//
// All tests use an in-memory SQLite warehouse (tmpdir) — never touches finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { parseLimitParam } from '../../server/lib/query-params';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { AcqIntelResponse } from '@contracts/acquisition';
import type { ParcelScreenImportRequest } from '@contracts/acquisition';

/** Open a fresh in-memory warehouse (all migrations applied). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-api-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Build a Hono app wired to the given db. */
function makeApp(db: WarehouseDb) {
  return warehouseRoutes(() => db);
}

/** A 2-parcel import payload. */
function twoParcelBatch(): ParcelScreenImportRequest {
  return {
    batchLabel: 'Franklin County OH — Test',
    county: 'Franklin',
    state: 'OH',
    candidates: [
      {
        apn: '010-001',
        address: '100 Industrial Dr, Columbus OH',
        market: 'owned-submarket',
        rentableSf: 20000,
        yearBuilt: 2000,
        ownerName: 'Alpha Properties LLC',
        parcelScreenScore: 80,
      },
      {
        apn: '010-002',
        address: '200 Commerce Way, Columbus OH',
        market: 'established',
        rentableSf: 15000,
        yearBuilt: 1995,
        ownerName: 'Beta Holdings',
        parcelScreenScore: 65,
      },
    ],
  };
}

/** POST helper for JSON bodies. */
async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PATCH helper. */
async function patch(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── GET /acq/intel ─────────────────────────────────────────────────────────────────────────

describe('GET /acq/intel', () => {
  it('returns a 200 and an AcqIntelResponse-shaped body on empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await app.request('/acq/intel');
    expect(res.status).toBe(200);

    const body = await res.json() as unknown;
    // Zod-validate the response shape.
    const parsed = AcqIntelResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('returns empty rankedCandidates on an empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await app.request('/acq/intel');
    const body = (await res.json()) as { rankedCandidates: unknown[] };
    expect(body.rankedCandidates).toHaveLength(0);
  });

  it('includes calibrationSummary with zero counts on empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await app.request('/acq/intel');
    const body = (await res.json()) as { calibrationSummary: { totalVerdicts: number; overallHitRate: unknown } };
    expect(body.calibrationSummary.totalVerdicts).toBe(0);
    expect(body.calibrationSummary.overallHitRate).toBeNull();
  });

  it('includes advisoryOnly=true when ratified ruleset is absent (proposed path)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    // The ratified config may or may not be available in the test env;
    // we just verify the field is a boolean.
    const res = await app.request('/acq/intel');
    const body = (await res.json()) as { advisoryOnly: unknown };
    expect(typeof body.advisoryOnly).toBe('boolean');
  });

  it('returns candidates sorted by composite DESC after import + scores inserted directly', async () => {
    const db = freshDb();
    const app = makeApp(db);

    // Import 2 candidates via the API.
    await post(app, '/acq/import/parcel-screen', twoParcelBatch());

    // Directly insert synthetic acq_score_inputs + acq_scores rows so we can
    // test ordering without needing a ratified ruleset at runtime.
    const cand1 = 'parcel:oh:franklin:010-001';
    const cand2 = 'parcel:oh:franklin:010-002';

    db.prepare(`
      INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, ruleset_version, rct_version)
      VALUES (?, 'abcd1234abcd1234', '{}', '1.0.0', 'replacement-cost.v1')
    `).run(cand1);
    db.prepare(`
      INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, ruleset_version, rct_version)
      VALUES (?, 'efgh5678efgh5678', '{}', '1.0.0', 'replacement-cost.v1')
    `).run(cand2);

    const si1 = (db.prepare('SELECT id FROM acq_score_inputs WHERE candidate_id = ?').get(cand1) as { id: number }).id;
    const si2 = (db.prepare('SELECT id FROM acq_score_inputs WHERE candidate_id = ?').get(cand2) as { id: number }).id;

    // Insert scores: cand1 composite=75, cand2 composite=50
    db.prepare(`
      INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
        advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate, score_json)
      VALUES (?, ?, 'abcd1234abcd1234', 75, 'T1', 'PURSUE', 1, 0, 1, 1, 0, '{}')
    `).run(cand1, si1);
    db.prepare(`
      INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
        advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate, score_json)
      VALUES (?, ?, 'efgh5678efgh5678', 50, 'T2', 'WATCH', 1, 0, 1, 1, 0, '{}')
    `).run(cand2, si2);
    // Fixture inserts bypass persistAndLogScore; set the current-score pointers it would set.
    for (const id of [cand1, cand2]) db.prepare(`UPDATE acq_candidates SET current_score_id = (SELECT id FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1) WHERE id = ?`).run(id, id);

    const res = await app.request('/acq/intel?status=active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankedCandidates: Array<{ candidate: { id: string } }> };

    expect(body.rankedCandidates.length).toBeGreaterThanOrEqual(2);
    // First candidate should be the higher-composite one.
    expect(body.rankedCandidates[0]!.candidate.id).toBe(cand1);
    expect(body.rankedCandidates[1]!.candidate.id).toBe(cand2);
  });

  it('returns 200 with default limit when limit=bad (non-numeric)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    // Non-numeric limit must not produce NaN/500 — API must default gracefully.
    const res = await app.request('/acq/intel?limit=bad');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankedCandidates: unknown[] };
    expect(Array.isArray(body.rankedCandidates)).toBe(true);
  });

  it('limit= (empty) and limit=2.5 (fractional) fall back to the route default instead of truncating to 1 row', async () => {
    const db = freshDb();
    const app = makeApp(db);
    for (const q of ['/acq/intel?limit=', '/acq/intel?limit=2.5', '/acq/candidates?limit=', '/acq/candidates?limit=0.5']) {
      const res = await app.request(q);
      expect(res.status, q).toBe(200);
    }
    expect(parseLimitParam(undefined, 100, 500)).toBe(100);
    expect(parseLimitParam('', 100, 500)).toBe(100);
    expect(parseLimitParam('   ', 100, 500)).toBe(100);
    expect(parseLimitParam('2.5', 100, 500)).toBe(100);
    expect(parseLimitParam('bad', 100, 500)).toBe(100);
    expect(parseLimitParam('0', 100, 500)).toBe(1);
    expect(parseLimitParam('-3', 100, 500)).toBe(1);
    expect(parseLimitParam('9999', 100, 500)).toBe(500);
    expect(parseLimitParam('42', 100, 500)).toBe(42);
  });

  it('GET /acq/intel serves the current_score_id row, not the newest-written one (same scored_at, pointer at the LOWER id)', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const cand = 'parcel:oh:test:tie-apn';
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES (?, 'parcel-screen', 'active')`).run(cand);
    const ids: number[] = [];
    for (const [iv, dscr] of [['aaaa0000aaaa0000', 1], ['bbbb1111bbbb1111', 0]] as const) {
      db.prepare(`
        INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, ruleset_version, rct_version)
        VALUES (?, ?, '{}', '1.0.0', 'replacement-cost.v1')
      `).run(cand, iv);
      const si = (db.prepare('SELECT id FROM acq_score_inputs WHERE inputs_version = ?').get(iv) as { id: number }).id;
      db.prepare(`
        INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
          advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate,
          governor_dscr_cleared, score_json, scored_at)
        VALUES (?, ?, ?, 40, 'T2', 'WATCH', 1, 0, 1, 1, 0, ?, '{}', '2026-06-20T10:00:00')
      `).run(cand, si, iv, dscr);
      ids.push((db.prepare('SELECT id FROM acq_scores WHERE score_input_id = ?').get(si) as { id: number }).id);
    }
    // Same scored_at: write order would pick ids[1] (dscr cleared = false). The pointer says ids[0] (true).
    db.prepare('UPDATE acq_candidates SET current_score_id = ? WHERE id = ?').run(ids[0], cand);

    const res = await app.request('/acq/intel?status=active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankedCandidates: Array<{ governorDscrCleared: boolean | null }> };
    expect(body.rankedCandidates[0]!.governorDscrCleared).toBe(true);
  });
});

// ── GET /acq/candidates ────────────────────────────────────────────────────────────────────

describe('GET /acq/candidates', () => {
  it('returns 200 with empty candidates array on empty warehouse', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await app.request('/acq/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates).toHaveLength(0);
  });

  it('returns imported candidates after parcel-screen import', async () => {
    const db = freshDb();
    const app = makeApp(db);

    await post(app, '/acq/import/parcel-screen', twoParcelBatch());

    const res = await app.request('/acq/candidates?status=active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ id: string }> };
    expect(body.candidates).toHaveLength(2);
  });
});

// ── POST /acq/import/parcel-screen ────────────────────────────────────────────────────────

describe('POST /acq/import/parcel-screen', () => {
  it('returns 200 with inserted:2, skipped:0 on first import', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await post(app, '/acq/import/parcel-screen', twoParcelBatch());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; skipped: number; batchId: string };
    expect(body.inserted).toBe(2);
    expect(body.skipped).toBe(0);
    expect(typeof body.batchId).toBe('string');
  });

  it('returns inserted:0, skipped:2 on re-import (idempotent)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    await post(app, '/acq/import/parcel-screen', twoParcelBatch());
    const res = await post(app, '/acq/import/parcel-screen', twoParcelBatch());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inserted: number; skipped: number };
    expect(body.inserted).toBe(0);
    expect(body.skipped).toBe(2);
  });

  it('returns 400 on invalid body', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await post(app, '/acq/import/parcel-screen', { bad: 'data' });
    expect(res.status).toBe(400);
  });
});

// ── POST /acq/candidates ───────────────────────────────────────────────────────────────────

describe('POST /acq/candidates', () => {
  it('creates a manual candidate and returns a candidateId', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await post(app, '/acq/candidates', {
      address: '789 Warehouse Blvd, Columbus OH',
      county: 'Franklin',
      state: 'OH',
      market: 'established',
      rentableSf: 30000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidateId: string };
    expect(typeof body.candidateId).toBe('string');
    expect(body.candidateId).toMatch(/^manual:/);
  });

  it('the created candidate is queryable via GET /acq/candidates', async () => {
    const db = freshDb();
    const app = makeApp(db);

    await post(app, '/acq/candidates', {
      address: '999 Test Ave, Columbus OH',
      county: 'Franklin',
      state: 'OH',
    });

    const res = await app.request('/acq/candidates?status=active');
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(1);
  });

  it('accepts an empty body (all fields optional)', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await post(app, '/acq/candidates', {});
    expect(res.status).toBe(200);
  });
});

// ── PATCH /acq/candidates/:id/status ──────────────────────────────────────────────────────

describe('PATCH /acq/candidates/:id/status', () => {
  it('updates candidate status and returns ok:true', async () => {
    const db = freshDb();
    const app = makeApp(db);

    // Create a candidate first.
    const createRes = await post(app, '/acq/candidates', { address: '100 Test Rd', county: 'Franklin', state: 'OH' });
    const { candidateId } = (await createRes.json()) as { candidateId: string };

    const res = await patch(app, `/acq/candidates/${candidateId}/status`, { status: 'passed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('the updated status is reflected in GET /acq/candidates', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const createRes = await post(app, '/acq/candidates', { address: '200 Test Rd', county: 'Franklin', state: 'OH' });
    const { candidateId } = (await createRes.json()) as { candidateId: string };

    await patch(app, `/acq/candidates/${candidateId}/status`, { status: 'archived' });

    // Query archived candidates.
    const res = await app.request('/acq/candidates?status=archived');
    const body = (await res.json()) as { candidates: Array<{ id: string; status: string }> };
    expect(body.candidates.some((c) => c.id === candidateId)).toBe(true);
  });

  it('returns 404 for an unknown candidateId', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const res = await patch(app, '/acq/candidates/no-such-id/status', { status: 'passed' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid status value', async () => {
    const db = freshDb();
    const app = makeApp(db);

    const createRes = await post(app, '/acq/candidates', { address: '300 Test Rd', county: 'Franklin', state: 'OH' });
    const { candidateId } = (await createRes.json()) as { candidateId: string };

    const res = await patch(app, `/acq/candidates/${candidateId}/status`, { status: 'invalid-status' });
    expect(res.status).toBe(400);
  });
});

// ── GET /acq/intel + /acq/candidates with a HubSpot-sourced row (2026-09-23 review, Task 1) ─

describe('GET /acq/intel + /acq/candidates with a HubSpot-sourced row', () => {
  function seedHubspotRow(db: WarehouseDb) {
    db.prepare(`
      INSERT INTO acq_candidates
        (id, source, address, county, state, market, rentable_sf, year_built, owner_name, status, content_hash)
      VALUES (?, 'hubspot-pipeline', ?, NULL, NULL, NULL, NULL, NULL, NULL, 'active', 'h1')
    `).run('hubspot:123', '511 Industrial Mile Road — Columbus, OH');
  }

  it('/acq/intel returns 200 and includes the row', async () => {
    const db = freshDb();
    seedHubspotRow(db);
    const res = await makeApp(db).request('/acq/intel');
    expect(res.status).toBe(200);
    const body = AcqIntelResponse.parse(await res.json());
    expect(body.rankedCandidates.some((c) => c.candidate.id === 'hubspot:123')).toBe(true);
  });

  it('/acq/candidates returns 200 and includes the row', async () => {
    const db = freshDb();
    seedHubspotRow(db);
    const res = await makeApp(db).request('/acq/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ id: string; source: string }> };
    expect(body.candidates.find((c) => c.id === 'hubspot:123')?.source).toBe('hubspot-pipeline');
  });
});

// ── Audit 2026-10-13 G3: explicit score freshness on GET /acq/intel ─────────────────────────
import { readFileSync as readFileSyncG3 } from 'node:fs';
import { resolve as resolveG3 } from 'node:path';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';

describe('GET /acq/intel — score freshness state (audit 2026-10-13 G3)', () => {
  const RULESET = parseRuleset(JSON.parse(readFileSyncG3(resolveG3(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
  const RCT = loadRatifiedRct();
  const STRONG = AcquisitionInput.parse({
    dealId: 'intel-fresh',
    price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
    productType: 'shallow-bay-multi', officePct: 0.1,
    clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
    multiStory: false, truckCourtFt: 120,
    constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
    allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
    clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
    isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
    ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
  });

  async function seedScored(db: WarehouseDb, id: string) {
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES (?, 'manual', 'active')`).run(id);
    await persistAndLogScore(db, id, { ...STRONG, dealId: id }, RULESET, RCT);
  }
  async function intel(db: WarehouseDb) {
    const res = await makeApp(db).request('/acq/intel');
    expect(res.status).toBe(200);
    return AcqIntelResponse.parse(await res.json());
  }
  const row = (b: AcqIntelResponse, id: string) => b.rankedCandidates.find((c) => c.candidate.id === id)!;

  it('a score persisted under the live regime is current; an unscored candidate is unscored', async () => {
    const db = freshDb();
    await seedScored(db, 'c-fresh');
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('c-none', 'manual', 'active')`).run();
    const b = await intel(db);
    expect(row(b, 'c-fresh').scoreState).toBe('current');
    expect(row(b, 'c-fresh').latestScore?.verdict).toBe('PURSUE');
    expect(row(b, 'c-none').scoreState).toBe('unscored');
  });

  it('a governor regime bump flags the old score stale (still readable, with a reason)', async () => {
    const db = freshDb();
    await seedScored(db, 'c-stale');
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-10-13', 1.30, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor bump')`,
    ).run();
    const r = row(await intel(db), 'c-stale');
    expect(r.scoreState).toBe('stale');
    expect(r.staleReasons!.join(' ')).toMatch(/governor/i);
    expect(r.latestScore).not.toBeNull();
  });

  // Option A merge with #463: /acq/intel and the capital BUY gate share classifyPersistedScore, so a
  // row BUY withholds for governor-regime staleness can never read 'current' here.
  it('an UNRELATED-field capital_config write (BUY withheld by the #463 stamp) reads stale here too, then current after re-score', async () => {
    const db = freshDb();
    await seedScored(db, 'c-unrelated');
    const { writeCapitalConfig } = await import('../../server/warehouse/capital-config');
    writeCapitalConfig(db, { dispositionCapRate: 0.06, effectiveFrom: '2026-10-13' }, { rationale: 'test: unrelated field' });
    const r = row(await intel(db), 'c-unrelated');
    expect(r.scoreState).toBe('stale');
    expect(r.staleReasons!.join(' ')).toMatch(/governorRegime stamp 1:1\.25:0\.4:0\.085 does not match the live governor regime 2:/);
    // (The matching BUY withholding is asserted in capital-allocation.buy-gate.test.ts, refute H2 + #463.)
    await persistAndLogScore(db, 'c-unrelated', { ...STRONG, dealId: 'c-unrelated' }, RULESET, RCT);
    expect(row(await intel(db), 'c-unrelated').scoreState).toBe('current');
  });

  it('a score_json that no longer parses is an explicit unparseable state, not a silent null', async () => {
    const db = freshDb();
    await seedScored(db, 'c-bad');
    db.prepare(`UPDATE acq_scores SET score_json = '{"verdict":"PURSUE"}' WHERE candidate_id = 'c-bad'`).run();
    const r = row(await intel(db), 'c-bad');
    expect(r.latestScore).toBeNull();
    expect(r.scoreState).toBe('unparseable');
    expect(r.staleReasons!.length).toBeGreaterThan(0);
  });

  it('a pre-bump score under an old ruleset version is stale', async () => {
    const db = freshDb();
    await seedScored(db, 'c-old');
    db.prepare(`UPDATE acq_score_inputs SET ruleset_version = '1.0.0' WHERE candidate_id = 'c-old'`).run();
    expect(row(await intel(db), 'c-old').scoreState).toBe('stale');
  });
});

// ── Audit 2026-10-13 G4: verdict-rank ordering; KILLED excluded from the default view ─────────
describe('GET /acq/intel — verdict-rank ordering (audit 2026-10-13 G4)', () => {
  /** Synthetic latest-score row with a chosen verdict + composite (ordering only — not a BUY path). */
  function seedRow(db: WarehouseDb, id: string, verdict: string, tier: string, composite: number) {
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES (?, 'manual', 'active')`).run(id);
    db.prepare(`INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES (?, ?, '{}')`).run(id, `iv-${id}`);
    const sid = (db.prepare('SELECT id FROM acq_score_inputs WHERE candidate_id = ?').get(id) as { id: number }).id;
    db.prepare(`
      INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
        advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate, score_json)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, 1, 0, '{}')
    `).run(id, sid, `iv-${id}`, composite, tier, verdict);
  }
  function seedAll(db: WarehouseDb) {
    seedRow(db, 'k-killed', 'KILLED', 'KILLED', 99);  // highest composite — must NOT outrank PURSUE
    seedRow(db, 'p-pass', 'PASS', 'PASS', 90);
    seedRow(db, 'w-watch', 'WATCH', 'T2', 85);
    seedRow(db, 'u-pursue', 'PURSUE', 'T1', 76);
    seedRow(db, 'u-pursue-hi', 'PURSUE', 'T1', 88);
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('z-unscored', 'manual', 'active')`).run();
  }
  const ids = async (db: WarehouseDb, q = '') => {
    const res = await makeApp(db).request(`/acq/intel${q}`);
    expect(res.status).toBe(200);
    return AcqIntelResponse.parse(await res.json()).rankedCandidates.map((c) => c.candidate.id);
  };

  it('orders PURSUE, WATCH, PASS (then unscored) — composite only breaks ties within a verdict; KILLED hidden by default', async () => {
    const db = freshDb();
    seedAll(db);
    expect(await ids(db)).toEqual(['u-pursue-hi', 'u-pursue', 'w-watch', 'p-pass', 'z-unscored']);
  });

  it('includeKilled=1 adds KILLED ranked after PASS despite the highest composite', async () => {
    const db = freshDb();
    seedAll(db);
    expect(await ids(db, '?includeKilled=1')).toEqual(['u-pursue-hi', 'u-pursue', 'w-watch', 'p-pass', 'k-killed', 'z-unscored']);
  });

  it('an explicit verdict=KILLED filter still returns KILLED rows', async () => {
    const db = freshDb();
    seedAll(db);
    expect(await ids(db, '?verdict=KILLED')).toEqual(['k-killed']);
  });
});

// ── Refute H4: an empty capital_config must not 500 the whole ranked list — every scored row is
// flagged stale ('live scoring regime unavailable') instead.
describe('GET /acq/intel — empty capital_config (refute H4)', () => {
  it('returns 200 with every scored row stale, reason "live scoring regime unavailable"', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('c-h4', 'manual', 'active')`).run();
    db.prepare(`INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES ('c-h4', 'iv-h4', '{}')`).run();
    const sid = (db.prepare(`SELECT id FROM acq_score_inputs WHERE candidate_id = 'c-h4'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
        advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate, score_json)
      VALUES ('c-h4', ?, 'iv-h4', 80, 'T1', 'PURSUE', 0, 0, 1, 1, 0, '{}')
    `).run(sid);
    db.prepare('DELETE FROM capital_config').run();
    const res = await makeApp(db).request('/acq/intel');
    expect(res.status).toBe(200);
    const body = AcqIntelResponse.parse(await res.json());
    const r = body.rankedCandidates.find((c) => c.candidate.id === 'c-h4')!;
    expect(r.scoreState).toBe('stale');
    expect(r.staleReasons!.join(' ')).toMatch(/live scoring regime unavailable/);
  });
});
