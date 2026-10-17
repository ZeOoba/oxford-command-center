// @vitest-environment node
//
// tests/unit/capital-allocation.buy-gate.test.ts
//
// Audit 2026-10-13 (Wave 2a) — the portfolio BUY gate in buildPortfolioAllocation, driven by REAL
// acquisition scores: every acq_scores row here is written by persistAndLogScore() from a real
// scoreAcquisition() run on the ratified ruleset + RCT (no hand-written score_json). Where a test
// needs a state the current engine can no longer produce (a pre-fix row with tier T1 next to a
// governor-demoted PASS verdict, an advisory row, an out-of-domain governor flag), it UPDATEs the
// persisted row to that legacy/corrupt state, which is exactly what a reader must defend against.
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  const scoreDebtPositions = vi.fn(() => []);
  return {
    scoreDebtPositions,
    scoreDebtPositionsWithTrust: vi.fn((db: unknown) => ({
      scores: [],
      bookTrust: readDebtBookTrust(db as WarehouseDb),
    })),
  };
});
import type * as MetricsModule from '../../server/warehouse/metrics';
vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsModule>();
  return { ...actual, propertyPeriodMetrics: vi.fn(() => []) };
});

import { getMacro } from '../../server/macro/getMacro';
import { scoreProperties } from '../../server/warehouse/scores';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../../src/contracts/acquisition';

const RULESET: AcquisitionRuleset = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT: ReplacementCostTable = loadRatifiedRct();

/** Strong, governor-clearing deal — scores T1 PURSUE (composite 80.6) on the ratified ruleset. */
const STRONG_RAW: Record<string, unknown> = {
  dealId: 'buy-gate-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const input = (o: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...STRONG_RAW, ...o });

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cap-alloc-buygate-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

/** Insert an active candidate and persist a REAL score for it through the production funnel. */
async function seedScored(db: WarehouseDb, id: string, o: Record<string, unknown> = {}): Promise<void> {
  db.prepare(`INSERT INTO acq_candidates (id, source, market, status) VALUES (?, 'manual', 'owned-submarket', 'active')`).run(id);
  await persistAndLogScore(db, id, input({ dealId: id, ...o }), RULESET, RCT);
}

/** Force the latest acq_scores row for a candidate into a legacy / corrupt state. */
function mutateLatest(db: WarehouseDb, id: string, set: string, ...params: unknown[]): void {
  db.prepare(`UPDATE acq_scores SET ${set} WHERE id = (SELECT id FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1)`)
    .run(...params, id);
}

async function buy(db: WarehouseDb) {
  const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
  const r = await buildPortfolioAllocation(db, '2026-10-13');
  return { result: r, buyVerdicts: r.verdicts.filter((v) => v.action === 'buy') };
}

beforeEach(() => {
  vi.mocked(getMacro).mockResolvedValue(null as never);
  vi.mocked(scoreProperties).mockReturnValue([]);
});

describe('BUY gate — real-score control', () => {
  it('precondition: the strong deal really scores T1 PURSUE, non-advisory', () => {
    const s = scoreAcquisition(input(), RULESET, { rct: RCT });
    expect(s.tier).toBe('T1');
    expect(s.verdict).toBe('PURSUE');
    expect(s.advisoryOnly).toBe(false);
    expect(s.composite).toBeGreaterThanOrEqual(70);
  });

  it('a clean real T1 PURSUE score is buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-clean');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-clean']);
  });
});

describe('BUY gate — governor-demoted verdict (audit 2026-10-13 G1)', () => {
  it("tier='T1' with verdict='PASS' (pre-fix persisted row) is NOT buyable", async () => {
    const db = freshDb();
    await seedScored(db, 'cand-t1-pass');
    mutateLatest(db, 'cand-t1-pass', "verdict = 'PASS', governor_dscr_cleared = 0");
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a score persisted under an INVALID governor set (ltv_ceiling 0, fail-closed demotion) is NOT buyable', async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-07-16', 1.25, 0, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: invalid governor set')`,
    ).run();
    await seedScored(db, 'cand-invalid-gov');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('advisory_only = 1 is NOT buyable even with a PURSUE verdict', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-advisory');
    mutateLatest(db, 'cand-advisory', 'advisory_only = 1');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('an out-of-domain (unknown) governor flag fails closed — NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-unknown-dscr');
    mutateLatest(db, 'cand-unknown-dscr', 'governor_dscr_cleared = 2');
    await seedScored(db, 'cand-unknown-ltv');
    mutateLatest(db, 'cand-unknown-ltv', 'governor_ltv_cleared = -1');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a failed governor flag blocks BUY even if the verdict column still reads PURSUE', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-dscr-0');
    mutateLatest(db, 'cand-dscr-0', 'governor_dscr_cleared = 0');
    await seedScored(db, 'cand-ltv-0');
    mutateLatest(db, 'cand-ltv-0', 'governor_ltv_cleared = 0');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('an ineligible top-ranked candidate is skipped for the next eligible one', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-top-demoted');
    mutateLatest(db, 'cand-top-demoted', "verdict = 'PASS', composite = 95");
    await seedScored(db, 'cand-next');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-next']);
  });
});

