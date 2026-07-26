// scripts/check-refute-required.ts
//
// Enforce the Engineering-OS doctrine (architecture/coding-standards.md): a change to
// financial-decision SOURCE — engine math / scoring / NOI / collections conditions / the financial
// overlay — must carry a `Refute-Reviewed:` (or, with justification, `Refute-Skip:`) commit trailer
// attesting that the refute-financial-change adversarial pass ran on it. Turns the written doctrine
// into a mechanical check so it cannot silently lapse.
//
// Default mode WARNS and exits 0 (local dev — never blocks WIP). `--strict` EXITS 1 on a violation
// (wired into CI for PRs; also usable from /ship). Fails OPEN on any git/tooling gap.
//
// Usage: tsx scripts/check-refute-required.ts [--strict] [--base=<ref>]
//   base defaults to $REFUTE_BASE, else 'origin/main'.
//
// Exported functions are pure (no I/O) so they unit-test without the process.exit side effects —
// the bottom-of-file guard runs main() only when executed directly (mirrors governance-check.ts).
import { execFileSync } from 'node:child_process';

// Pure route-plumbing / dispatch files in server/warehouse/ that contain no financial math —
// subtracted from the broad prefix. Fail-CLOSED elsewhere: any warehouse file NOT listed here
// still requires a refute trailer. See architecture/coding-standards.md.
// NOTE: actions.ts dispatches recompute (scoreProperties/detectAnomalies) but holds no math;
// re-evaluate this entry if it gains analytic logic.
export const DELIVERY_ONLY_PATHS: ReadonlySet<string> = new Set([
  'server/warehouse/api.ts',
  'server/warehouse/debt-api.ts',
  'server/warehouse/actions.ts',
  // Phase 3 W1: pure route-plumbing/dispatch; no financial math (math lives in
  // src/analytics/lease-forecast.ts and server/warehouse/lease-velocity.ts).
  'server/warehouse/lease-forecast-api.ts',
  // Phase 5: pure route-plumbing; financial math lives in capital-allocation.ts + market-intel.ts.
  'server/warehouse/capital-allocation-api.ts',
  // Phase 5 W4: pure property-registration write; no financial math.
  'server/warehouse/property-onboarding.ts',
  // Direction 2: pure HTML IC-Memo renderer; all financial math lives in buildPortfolioAllocation
  // (capital-allocation.ts). This file only formats PortfolioAllocation for print-to-PDF.
  'server/warehouse/ic-memo.ts',
]);

// Financial CONTRACT schemas (2026-07-24, PR #233 follow-up): a Zod contract change can carry
// direct governor blast radius — the LTV-bound episode put a magnitude bound on loan.ts's ltv
// field that made ONE bad workbook cell fail the ENTIRE portfolio snapshot parse, and the same
// field feeds computePortfolioAggregateLtv's Hard-Invariant-4 verdict. Yet no contracts file
// required a refute trailer: this gate had the same file-enumeration blind spot the weekly
// sweep's path list did. Enumerated (not the whole src/contracts/ dir) because most contracts
// there are non-financial plumbing (lease, property, insurance display shapes) — these four are
// the ones whose fields are consumed by governor/scoring math.
const FINANCIAL_CONTRACT_PATHS: ReadonlySet<string> = new Set([
  'src/contracts/loan.ts',
  'src/contracts/debt.ts',
  'src/contracts/warehouse.ts',
  'src/contracts/macro.ts',
  // Round-9 (fifth adversarial pass — all three lenses flagged the omission independently, one
  // by executing this very function): capital.ts holds HurdleRateConfig, the RATIFIED
  // hurdle-rate governor (bounds + ratification superRefine) consumed by capital-allocation.ts
  // and calibration.ts; capital-allocation.ts is the H6 read boundary bounding the capstone
  // scoring response (priorityScore/debtScore/dscr). Both meet the inclusion criterion above.
  // Evaluated and deliberately NOT included (yet): scenario.ts (alert display thresholds, no
  // governor math consumes its fields directly) and tax.ts (feeds tax-analysis display; add it
  // if a capital-decision path ever branches on its parsed fields — re-evaluate on next sweep).
  'src/contracts/capital.ts',
  'src/contracts/capital-allocation.ts',
]);

/** True when a changed path holds financial-decision SOURCE (not a test / doc / json fixture). */
export function isFinancialSourcePath(p: string): boolean {
  const path = p.replace(/\\/g, '/');
  if (/\.(test|spec)\.(ts|tsx)$/.test(path) || path.endsWith('.md') || path.endsWith('.json')) return false;
  if (DELIVERY_ONLY_PATHS.has(path)) return false;
  return (
    path.startsWith('src/analytics/') ||
    path.startsWith('server/warehouse/') ||
    FINANCIAL_CONTRACT_PATHS.has(path) ||
    path === 'src/brain/anomaly-insights.ts' ||
    path === 'src/brain/principal-digest.ts' ||
    path === 'server/overlay.ts'
  );
}

/** True when a refute attestation trailer appears anywhere in the commit-message blob. */
export function hasRefuteApproval(messageBlob: string): boolean {
  return /(^|\n)\s*Refute-(Reviewed|Skip):/i.test(messageBlob);
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function main(): void {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const base =
    argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
    process.env.REFUTE_BASE ??
    'origin/main';

  let changed: string[];
  let messageBlob: string;
  try {
    changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean);
    messageBlob = git(['log', `${base}..HEAD`, '--format=%B']);
  } catch (err) {
    // No usable base ref (shallow clone, detached HEAD, fresh repo) — never block on a tooling gap.
    console.warn(`check:refute — skipped: could not diff against '${base}' (${(err as Error).message.split('\n')[0]}).`);
    return;
  }

  const financial = changed.filter(isFinancialSourcePath);
  if (financial.length === 0) {
    console.log('check:refute — OK: no financial-decision source files changed in this range.');
    return;
  }
  if (hasRefuteApproval(messageBlob)) {
    console.log(`check:refute — OK: ${financial.length} financial file(s) changed; a Refute-Reviewed/Skip trailer is present.`);
    return;
  }

  const msg = [
    `check:refute — ${financial.length} financial-decision source file(s) changed WITHOUT a refute attestation:`,
    ...financial.map((f) => `    ${f}`),
    '',
    'Run the refute-financial-change workflow on the change, then add a commit trailer:',
    '    Refute-Reviewed: wf_<runId>        (or, with justification)  Refute-Skip: <reason>',
    `(checked range: ${base}..HEAD)`,
  ].join('\n');

  if (strict) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-refute-required.ts')) {
  main();
}
