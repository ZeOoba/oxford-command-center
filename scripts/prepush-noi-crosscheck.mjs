// scripts/prepush-noi-crosscheck.mjs
//
// Pre-push NOI cross-check reminder (OI-137 / OI-162 fix #1). `npm run reconcile:noi-crosscheck`
// exists (compares Spine A's Property.noi against Spine B's warehouse ledger NOI) but only ran
// inside the optional local `npm run gate`, never `gate:ci` (CI has no live workbook) — so a
// scoring/debt/capital-allocation change could merge clean while consuming an un-tied-out NOI
// number. This hook surfaces that on every push instead of leaving it opt-in.
//
// ADVISORY ONLY. This script's own exit code is NEVER trusted by the wrapper that invokes it
// (see install-git-hooks.ts — no 'exec', explicit '|| true', unconditional 'exit 0' after).
// This file additionally makes non-blocking true INTERNALLY (never rely on a caller alone):
//   - main() runs inside try/catch; the catch sets process.exitCode = 0, it never calls
//     process.exit() with a truncation risk (process.exit() does not flush pending async
//     stderr/stdout writes under a piped git-hook stream — a large WARN tail could be cut off).
//   - No control path throws past the top-level try/catch.
//
// Two reasons this must stay advisory, not fail-closed:
//   1. The underlying check is KNOWN TO CURRENTLY FAIL on main (OI-137: Spine A vs Spine B
//      disagree 74-91% on 3 properties, root-caused to a structural forward-looking-vs-
//      historical-actuals mismatch, not a data bug). Flipping this to a hard gate today would
//      block every push to the repo until OI-137 closes or the script grows a documented
//      exception list — that is a standalone decision for Gabriel, not a side effect of adding
//      visibility.
//   2. The check needs the live OneDrive workbook, which isn't reachable from every worktree
//      (see reference_oxford-command-center_worktree_gotchas.md — WORKBOOK_PATH isn't inherited
//      per-worktree). A push from such a worktree should not be treated as a cross-check failure.
// A future BLOCK flip needs its own explicit decision once OI-137 is resolved, matching the
// WARN-before-BLOCK precedent already used for OI-id enforcement in this codebase family.
//
// Node built-ins only (runs in a git hook with no install step).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TIMEOUT_MS = 120_000;

// A real run (pass OR fail) always ends with this banner line — used to tell "the check ran and
// reported a result" apart from "the harness itself never got that far" (finding #2/#6: a broken
// invocation must not be mistaken for the known-expected OI-137 drift).
const REAL_RUN_MARKER = 'properties checked';

function runCheck() {
  // cwd passed explicitly (finding #5) rather than trusting the hook's inherited process.cwd() —
  // the wrapper resolves $root the same way for the SAME reason.
  // `npm run` (not a hand-rolled `npx tsx`, finding #6) so the WARN text's claim matches what
  // actually executed, and so this never falls back to an on-the-fly network install of a missing
  // dependency during `git push` — `npm run` fails closed on a missing local install instead.
  return execFileSync('npm run reconcile:noi-crosscheck --silent', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

function main() {
  let output = '';
  let err = null;
  try {
    output = runCheck();
  } catch (e) {
    err = e;
    output = [e.stdout, e.stderr].filter(Boolean).join('\n');
  }

  if (!err) {
    console.log('[prepush-noi-crosscheck] OK — Spine A / Spine B NOI cross-check passed.');
    return;
  }

  if (err.signal) {
    // Includes the SIGKILL from our own timeout (err.signal === 'SIGKILL' with no err.status),
    // and any external kill. Either way the check never finished — never present this as drift.
    console.warn(
      `\n[prepush-noi-crosscheck] WARN (non-blocking): reconcile:noi-crosscheck did not finish ` +
        `(signal=${err.signal}${err.killed && err.signal === 'SIGKILL' ? ', likely the ' + TIMEOUT_MS / 1000 + 's timeout' : ''}). ` +
        `This is a harness problem, not a data result — investigate scripts/reconcile-noi-crosscheck.ts directly.\n`
    );
    return;
  }

  const ranForReal = output.includes(REAL_RUN_MARKER);
  const tail = output.trim().split('\n').slice(-15).join('\n');

  if (ranForReal) {
    console.warn(
      '\n[prepush-noi-crosscheck] WARN (non-blocking): npm run reconcile:noi-crosscheck reported a failure.\n' +
        'This does NOT block the push. If this is the known OI-137 mismatch (3 properties, forward-looking\n' +
        'vs historical-actuals NOI) this is expected until that item closes. If the workbook/warehouse\n' +
        'were unreachable from this worktree, that is also expected — see reference_oxford-command-center_worktree_gotchas.md.\n' +
        'Last output:\n' +
        tail +
        '\n'
    );
  } else {
    // No recognizable output at all — the check never actually ran (missing dep, wrong cwd,
    // script error before it could print anything). This is NOT the OI-137 case and should read
    // as a distinct, louder signal that the check itself is broken, not that NOI drifted.
    console.warn(
      `\n[prepush-noi-crosscheck] WARN (non-blocking): reconcile:noi-crosscheck did not produce a ` +
        `recognizable result (exit status=${err.status ?? 'unknown'}) — the check itself likely failed ` +
        `to run, this is NOT confirmation of the known OI-137 NOI drift. Investigate directly: ` +
        `npm run reconcile:noi-crosscheck\n` +
        (tail ? `Captured output:\n${tail}\n` : '(no output captured)\n')
    );
  }
}

try {
  main();
} catch (e) {
  // Belt-and-braces: nothing above should throw past its own try/catch, but if it ever does,
  // this must still not block the push (see file header).
  console.warn(`[prepush-noi-crosscheck] WARN (non-blocking): hook itself failed: ${e?.message ?? e}`);
}
// Never process.exit() here — let the event loop drain naturally so pending async
// stdout/stderr writes flush (process.exit() does not guarantee that). Set exitCode instead of
// leaving it to whatever the last child_process call happened to set.
process.exitCode = 0;