// ── Audit 2026-10-13 G2: score_json is parsed with the AcquisitionScore schema; basis discount and
// levered IRR come from floors[] ('basis' / 'irr'); the basis floor is the RATIFIED ruleset's
// vintage floor (no separate unratified 5% constant); an indeterminate basis is never buyable.
const NO_BASIS_WATCH = { allInBasis: null, valueAddScore: 1, sellerMotivationScore: 1, marketRentPsf: 9, waltYears: 0.5, stabilizedYoc: 0.2 };

describe('BUY gate — score_json schema + floors (audit 2026-10-13 G2)', () => {
  it('basisDiscountPct / leveredIrr come from the real score floors[]', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-floors');
    const real = scoreAcquisition(input({ dealId: 'cand-floors' }), RULESET, { rct: RCT });
    const { result } = await buy(db);
    const c = result.pipeline.find((p) => p.candidateId === 'cand-floors')!;
    expect(c.basisDiscountPct).toBe(real.floors.find((f) => f.id === 'basis')!.actual);
    expect(c.leveredIrr).toBe(real.floors.find((f) => f.id === 'irr')!.actual);
    expect(c.basisDiscountPct).not.toBeNull();
  });

  it('precondition: the no-basis variant is a real WATCH with composite ≥ 70 and a null basis floor', () => {
    const s = scoreAcquisition(input(NO_BASIS_WATCH), RULESET, { rct: RCT });
    expect(s.verdict).toBe('WATCH');
    expect(s.composite).toBeGreaterThanOrEqual(70);
    expect(s.floors.find((f) => f.id === 'basis')!.actual).toBeNull();
  });

  it('an INDETERMINATE basis (null discount) is NOT buyable — conservative, never routed to BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-no-basis', NO_BASIS_WATCH);
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-no-basis')!.basisDiscountPct).toBeNull();
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a thin basis is KILLED by the ratified vintage floor and therefore not buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-thin', { allInBasis: 9_000_000 });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a malformed score_json is NOT buyable and yields null floors', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-bad-json');
    mutateLatest(db, 'cand-bad-json', "score_json = '{not json'");
    const { result, buyVerdicts } = await buy(db);
    const c = result.pipeline.find((p) => p.candidateId === 'cand-bad-json')!;
    expect(c.basisDiscountPct).toBeNull();
    expect(c.leveredIrr).toBeNull();
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a score_json that is not an AcquisitionScore (hand-written floors-only blob) is NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-phantom');
    mutateLatest(
      db, 'cand-phantom', 'score_json = ?',
      JSON.stringify({ basisDiscountPct: 0.4, leveredIrr: 0.2, floors: [{ id: 'basis', passed: true, actual: 0.4, required: 0.05, detail: '' }] }),
    );
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-phantom')!.basisDiscountPct).toBeNull();
    expect(buyVerdicts).toHaveLength(0);
  });

  it('the top-ranked buyable candidate is the highest real composite', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-established', { clusterTier: 'established' }); // 77.6 T1
    await seedScored(db, 'cand-owned');                                        // 80.6 T1
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-owned']);
  });

  it('a real WATCH below the composite floor (63.6) is not buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-low', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0 });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('real PASS and KILLED scores are never buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-pass', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0, clearHeightFt: 16, truckCourtFt: 50, dockCount: 1, driveInCount: 1, inPlaceRentPsf: 6, marketRentPsf: 6, waltYears: 6 });
    await seedScored(db, 'cand-killed', { leveredIrr: 0.05 });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('buy verdict.inputs are documented neutral placeholders and carry no basis-ambiguity warning', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-inputs');
    const { buyVerdicts } = await buy(db);
    const v = buyVerdicts[0]!;
    expect(v.inputs.dscr).toBeNull();
    expect(v.inputs.ltv).toBeNull();
    expect(v.inputs.noiPerSf).toBeNull();
    expect(v.expectedReturnPct).toBeNull();
    expect(v.reasons.some((r) => /not applicable/i.test(r))).toBe(true);
    expect(v.dataQuality.some((f) => f.field === 'basisDiscountPct')).toBe(false);
  });
});

