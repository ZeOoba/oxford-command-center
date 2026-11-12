// scripts/calibration-refit.ts
//
// OFFLINE calibration RE-FIT — spec §4.3. Reads resolved calibration outcomes and PROPOSES
// recalibrated health weights as a REPORT ONLY. Run on demand, NEVER in the live request path.
//
// ── THE HARD LINE (do not soften) ────────────────────────────────────────────────────────────
// This script is ADVISORY. It NEVER writes server/warehouse/intel-config.ts, NEVER writes ANY
// governor or served-config file, and NEVER touches the DSCR 1.25 / LTV 0.40 governors (which are
// not "scores" and are out of scope entirely). A weight change is a separate, human-ratified,
// hook-gated edit that ONLY Gabriel makes. proposeRefit() is a PURE function with ZERO filesystem
// side effects; the CLI prints the proposal to stdout (or, only with an explicit --out to a NON-
// served path, writes a standalone report file — never config). The anti-overfit governor on the
// calibration process ITSELF is baked in: weights sum to 1.0 and no single weight moves more than
// ±MAX_WEIGHT_MOVE per run.
//
// Invoke: `npx tsx scripts/calibration-refit.ts [--db <path>] [--out <report-path>]`
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { calibrationReport } from '../server/warehouse/calibration';
import { INTEL_CONFIG } from '../server/warehouse/intel-config';
import { refuseIfSynthetic } from '../server/real-data-status';

/** The anti-overfit governor on the calibration PROCESS: no single weight may move more than this
 *  per re-fit (spec §4.3, "no single weight moves more than ±0.05/year"). */
export const MAX_WEIGHT_MOVE = 0.05;

/** Minimum resolved + scoreable outcomes before a re-fit is anything but a no-op. Below this the
 *  proposal echoes the current weights with an explicit "still accumulating" caveat (spec §6: the
 *  first ~5 years are data-accumulation, not actionable calibration). */
export const MIN_SCOREABLE = 12;

type WeightMap = Record<string, number>;

export interface RefitProposal {
  generatedAt: string;
  sufficientData: boolean;
  scoreableOutcomes: number;
  /** The current RATIFIED weights (verbatim from intel-config.ts) — the baseline, never edited here. */
  currentWeights: WeightMap;
  /** The PROPOSED weights — sum 1.0, each within ±MAX_WEIGHT_MOVE of current. Advisory only. */
  proposedWeights: WeightMap;
  /** Per-weight current→proposed delta, for the memo. */
  deltas: Array<{ weight: string; current: number; proposed: number; delta: number }>;
  /** The evidence the proposal rests on (per-kind directional hit-rate + Wilson bounds). */
  evidence: Array<{ verdictKind: string; scoreable: number; hitRate: number | null; directionalAccuracy: number | null; wilsonLow: number | null; wilsonHigh: number | null }>;
  note: string;
}

/** Round to 4 dp to keep the proposal readable and stable (weights are coarse by design). */
function r4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Read a weight, treating a missing key as 0 (defensive under noUncheckedIndexedAccess). */
function g(map: WeightMap, key: string): number {
  return map[key] ?? 0;
}

/**
 * Propose recalibrated health weights from the resolved calibration log. PURE — no filesystem, no
 * mutation of intel-config or the served config. The mechanism is deliberately CONSERVATIVE for the
 * Phase-2 small-N / short-history regime (spec §6):
 *   • Below MIN_SCOREABLE resolved outcomes → echo current weights, sufficientData=false (a no-op).
 *   • Otherwise compute a single global trust signal (overall directional/hit performance vs a 0.5
 *     coin-flip baseline) and nudge weight MASS, clamped to ±MAX_WEIGHT_MOVE per weight, then
 *     renormalize to sum 1.0. We do NOT pretend to a per-sub-score re-fit the data cannot yet support;
 *     the structural guarantees (cap + sum + human ratification) are what matter, and they hold here.
 */
