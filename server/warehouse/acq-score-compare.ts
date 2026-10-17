// server/warehouse/acq-score-compare.ts
//
// Audit 2026-10-13 Wave 2a X1/X2 — the ONE comparison between a persisted acquisition score and the
// live engine's output for the same stored input. Shared by:
//   - acq-score-freshness.ts (classify: a mismatch makes the latest row 'stale'), and
//   - acq-engine.ts persistAndLogScore (a mismatch on an existing dedup key SUPERSEDES that row in
//     place, because UNIQUE(score_input_id) forbids a second row for the same input snapshot).
// Keeping both on one function means "stale" and "would be superseded" can never disagree.
//
// inputs_version hashes input + ruleset + RCT + governor fingerprint, NOT engine code, so an
// engine-logic change that moves any decision-relevant output under an unchanged ruleset leaves the
// key identical. Every field compared here is one a reader acts on: the ranked list (composite, tier,
// verdict), the BUY gate (verdict, tier, gates, floors, advisory_only, both governor flags) and the BUY
// open-items disclosure (the cap-reason line, cappedAtT2, ddCriticalUnresolved, floorIndeterminate).
//
// FINANCIAL-DECISION CODE (feeds the capital BUY gate) — refute pass required before merge.
import type { AcquisitionScore } from '../../src/contracts/acquisition';

/** The live engine's output for one stored input, after the SAME governor proxy persistence applies. */
export interface LiveEngineOutput {
  /** Post-governor-proxy score (verdict/tier demoted together, demotion reason appended). */
  governed: AcquisitionScore;
  /** applyGovernorProxyToScore's DSCR flag: true cleared / false failed / null not evaluated. */
  governorDscrCleared: boolean | null;
  /** applyGovernorProxyToScore's LTV flag (indeterminate at screen time today: null). */
  governorLtvCleared: boolean | null;
}

/** Denormalized acq_scores columns. Each is optional: undefined = the caller did not select it (not checked). */
export interface StoredScoreColumns {
  composite?: number | null;
  tier?: string | null;
  verdict?: string | null;
  advisory_only?: number | null;
  capped_at_t2?: number | null;
  floor_indeterminate?: number | null;
  governor_dscr_cleared?: number | null;
  governor_ltv_cleared?: number | null;
  gates_passed?: number | null;
  floors_passed?: number | null;
}

/** The engine's single cap-reason line ("Capped T1 → T2: …" or "Notes: …"), verbatim, or null. */
export function capReasonLine(score: Pick<AcquisitionScore, 'reasons'>): string | null {
  return score.reasons.find((r) => /^(?:Capped T1 → T2|Notes): /.test(r)) ?? null;
}

const flag = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0);

/**
 * Every decision-relevant difference between the stored row (columns + parsed score_json) and the
 * live output. Empty = the stored output is reproduced exactly. A column the caller did not select
 * (undefined) is skipped; a selected column must equal the live value (null included).
 */
export function storedVsLiveDiffs(
  cols: StoredScoreColumns,
  stored: AcquisitionScore,
  live: LiveEngineOutput,
): string[] {
  const g = live.governed;
  const diffs: string[] = [];
  const col = <T>(name: string, v: T | undefined, want: T): void => {
    if (v !== undefined && v !== want) diffs.push(`${name} column ${String(v)} vs live ${String(want)}`);
  };
  const json = <T>(name: string, v: T, want: T): void => {
    if (v !== want) diffs.push(`${name} ${String(v)} vs live ${String(want)}`);
  };

  col('composite', cols.composite, g.composite);
  json('composite', stored.composite, g.composite);
  col('tier', cols.tier, g.tier);
  json('tier', stored.tier, g.tier);
  col('verdict', cols.verdict, g.verdict);
  json('verdict', stored.verdict, g.verdict);

  const floorKey = (fs: AcquisitionScore['floors']) => JSON.stringify(fs.map((f) => [f.id, f.passed, f.actual]));
  if (floorKey(stored.floors) !== floorKey(g.floors)) diffs.push('floors (id/passed/actual) differ');
  // Stage-0 gates (refute W2a follow-up b): a gate flip is a KILL / un-KILL and the pass flags are
  // persisted columns, so they are compared like every other decision field.
  const gateKey = (gs: AcquisitionScore['gates']) => JSON.stringify(gs.map((x) => [x.id, x.passed]));
  if (gateKey(stored.gates) !== gateKey(g.gates)) diffs.push('gates (id/passed) differ');
  col('gates_passed', cols.gates_passed, flag(g.gatesPassed));
  json('gatesPassed', stored.gatesPassed, g.gatesPassed);
  col('floors_passed', cols.floors_passed, flag(g.floorsPassed));
  json('floorsPassed', stored.floorsPassed, g.floorsPassed);

  // X2 — the BUY open-items disclosure and the gate's own inputs.
  const storedCap = capReasonLine(stored);
  const liveCap = capReasonLine(g);
  if (storedCap !== liveCap) diffs.push(`cap reasons ${JSON.stringify(storedCap)} vs live ${JSON.stringify(liveCap)}`);
  col('capped_at_t2', cols.capped_at_t2, flag(g.cappedAtT2));
  json('cappedAtT2', stored.cappedAtT2, g.cappedAtT2);
  if (JSON.stringify(stored.ddCriticalUnresolved) !== JSON.stringify(g.ddCriticalUnresolved)) {
    diffs.push(`ddCriticalUnresolved ${JSON.stringify(stored.ddCriticalUnresolved)} vs live ${JSON.stringify(g.ddCriticalUnresolved)}`);
  }
  col('floor_indeterminate', cols.floor_indeterminate, flag(g.floorIndeterminate));
  json('floorIndeterminate', stored.floorIndeterminate, g.floorIndeterminate);
  col('advisory_only', cols.advisory_only, flag(g.advisoryOnly));
  json('advisoryOnly', stored.advisoryOnly, g.advisoryOnly);
  col('governor_dscr_cleared', cols.governor_dscr_cleared, flag(live.governorDscrCleared));
  col('governor_ltv_cleared', cols.governor_ltv_cleared, flag(live.governorLtvCleared));
  return diffs;
}