// ── Audit 2026-10-13 G3: a score persisted under a superseded ruleset / RCT / governor regime is
// excluded from BUY until the version-change sweep re-derives it under the live regime.
describe('BUY gate — stale scoring regime (audit 2026-10-13 G3)', () => {
  function bumpGovernor(db: WarehouseDb): void {
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-10-13', 1.30, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor regime bump')`,
    ).run();
  }

  it('a score made under a superseded governor regime is NOT buyable; the re-score sweep restores it', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-gov-stale');
    bumpGovernor(db);
    expect((await buy(db)).buyVerdicts).toHaveLength(0);

    const { rescoreStaleCandidates } = await import('../../server/warehouse/acq-score-freshness');
    const sweep = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(sweep.rescored).toBe(1);
    expect((await buy(db)).buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-gov-stale']);
  });

  it('a score made under a superseded ruleset version is NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-ruleset-stale');
    db.prepare(`UPDATE acq_score_inputs SET ruleset_version = '1.0.0' WHERE candidate_id = 'cand-ruleset-stale'`).run();
    expect((await buy(db)).buyVerdicts).toHaveLength(0);
  });

  it('a score made under a superseded RCT version is NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-rct-stale');
    db.prepare(`UPDATE acq_score_inputs SET rct_version = 'replacement-cost.v3' WHERE candidate_id = 'cand-rct-stale'`).run();
    expect((await buy(db)).buyVerdicts).toHaveLength(0);
  });
});


// ── Audit 2026-10-13 G6: an empty capital_config table fails closed — no BUY, explicit error.
describe('BUY gate — empty capital_config (audit 2026-10-13 G6)', () => {
  it('buildPortfolioAllocation rejects with CapitalConfigMissingError (never a BUY on default governors)', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-no-config');
    db.prepare('DELETE FROM capital_config').run();
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const { CapitalConfigMissingError } = await import('../../server/warehouse/capital-config');
    await expect(buildPortfolioAllocation(db, '2026-10-13')).rejects.toThrow(CapitalConfigMissingError);
  });

  it('persistAndLogScore refuses to score (and writes nothing) with no capital_config row', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('cand-x', 'manual', 'active')`).run();
    db.prepare('DELETE FROM capital_config').run();
    await expect(persistAndLogScore(db, 'cand-x', input({ dealId: 'cand-x' }), RULESET, RCT)).rejects.toThrow(/capital_config is empty/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get() as { n: number }).n).toBe(0);
  });
});

// ── Refute H1: an UNEVALUATED DSCR governor / yield floor must not reach BUY. A deal with
// stabilizedYoc = null scores T2 WATCH (yield floor indeterminate ⇒ capped, not KILLED) with
// governor_dscr_cleared NULL, while the same deal with a known low YoC is KILLED.
const NULL_YOC = {
  stabilizedYoc: null, allInBasis: 1_500_000, clearHeightFt: 24, yearBuilt: 2005, waltYears: 0.5,
  marketRentPsf: 9, officePct: 0.05, valueAddScore: 1, sellerMotivationScore: 1,
};

describe('BUY gate — unevaluated DSCR governor / yield floor (refute H1)', () => {
  it('precondition: the null-YoC deal is a real WATCH ≥ 70 with an unevaluated yield floor', () => {
    const s = scoreAcquisition(input(NULL_YOC), RULESET, { rct: RCT });
    expect(s.verdict).toBe('WATCH');
    expect(s.composite).toBeGreaterThanOrEqual(70);
    expect(s.floors.find((f) => f.id === 'yield')!.actual).toBeNull();
  });

  it('stabilizedYoc = null (governor_dscr_cleared NULL, yield floor not evaluated) is NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-null-yoc', NULL_YOC);
    const row = db.prepare('SELECT governor_dscr_cleared AS g FROM acq_scores WHERE candidate_id = ?').get('cand-null-yoc') as { g: number | null };
    expect(row.g).toBeNull();
    expect((await buy(db)).buyVerdicts).toHaveLength(0);
  });

  it('a NULL governor_dscr_cleared alone blocks BUY even on an otherwise clean row', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-dscr-null');
    mutateLatest(db, 'cand-dscr-null', 'governor_dscr_cleared = NULL');
    expect((await buy(db)).buyVerdicts).toHaveLength(0);
  });

  it('no false negative: the clean strong deal (dscr 1, ltv NULL, yield passed) is still BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-strong');
    const row = db.prepare('SELECT governor_dscr_cleared AS d, governor_ltv_cleared AS l FROM acq_scores WHERE candidate_id = ?').get('cand-strong') as { d: number; l: number | null };
    expect(row.d).toBe(1);
    expect(row.l).toBeNull();
    expect((await buy(db)).buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-strong']);
  });
});