export function proposeRefit(db: WarehouseDb): RefitProposal {
  const report = calibrationReport(db);
  const current: WeightMap = { ...(INTEL_CONFIG.healthWeights as Record<string, number>) };
  const evidence = report.byKind.map((k) => ({
    verdictKind: k.verdictKind,
    scoreable: k.scoreable,
    hitRate: k.hitRate,
    directionalAccuracy: k.directionalAccuracy,
    wilsonLow: k.wilsonLow,
    wilsonHigh: k.wilsonHigh,
  }));

  const baseProposal = {
    generatedAt: new Date().toISOString(),
    currentWeights: { ...current },
    evidence,
  };

  if (report.scoreableVerdicts < MIN_SCOREABLE || report.overallHitRate === null) {
    return {
      ...baseProposal,
      sufficientData: false,
      scoreableOutcomes: report.scoreableVerdicts,
      proposedWeights: { ...current },
      deltas: Object.keys(current).map((w) => ({ weight: w, current: g(current, w), proposed: g(current, w), delta: 0 })),
      note:
        `Insufficient resolved data for a re-fit (${report.scoreableVerdicts} scoreable < ${MIN_SCOREABLE} required). `
        + 'The calibration log is still accumulating — the first ~5 years are data-accumulation, not '
        + 'actionable calibration (spec §6). Weights returned UNCHANGED. No proposal is being made.',
    };
  }

  // The single trust signal: how far overall hit-rate beats a coin flip, in [-0.5, +0.5]. A reliable
  // engine (>0.5) shifts a little weight mass toward the highest-conviction NOI signals; an unreliable
  // one (<0.5) flattens toward an even split. This is a coarse, conservative nudge — the point is the
  // CLAMP + RENORMALIZE machinery and the human ratification gate, not an aggressive optimizer.
  const edge = report.overallHitRate - 0.5; // (-0.5 .. +0.5)
  // Direction of the nudge: toward `noiGrowth` (the compounding-engine sub-score) when the engine is
  // trustworthy, away from it (toward uniform) when it is not. Magnitude scaled and HARD-CLAMPED.
  const keys = Object.keys(current);
  const uniform = 1 / keys.length;
  const lambda = Math.max(-1, Math.min(1, edge * 2)) * 0.5; // (-0.5 .. +0.5) blend toward target

  const target: WeightMap = {};
  for (const k of keys) {
    // Trustworthy → lean toward current emphasis sharpened on noiGrowth; untrustworthy → toward uniform.
    const sharpen = k === 'noiGrowth' ? g(current, k) + 0.05 : g(current, k);
    target[k] = lambda >= 0 ? sharpen : uniform;
  }

  // Blend current → target by |lambda|, then CLAMP each move to ±MAX_WEIGHT_MOVE.
  const clamped: WeightMap = {};
  for (const k of keys) {
    const desired = g(current, k) + Math.abs(lambda) * (g(target, k) - g(current, k));
    const move = Math.max(-MAX_WEIGHT_MOVE, Math.min(MAX_WEIGHT_MOVE, desired - g(current, k)));
    clamped[k] = Math.max(0, g(current, k) + move);
  }

  // RENORMALIZE to sum 1.0 (the renorm can nudge a weight slightly past the raw ±0.05 vs current;
  // re-clamp once post-norm so the hard invariant "no weight moves > ±0.05 from current" holds).
  const norm = (w: WeightMap): WeightMap => {
    const s = Object.values(w).reduce((a, b) => a + b, 0);
    if (s <= 0) return { ...current };
    const out: WeightMap = {};
    for (const k of keys) out[k] = g(w, k) / s;
    return out;
  };
  let proposed = norm(clamped);
  // Post-norm re-clamp against CURRENT (the invariant the test enforces), then one final renorm. A
  // few passes converge well within FP tolerance for these small moves.
  for (let pass = 0; pass < 3; pass++) {
    const reclamped: WeightMap = {};
    for (const k of keys) {
      const move = Math.max(-MAX_WEIGHT_MOVE, Math.min(MAX_WEIGHT_MOVE, g(proposed, k) - g(current, k)));
      reclamped[k] = Math.max(0, g(current, k) + move);
    }
    proposed = norm(reclamped);
  }

  const proposedRounded: WeightMap = {};
  for (const k of keys) proposedRounded[k] = r4(g(proposed, k));
  // Rounding can shift the sum off 1.0 by ≤ keys*5e-5; absorb the residual into noiGrowth so the
  // emitted proposal sums to EXACTLY 1.0 without breaking the ±0.05 cap (residual << 0.05).
  const roundedSum = Object.values(proposedRounded).reduce((a, b) => a + b, 0);
  proposedRounded.noiGrowth = r4(g(proposedRounded, 'noiGrowth') + (1 - roundedSum));

  const deltas = keys.map((w) => ({
    weight: w,
    current: r4(g(current, w)),
    proposed: g(proposedRounded, w),
    delta: r4(g(proposedRounded, w) - g(current, w)),
  }));

  return {
    ...baseProposal,
    sufficientData: true,
    scoreableOutcomes: report.scoreableVerdicts,
    proposedWeights: proposedRounded,
    deltas,
    note:
      `PROPOSAL ONLY — advisory, NOT applied. Based on ${report.scoreableVerdicts} scoreable resolved `
      + `outcomes (overall hit-rate ${(report.overallHitRate * 100).toFixed(1)}%). Every weight move is `
      + `clamped to ±${MAX_WEIGHT_MOVE} and the set sums to 1.0. To ADOPT, Gabriel makes a separate, `
      + 'hook-gated, refute-reviewed edit to server/warehouse/intel-config.ts. This script never writes it, '
      + 'and never touches the DSCR 1.25 / LTV 0.40 governors (out of scope).',
  };
}

/** Render the proposal as a human-readable memo (the "Proposed Weight Change Memo", §4.3). */
export function formatProposal(p: RefitProposal): string {
  const lines: string[] = [];
  lines.push('═══ Calibration Re-Fit — Proposed Weight Change Memo (ADVISORY) ═══');
  lines.push(`generated: ${p.generatedAt}`);
  lines.push(`scoreable resolved outcomes: ${p.scoreableOutcomes}`);
  lines.push(`sufficient data: ${p.sufficientData ? 'YES' : 'NO — no proposal'}`);
  lines.push('');
  lines.push('weight                   current   proposed    delta');
  for (const d of p.deltas) {
    const sign = d.delta > 0 ? '+' : '';
    lines.push(`${d.weight.padEnd(24)} ${d.current.toFixed(4)}   ${d.proposed.toFixed(4)}   ${sign}${d.delta.toFixed(4)}`);
  }
  const sum = p.deltas.reduce((a, d) => a + d.proposed, 0);
  lines.push(`${'(sum)'.padEnd(24)} ${'1.0000'}             ${sum.toFixed(4)}`);
  lines.push('');
  lines.push('evidence (per verdict kind):');
  for (const e of p.evidence) {
    const hr = e.hitRate === null ? 'n/a' : `${(e.hitRate * 100).toFixed(0)}%`;
    const da = e.directionalAccuracy === null ? 'n/a' : `${(e.directionalAccuracy * 100).toFixed(0)}%`;
    lines.push(`  ${e.verdictKind.padEnd(18)} n=${e.scoreable}  hit=${hr}  dir=${da}`);
  }
  lines.push('');
  lines.push(p.note);
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
/** A path is rejected as an output target if it looks like a config / governor / served file. The
 *  refit may emit only a standalone report — never config. Belt-and-suspenders over the doctrine. */
export function isForbiddenOutPath(p: string): boolean {
  const b = basename(p).toLowerCase();
  return /intel-config|config|governor|overlay|settings|intel_config|\.env/.test(b);
}

function parseArgs(argv: string[]): { db?: string; out?: string } {
  const out: { db?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function main(argv: string[]): number {
  // Writes the warehouse from inputs that may be synthetic stand-ins: never on synthetic data outside
  // CI / tests (refute round 4 F8).
  refuseIfSynthetic('calibration-refit');
  const args = parseArgs(argv);
  const dbPath = args.db ?? 'data/warehouse.sqlite';
  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const proposal = proposeRefit(db);
  const memo = formatProposal(proposal);
  console.log(memo);

  if (args.out) {
    if (isForbiddenOutPath(args.out)) {
      console.error(`REFUSED: --out ${args.out} looks like a config/governor/served file. The refit emits a report ONLY.`);
      return 2;
    }
    // A standalone report file (JSON + memo). NEVER intel-config.ts, NEVER served config.
    writeFileSync(args.out, `${memo}\n\n${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    console.log(`\nproposal written to ${args.out} (report only — config untouched).`);
  }
  return 0;
}

// Run the CLI only when invoked directly (importing for tests must NOT open a db or write anything).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/calibration-refit.ts')) {
  process.exit(main(process.argv.slice(2)));
}