// ── Refute H2 + #463 (Option A merge, Gabriel 2026-10-15: strictest wins). The inputs_version key
// match still keys on the governor VALUES scoring reads (dscrFloor, ltvCeiling,
// SCREENING_DEBT_CONSTANT), but BUY now ALSO requires #463's version-keyed governorRegime stamp, so
// ANY capital_config write withholds BUY until the deal is re-scored. H2's concern was a SILENT strip;
// the withholding is disclosed (buyGate.staleScores / note + portfolio dataQuality governorRegime).
describe('BUY gate — governor freshness: value-keyed key match AND version-keyed regime stamp (refute H2 + #463)', () => {
  it('a capital_config write to an UNRELATED field WITHHOLDS BUY (disclosed) until the deal is re-scored', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-unrelated');
    const { writeCapitalConfig } = await import('../../server/warehouse/capital-config');
    writeCapitalConfig(db, { dispositionCapRate: 0.06, effectiveFrom: '2026-10-13' }, { rationale: 'test: unrelated field' });
    const { result, buyVerdicts } = await buy(db);
    // Formerly asserted BUY ['pipeline:cand-unrelated'] with staleScores 0 / note null (value-based only).
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
    const flag = result.dataQuality.find((f) => f.field === 'governorRegime');
    expect(flag?.severity).toBe('warn');
    expect(flag?.issue).toMatch(/cand-unrelated/);
    // Re-score under the new version: a new governor-fingerprinted key, freshly stamped -> BUY returns.
    await persistAndLogScore(db, 'cand-unrelated', input({ dealId: 'cand-unrelated' }), RULESET, RCT);
    const after = await buy(db);
    expect(after.buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-unrelated']);
    expect(after.result.buyGate?.staleScores).toBe(0);
    expect(after.result.dataQuality).toEqual([]);
  });

  it('a real DSCR floor change makes the score stale, and the allocation says the stale score was excluded', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-dscr-change');
    const { writeCapitalConfig } = await import('../../server/warehouse/capital-config');
    writeCapitalConfig(db, { dscrFloor: 1.30, effectiveFrom: '2026-10-13' }, { rationale: 'test: DSCR change' });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
  });

  it('a real LTV ceiling change makes the score stale', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-ltv-change');
    const { writeCapitalConfig } = await import('../../server/warehouse/capital-config');
    writeCapitalConfig(db, { ltvCeiling: 0.35, effectiveFrom: '2026-10-13' }, { rationale: 'test: LTV change' });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.staleScores).toBe(1);
  });
});

// ── Refute H3: pipeline items carry the persisted verdict and an explicit buyEligible flag, so the
// Capital Buy Pipeline card and the IC memo never present a legacy T1-next-to-PASS row as a buy.
describe('pipeline items — verdict + buyEligible (refute H3)', () => {
  it('a clean candidate is buyEligible with its verdict; a legacy T1/PASS row is not', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-ok');
    await seedScored(db, 'cand-legacy');
    mutateLatest(db, 'cand-legacy', "verdict = 'PASS'");
    const { result } = await buy(db);
    const ok = result.pipeline.find((p) => p.candidateId === 'cand-ok')!;
    const legacy = result.pipeline.find((p) => p.candidateId === 'cand-legacy')!;
    expect(ok.verdict).toBe('PURSUE');
    expect(ok.buyEligible).toBe(true);
    expect(legacy.tier).toBe('T1');
    expect(legacy.verdict).toBe('PASS');
    expect(legacy.buyEligible).toBe(false);
  });

  it('a composite below the floor is not buyEligible even with a clean WATCH verdict', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-low', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0 });
    const { result } = await buy(db);
    const c = result.pipeline.find((p) => p.candidateId === 'cand-low')!;
    expect(c.verdict).toBe('WATCH');
    expect(c.buyEligible).toBe(false);
  });
});

// ── Refute round 2 T1: an UNKNOWN levered IRR caps at WATCH in the engine (irr floor
// indeterminate) while a known failing IRR is KILLED — it must not reach BUY.
describe('BUY gate — unevaluated IRR floor (refute round 2 T1)', () => {
  it('precondition: leveredIrr = null is a real T2 WATCH ≥ 70 with an indeterminate irr floor', () => {
    const s = scoreAcquisition(input({ leveredIrr: null }), RULESET, { rct: RCT });
    expect(s.verdict).toBe('WATCH');
    expect(s.composite).toBeGreaterThanOrEqual(70);
    expect(s.floors.find((f) => f.id === 'irr')!.actual).toBeNull();
  });

  it('leveredIrr = null is NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-null-irr', { leveredIrr: null });
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-null-irr')!.buyEligible).toBe(false);
    expect(buyVerdicts).toHaveLength(0);
  });

  it('a known passing IRR (0.16 ≥ the 5yr floor) is still BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-irr-ok', { leveredIrr: 0.16 });
    expect((await buy(db)).buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-irr-ok']);
  });
});

// ── Refute round 2 T2 (unknown-by-data items stay buyable, made visible; unresolved DD-critical items and other gate inputs are blocked — #483 below): a WATCH capped for unknown clear height / stories still reaches BUY, but the buy verdict
// and the pipeline item carry the cap reasons as open items instead of silence.
describe('BUY with open items — cap reasons surfaced (refute round 2 T2)', () => {
  it('an unconfirmed Stage-0 gate input (multiStory null) stays BUY and says so', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-gate-unk', { multiStory: null });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(1);
    const v = buyVerdicts[0]!;
    // Refute round 3 V3: display wording for a BUY verdict — the engine's "cannot clear the kill
    // screen" phrasing is parsed but never shown.
    expect(v.reasons).toContain('BUY with open items: Stage-0 gate input unconfirmed — confirm before LOI');
    expect(v.dataQuality.some((f) => f.field === 'openItems' && f.severity === 'warn' && f.issue === 'BUY with open item: Stage-0 gate input unconfirmed — confirm before LOI')).toBe(true);
    const item = result.pipeline.find((p) => p.candidateId === 'cand-gate-unk')!;
    expect(item.openItems).toEqual(['Stage-0 gate input unconfirmed — confirm before LOI']);
    expect(JSON.stringify(v)).not.toContain('cannot clear the kill screen');
  });

  it('unresolved roof / deferred-maintenance capex now hold the deal at WATCH, not BUY (Gabriel 2026-10-17)', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-dd-open', { ddKnown: { flood: true, zoning: true } });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    const item = result.pipeline.find((p) => p.candidateId === 'cand-dd-open')!;
    expect(item.buyEligible).toBe(false);
    expect(item.openItems).toEqual(['DD-critical unresolved: roof, deferred-maintenance-capex']);
    expect(item.buyBlockedBy?.[0]).toMatch(/^DD-critical unresolved: roof, deferred-maintenance-capex — capped at WATCH/);
  });

  it('a clean deal has no open items and no open-items reason', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-clean-open');
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-clean-open')!.openItems).toEqual([]);
    expect(buyVerdicts[0]!.reasons.some((r) => /open items/.test(r))).toBe(false);
    expect(buyVerdicts[0]!.dataQuality.some((f) => f.field === 'openItems')).toBe(false);
  });
});

// ── Issue #483, ratified by Gabriel 2026-10-17 (option 3, middle path): the engine's T2-WATCH caps for
// unresolved DD-critical items (flood, zoning, roof, capex; Gabriel widened it the same day) and for an unconfirmed Stage-0 gate input (other than clear height /
// stories, which are unknown-by-data) also hold a deal at WATCH in capital allocation — it never
// reaches action `buy`. Items unknown-by-data only keep today's behavior (BUY with open items).
describe('BUY gate — DD-critical / gate-indeterminate block (issue #483)', () => {
  const blockedReasons = async (db: WarehouseDb, id: string) =>
    (await buy(db)).result.pipeline.find((p) => p.candidateId === id)!;

  it('precondition: flood+zoning unresolved is a real 80.6 T2 WATCH capped for DD-critical items', () => {
    const s = scoreAcquisition(input({ ddKnown: { flood: false, zoning: false } }), RULESET, { rct: RCT });
    expect(s.composite).toBe(80.6);
    expect(s.verdict).toBe('WATCH');
    expect(s.ddCriticalUnresolved).toEqual(expect.arrayContaining(['flood', 'zoning']));
  });

  it('flood + zoning unresolved (the issue fixture) is NOT buyable and says why', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-fz', { ddKnown: { flood: false, zoning: false } });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    const item = result.pipeline.find((p) => p.candidateId === 'cand-fz')!;
    expect(item.buyEligible).toBe(false);
    expect(item.buyBlockedBy).toEqual(['DD-critical unresolved: flood, zoning, roof, deferred-maintenance-capex — capped at WATCH, not BUY-eligible (Gabriel ruling 2026-10-17, #483)']);
  });

  it('flood alone, or zoning alone, unresolved blocks BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-flood', { ddKnown: { flood: false, zoning: true, roof: true, 'deferred-maintenance-capex': true } });
    await seedScored(db, 'cand-zoning', { ddKnown: { flood: true, zoning: false, roof: true, 'deferred-maintenance-capex': true } });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect((await blockedReasons(db, 'cand-flood')).buyBlockedBy?.[0]).toContain('flood');
    expect((await blockedReasons(db, 'cand-zoning')).buyBlockedBy?.[0]).toContain('zoning');
    expect(result.pipeline.every((p) => p.buyEligible === false)).toBe(true);
  });

  it('sfhaOnPad unconfirmed (null) blocks BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-sfha', { sfhaOnPad: null });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    const item = await blockedReasons(db, 'cand-sfha');
    expect(item.buyEligible).toBe(false);
    expect(item.buyBlockedBy?.[0]).toMatch(/Stage-0 gate input unconfirmed: sfhaOnPad/);
  });

  it('unconfirmed ground-level access blocks BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-access', { hasDock: null, hasDriveIn: null, dockCount: null, driveInCount: null });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect((await blockedReasons(db, 'cand-access')).buyBlockedBy?.[0]).toMatch(/access/);
  });

  it('price unconfirmed (null) blocks BUY — only clearHeightFt / multiStory are exempt', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-price-null', { price: null });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    const item = await blockedReasons(db, 'cand-price-null');
    expect(item.buyEligible).toBe(false);
    if (item.buyBlockedBy !== undefined) expect(item.buyBlockedBy[0]).toMatch(/price/);
  });

  it('gate-capped row with unreadable stored inputs fails closed and says so', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-bad-inputs', { clearHeightFt: null });
    db.prepare(`UPDATE acq_score_inputs SET input_json = '{not json' WHERE id = (SELECT score_input_id FROM acq_scores WHERE candidate_id = ? ORDER BY id DESC LIMIT 1)`).run('cand-bad-inputs');
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect((await blockedReasons(db, 'cand-bad-inputs')).buyBlockedBy?.[0]).toMatch(/unreadable/);
  });

  it('multiStory null AND sfhaOnPad null: the blocking input still blocks', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-mixed', { multiStory: null, sfhaOnPad: null });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    const reason = (await blockedReasons(db, 'cand-mixed')).buyBlockedBy?.[0] ?? '';
    expect(reason).toMatch(/sfhaOnPad/);
    expect(reason).not.toMatch(/multiStory/);
  });

  it('unknown-by-data only (clearHeightFt null) keeps BUY with open items', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-ch-null', { clearHeightFt: null });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-ch-null']);
    const item = result.pipeline.find((p) => p.candidateId === 'cand-ch-null')!;
    expect(item.buyEligible).toBe(true);
    expect(item.buyBlockedBy ?? []).toEqual([]);
    expect(buyVerdicts[0]!.reasons.some((r) => /^BUY with open items: /.test(r))).toBe(true);
  });

  it('multiStory null + clearHeightFt null together keep BUY with open items', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-unk-both', { multiStory: null, clearHeightFt: null });
    expect((await buy(db)).buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-unk-both']);
  });

  it('roof alone, or capex alone, unresolved blocks BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-roof', { ddKnown: { flood: true, zoning: true, 'deferred-maintenance-capex': true } });
    await seedScored(db, 'cand-capex', { ddKnown: { flood: true, zoning: true, roof: true } });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect((await blockedReasons(db, 'cand-roof')).buyBlockedBy?.[0]).toContain('roof');
    expect((await blockedReasons(db, 'cand-capex')).buyBlockedBy?.[0]).toContain('deferred-maintenance-capex');
  });

  it('a blocked high-composite WATCH is skipped; the next eligible candidate is the BUY', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-blocked', { ddKnown: { flood: false, zoning: false } });  // 80.6
    await seedScored(db, 'cand-ok', { clusterTier: 'entry' });                              // 74.6 WATCH, no cap
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-ok']);
  });

  it('a KILLED or PASS candidate with flood open is not labelled "held at WATCH" (refute wf_b5402308-51f)', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-killed', { productType: 'office-only', ddKnown: {} });
    await seedScored(db, 'cand-pass', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0, clearHeightFt: 16, truckCourtFt: 50, dockCount: 1, driveInCount: 1, inPlaceRentPsf: 6, marketRentPsf: 6, waltYears: 6, ddKnown: {} });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    for (const id of ['cand-killed', 'cand-pass']) {
      const item = result.pipeline.find((p) => p.candidateId === id)!;
      expect(item.buyEligible).toBe(false);
      expect(item.buyBlockedBy).toBeUndefined();
    }
  });

  it('the blocked candidate is the ONLY one: no buy verdict is emitted at all', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-only-blocked', { ddKnown: { flood: false, zoning: false } });
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.actionCounts.buy).toBe(0);
  });
});

// ── Refute round 2 T3: the buyGate note never claims "BUY suppressed" (a BUY may still be emitted),
// counts only rows that would otherwise be T1/T2 PURSUE/WATCH, and names the EXISTING re-score
// route instead of an uncallable function.
describe('buyGate note wording + counting (refute round 2 T3)', () => {
  function bump(db: WarehouseDb): void {
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-10-13', 1.30, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor bump')`,
    ).run();
  }

  it('with a BUY still emitted, the note reports the excluded stale score without saying "suppressed"', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-stale-pursue');            // scored under v1 → stale after bump
    bump(db);
    await seedScored(db, 'cand-fresh-pursue');            // scored under v2 → current
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-fresh-pursue']);
    const note = result.buyGate!.suppressedNote!;
    expect(note).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
    expect(note).not.toMatch(/suppressed/i);
    expect(note).toContain('POST /api/warehouse/acq/score/:candidateId');
    expect(note).not.toContain('rescoreStaleCandidates');
  });

  it('a stale row that would NOT otherwise be T1/T2 PURSUE/WATCH is not counted', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-stale-killed', { leveredIrr: 0.05 });   // real KILLED
    await seedScored(db, 'cand-stale-low', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0, clearHeightFt: 16, truckCourtFt: 50, dockCount: 1, driveInCount: 1, inPlaceRentPsf: 6, marketRentPsf: 6, waltYears: 6 }); // real PASS
    bump(db);
    const { result } = await buy(db);
    expect(result.buyGate!.staleScores).toBe(0);
    expect(result.buyGate!.unparseableScores).toBe(0);
    expect(result.buyGate!.suppressedNote).toBeNull();
  });
});

// ── Refute round 3 V1: a stored composite the live engine no longer reproduces must not drive BUY.
describe('BUY gate — engine-output freshness (refute round 3 V1)', () => {
  it('a real WATCH whose stored composite was 71.6 (live engine: 63.6) is stale and NOT buyable', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-engine-drift', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0 });
    mutateLatest(db, 'cand-engine-drift', "composite = 71.6, score_json = json_set(score_json, '$.composite', 71.6)");
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-engine-drift')!.buyEligible).toBe(false);
    expect(result.buyGate!.staleScores).toBe(1);
  });
});

// ── Refute round 3 V2: the single portfolio BUY is chosen verdict-first (PURSUE before WATCH), then
// candidates without open items, then composite DESC, then candidateId — never composite alone, so a
// capped WATCH with open DD-critical items cannot outrank a clean PURSUE. Eligibility is unchanged.
describe('portfolio BUY selection order (refute round 3 V2)', () => {
  it('a clean PURSUE beats a higher-composite capped WATCH with open items', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-clean-pursue', { clusterTier: 'established' });               // 77.6 T1 PURSUE
    await seedScored(db, 'cand-capped-watch', { multiStory: null });   // T2 WATCH, open items (unknown-by-data)
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-capped-watch')!.buyEligible).toBe(true);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-clean-pursue']);
  });

  it('among WATCHes, one without open items beats a higher-composite one with open items', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-watch-clean', { clusterTier: 'entry' });                     // 74.6 T2 WATCH, no cap
    await seedScored(db, 'cand-watch-open', { multiStory: null });    // WATCH, open items (unknown-by-data)
    const { result, buyVerdicts } = await buy(db);
    expect(result.pipeline.find((p) => p.candidateId === 'cand-watch-clean')!.openItems).toEqual([]);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-watch-clean']);
  });

  it('with only the capped WATCH it is still BUY, with open items', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-only-capped', { multiStory: null });
    const { buyVerdicts } = await buy(db);
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual(['pipeline:cand-only-capped']);
    expect(buyVerdicts[0]!.reasons.some((r) => /^BUY with open items: /.test(r))).toBe(true);
  });
});

// ── Merge review C7 (Option A merge with #463): buyGate counting keeps the branch's refute round 2 T3
// rule — every stale row that would otherwise be T1/T2 PURSUE/WATCH is counted and noted — PLUS
// #463's demoted-PASS case. The #463 dataQuality governorRegime flag keeps main's narrower predicate
// (composite >= floor, eligible on its face or a demoted PASS, basis floor passed). Every candidate the
// flag names must also be counted in buyGate.
describe('buyGate counting vs #463 dataQuality after a governor change (merge review C7)', () => {
  async function dscrChange(db: WarehouseDb): Promise<void> {
    const { writeCapitalConfig } = await import('../../server/warehouse/capital-config');
    writeCapitalConfig(db, { dscrFloor: 1.30, effectiveFrom: '2026-10-13' }, { rationale: 'test: DSCR change' });
  }
  /** Set the latest row's persisted basis floor actual to null (indeterminate basis) in score_json. */
  function nullBasis(db: WarehouseDb, id: string): void {
    const row = db
      .prepare('SELECT id, score_json FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
      .get(id) as { id: number; score_json: string };
    const blob = JSON.parse(row.score_json) as { floors: Array<Record<string, unknown>> };
    blob.floors = blob.floors.map((f) => (f['id'] === 'basis' ? { ...f, actual: null } : f));
    db.prepare('UPDATE acq_scores SET score_json = ? WHERE id = ?').run(JSON.stringify(blob), row.id);
  }
  const govFlagIds = (dq: ReadonlyArray<{ field: string; issue: string }>, ids: readonly string[]): string[] => {
    const issue = dq.find((f) => f.field === 'governorRegime')?.issue ?? '';
    return ids.filter((id) => issue.includes(id));
  };

  it('control: a clean strong candidate made stale is counted in buyGate AND named in dataQuality', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-c7-clean');
    await dscrChange(db);
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
    expect(govFlagIds(result.dataQuality, ['cand-c7-clean'])).toEqual(['cand-c7-clean']);
  });

  it('P1: a coherent T2 WATCH at composite < 70 made stale is counted with the note (a re-score could lift it); not in dataQuality', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-c7-watch65', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0 });
    const pre = db.prepare('SELECT tier, verdict, composite FROM acq_scores WHERE candidate_id = ?').get('cand-c7-watch65') as { tier: string; verdict: string; composite: number };
    expect([pre.tier, pre.verdict]).toEqual(['T2', 'WATCH']);
    expect(pre.composite).toBeLessThan(70);
    await dscrChange(db);
    const { result } = await buy(db);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
    expect(result.dataQuality).toEqual([]);
  });

  it('P2: a T1 PURSUE with an indeterminate (null) basis made stale is counted; not in dataQuality', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-c7-nullbasis');
    nullBasis(db, 'cand-c7-nullbasis');
    await dscrChange(db);
    const { result } = await buy(db);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).not.toBeNull();
    expect(result.dataQuality).toEqual([]);
  });

  it('P3: an advisory_only = 1 T1 PURSUE made stale is counted; not in dataQuality', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-c7-advisory');
    mutateLatest(db, 'cand-c7-advisory', 'advisory_only = 1');
    await dscrChange(db);
    const { result } = await buy(db);
    expect(result.buyGate?.staleScores).toBe(1);
    expect(result.buyGate?.suppressedNote).not.toBeNull();
    expect(result.dataQuality).toEqual([]);
  });

  it('invariant: every id named in the dataQuality governorRegime flag is counted in buyGate', async () => {
    const db = freshDb();
    const ids = ['cand-c7-i-clean', 'cand-c7-i-watch65', 'cand-c7-i-nullbasis', 'cand-c7-i-advisory'];
    await seedScored(db, ids[0]!);
    await seedScored(db, ids[1]!, { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0 });
    await seedScored(db, ids[2]!);
    nullBasis(db, ids[2]!);
    await seedScored(db, ids[3]!);
    mutateLatest(db, ids[3]!, 'advisory_only = 1');
    await dscrChange(db);
    const { result } = await buy(db);
    const flagged = govFlagIds(result.dataQuality, ids);
    expect(flagged).toEqual(['cand-c7-i-clean']);
    const counted = (result.buyGate?.staleScores ?? 0) + (result.buyGate?.unparseableScores ?? 0);
    expect(counted).toBe(4);
    expect(counted).toBeGreaterThanOrEqual(flagged.length);
  });
});

// ── Squash review C2: this branch's G1 tier alignment writes tier = 'PASS' on a governor demotion,
// so the #463 "stale demoted PASS" disclosure must not key on tier T1/T2 alone. These rows are REAL,
// UNMUTATED persistAndLogScore output under a governor set that demotes, followed by a repaired set.
// (dscr_floor below 1.25 cannot be written — 003_capital_config CHECK — so the two demotion paths
// are the fail-closed invalid set (ltv_ceiling 0) and a genuine DSCR-proxy miss (dscr_floor 4.0).)
describe('stale governor-demoted PASS written by the live engine (squash review C2)', () => {
  function insertConfig(db: WarehouseDb, version: number, dscrFloor: number, ltvCeiling: number): void {
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (?, '2026-10-14', ?, ?, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor set')`,
    ).run(version, dscrFloor, ltvCeiling);
  }

  for (const [label, demotingDscr, demotingLtv] of [
    ['invalid governor set (ltv_ceiling 0, fail-closed demotion)', 1.25, 0],
    ['genuine DSCR-proxy miss (dscr_floor 4.0)', 4.0, 0.40],
  ] as const) {
    it(`${label}: demoted row is counted, noted and named while stale; BUY withheld until re-score`, async () => {
      const db = freshDb();
      const id = 'cand-c2-demoted';
      insertConfig(db, 2, demotingDscr, demotingLtv);
      await seedScored(db, id);
      const row = db.prepare('SELECT tier, verdict, composite, governor_dscr_cleared AS d, score_json FROM acq_scores WHERE candidate_id = ?')
        .get(id) as { tier: string; verdict: string; composite: number; d: number | null; score_json: string };
      // What the live engine writes for a demotion (G1): tier follows the verdict to PASS.
      expect([row.tier, row.verdict, row.d]).toEqual(['PASS', 'PASS', 0]);
      expect(row.composite).toBeGreaterThanOrEqual(70);
      expect((JSON.parse(row.score_json) as { reasons: string[] }).reasons.some((r) => r.startsWith('Governor demotion:'))).toBe(true);

      insertConfig(db, 3, 1.25, 0.40); // repaired governor set
      const { result, buyVerdicts } = await buy(db);
      expect(buyVerdicts).toHaveLength(0);
      expect(result.buyGate?.staleScores).toBe(1);
      expect(result.buyGate?.suppressedNote).toMatch(/^1 stale\/unparseable score excluded from the BUY gate/);
      expect(result.dataQuality.find((f) => f.field === 'governorRegime')?.issue).toMatch(/cand-c2-demoted/);

      await persistAndLogScore(db, id, input({ dealId: id }), RULESET, RCT); // re-score under v3
      const after = await buy(db);
      expect(after.buyVerdicts.map((v) => v.propertyId)).toEqual([`pipeline:${id}`]);
      expect(after.result.buyGate?.staleScores).toBe(0);
      expect(after.result.dataQuality).toEqual([]);
    });
  }

  it('a demoted PASS that is still CURRENT (the demoting regime is live) is neither counted nor named', async () => {
    const db = freshDb();
    insertConfig(db, 2, 4.0, 0.40);
    await seedScored(db, 'cand-c2-current-demoted');
    const { result, buyVerdicts } = await buy(db);
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.staleScores).toBe(0);
    expect(result.buyGate?.suppressedNote).toBeNull();
    expect(result.dataQuality).toEqual([]);
  });

  it('a natively-scored PASS (no governor demotion) made stale is not counted or named', async () => {
    const db = freshDb();
    await seedScored(db, 'cand-c2-native-pass', { clusterTier: 'entry', valueAddScore: 0, sellerMotivationScore: 0, clearHeightFt: 16, truckCourtFt: 50, dockCount: 1, driveInCount: 1, inPlaceRentPsf: 6, marketRentPsf: 6, waltYears: 6 });
    const row = db.prepare('SELECT verdict, score_json FROM acq_scores WHERE candidate_id = ?').get('cand-c2-native-pass') as { verdict: string; score_json: string };
    expect(row.verdict).toBe('PASS');
    expect((JSON.parse(row.score_json) as { reasons: string[] }).reasons.some((r) => r.startsWith('Governor demotion:'))).toBe(false);
    insertConfig(db, 2, 1.30, 0.40);
    const { result } = await buy(db);
    expect(result.buyGate?.staleScores).toBe(0);
    expect(result.dataQuality).toEqual([]);
  });
});
