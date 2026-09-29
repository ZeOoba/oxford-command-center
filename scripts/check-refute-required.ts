// scripts/check-refute-required.ts
//
// Enforce the Engineering-OS doctrine (architecture/coding-standards.md): a change to
// financial-decision SOURCE — engine math / scoring / NOI / collections conditions / the financial
// overlay — must carry a `Refute-Reviewed:` (or, with justification, `Refute-Skip:`) commit trailer
// attesting that the refute-financial-change adversarial pass ran on it. Turns the written doctrine
// into a mechanical check so it cannot silently lapse.
//
// SCOPE MODEL (2026-09-22, Gabriel): server/ and scripts/ are DEFAULT-DENY — every path under them
// is financial-decision source unless it is named in NON_FINANCIAL_ROOT_PATHS with a justification.
// Everything outside those two roots is still an explicit allow-list (src/analytics/, the contract
// and seed files, config/ json). See DEFAULT_DENY_ROOTS below for why.
//
// ATTESTATION IS PER COMMIT (2026-09-23). Every commit in base..HEAD whose OWN changed paths include
// financial-decision source must carry the trailer in ITS OWN message. The gate used to diff the
// whole range and search the concatenated `git log` blob, so one `Refute-Skip:` on any commit
// attested every other commit in the range. Reproduced on fix/cc-review-2026-09-23: 4e2be44
// (error-transport plumbing, justified Refute-Skip) let its child 588fa81 (src/analytics/conditions.ts
// alert dedup, moving risk-$ totals, no trailer) pass `--strict --base=origin/main`. A later
// commit's trailer does not cover an earlier commit either: reword the earlier commit to attest it.
// Two consequences of that rule: a financial change plus its revert (net zero diff) needs a trailer
// on both commits, and so does a PR that attests only its final commit.
//
// MERGE COMMITS (two parents) are read twice and the paths unioned. --remerge-diff lists the paths
// where the recorded merge differs from git's own automatic re-merge: hand edits, and every text-file
// conflict resolution, even one that keeps the first parent's side. A combined diff (-c) lists the
// paths whose merged content differs from BOTH parents, which catches a clean merge that follows a
// rename INTO a financial path (see COMBINED_SHOW_ARGS); as a consequence a catch-up merge that
// combines both sides' changes to one financial file needs its own trailer. (A gitlink conflict resolved to the first
// parent's value is not listed. That is harmless: it adds nothing beyond parent 1, which is checked
// on its own.) The re-merge pins merge.renameLimit=0 / merge.renames / merge.directoryRenames so that
// a user's local merge config cannot change which paths are listed. OCTOPUS merges (3+ parents) are
// diffed against their first parent instead (see OCTOPUS_SHOW_ARGS). A clean merge lists nothing: a
// catch-up merge of main into the branch that touches no file changed on both sides, for instance. (CI passes --head=<PR head sha>, so GitHub's
// server-side synthetic refs/pull/N/merge commit is not in the range at all.) (The main-side commits a catch-up merge brings in are reachable from the base, so they are
// outside base..HEAD. Nothing checks them here. They were checked, if at all, on their own PRs.) An
// evil merge that edits financial source, or a conflict resolved inside a financial file, needs a
// trailer on the merge commit itself. `--no-merges` would have skipped such merges outright; the
// old range diff caught them. Attributes for that re-merge come from the empty tree
// (--attr-source), never from the checked-out tree the PR controls: a committed `merge=union` would
// otherwise make a real conflict re-merge cleanly. Requires git >= 2.41 (--attr-source,
// --remerge-diff): an older git is probed for up front and the gate skips (fails open) instead of
// reporting every commit as unreadable.
//
// SHALLOW CLONES are skipped (fail open, with a warning): a shallow boundary commit reads as a ROOT
// commit, which silently hides every commit behind it and lists the whole tree as the boundary's
// "changes". CI fetches full history (fetch-depth: 0). Replace refs (refs/replace/*) are ignored via
// --no-replace-objects, so a local replace ref cannot substitute a commit's parents or content.
//
// PATHS are read NUL-delimited (-z), so paths git would C-quote (", \, control chars) still hit the
// prefixes. --ignore-submodules=none keeps a committed `.gitmodules ignore = all` from hiding a
// gitlink bump. --root lists a root commit's paths even under a user's log.showRoot=false.
// --no-renames lists a rename as delete + add, so moving a file out of a financial path still names
// the financial path.
//
// SQUASH-MERGE NOTE: main is squash-merged, so per-commit attribution applies to the PR BRANCH, which
// is where CI (job refute-required, PR-only) runs it. The branch commits and their individual
// trailers do not survive onto main. The squash commit message must therefore carry the UNION of the
// branch's Refute-Reviewed/Refute-Skip trailers, one line per distinct trailer, so that main's
// history still records what attested what. Nothing re-runs this gate on main.
//
// Default mode WARNS and exits 0 (local dev — never blocks WIP). `--strict` EXITS 1 on a violation
// (wired into CI for PRs; also usable from /ship). Fails OPEN only when the range cannot be verified
// at all: the base does not resolve, --base is empty, the default HEAD does not resolve (no
// commits), the clone is shallow, git < 2.41, or git itself is unusable. Everything after both ends
// resolve fails CLOSED: an explicit --head that does not resolve, a range that cannot be listed, a
// commit that cannot be read (see collectCommits: no trailer clears it).
//
// Usage: tsx scripts/check-refute-required.ts [--strict] [--base=<ref>] [--head=<ref>]
//   base defaults to $REFUTE_BASE, else 'origin/main'; head defaults to HEAD.
//
// Exported functions are pure, or take an injectable git runner (collectCommits / evaluate), so they
// unit-test without the process.exit side effects — the bottom-of-file guard runs main() only when
// executed directly (mirrors governance-check.ts).
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // Lease Market Intelligence P1 Task 14: pure route plumbing (math lives in
  // src/analytics/lease-market/* and server/warehouse/lease-market/*, which stay refute-required
  // via the broad server/warehouse/ prefix).
  'server/warehouse/lease-market-api.ts',
  // Phase 5: pure route-plumbing; financial math lives in capital-allocation.ts + market-intel.ts.
  'server/warehouse/capital-allocation-api.ts',
  // Phase 5 W4: pure property-registration write; no financial math.
  'server/warehouse/property-onboarding.ts',
  // Direction 2: pure HTML IC-Memo renderer; all financial math lives in buildPortfolioAllocation
  // (capital-allocation.ts). This file only formats PortfolioAllocation for print-to-PDF.
  'server/warehouse/ic-memo.ts',
  // server/sources/ subtractions (2026-08-12): transport and indexing plumbing that carries no deal
  // or portfolio figures. Everything else under that prefix requires a trailer.
  'server/sources/graph-auth.ts',
  'server/sources/m365-tasks.ts',
  'server/sources/documents.ts',
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
  // deal.ts (2026-08-12): carries estPrice / capRate / irr / equityMultiple, the `confidential`
  // flag the bake redaction acts on, and notionDealId — the join key that decides which live
  // economics attach to which record. Added with the server/sources/ prefix below.
  'src/contracts/deal.ts',
  // common.ts holds the Market enum, which keys RCT_V03 (the ratified replacement-cost
  // denominator) and the cap-rate benchmark table.
  'src/contracts/common.ts',
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
  // Fix round 1 (Task 14 review, 2026-09-17): lease-market.ts carries LmThresholds — the
  // benchmark-n / similarity / radar-score / stale / withdrawn-lookback governor thresholds — plus
  // CellBenchmark and ComparableStats, consumed directly by the radar score and comparable-set math
  // in src/analytics/lease-market/{benchmarks,similarity,signals,radar}.ts. Same inclusion
  // criterion as loan.ts/debt.ts/capital.ts above: a silently dropped or renamed field desyncs the
  // contract from the governor math it types.
  'src/contracts/lease-market.ts',
]);

// Financial CONFIG (2026-09-21, weekly sweep — fifth occurrence of the scope-staleness mode): every
// `.json` under config/ is financial-decision input. The 2026-09-17 fix enumerated ONE file
// (lease-market.json) and, in its own comment, exempted config/lease-market.costar-headers.json as
// "a column-label map with no governor math" — but that file's rentPeriodDefault and rentBasisMap
// drive the x12 rent-period conversion and the NNN/MG/IG basis classification of every ingested
// rent (costar-parse.ts / normalize.ts), so a one-token edit repriced every listing with no
// attestation demanded. The enumeration also still missed replacement-cost.v3.json (RCT v03, the
// ratified basis denominator) and acquisition-ruleset.v1.json (the 0.65/0.90 basis floors).
// Per the doctrine this file's history keeps re-learning — an enumeration goes stale silently, a
// prefix fails closed — config/ is now a prefix, not a list. A genuinely non-financial config would
// have to be subtracted explicitly in NON_FINANCIAL_CONFIG_PATHS (empty today), which makes the
// exemption a reviewed, visible decision rather than an omission.
export const NON_FINANCIAL_CONFIG_PATHS: ReadonlySet<string> = new Set<string>();

// Financial DATA .json outside config/ (2026-09-21 refute round, same failure mode): the blanket `.json`
// exclusion below also exempted (a) the PFI account-mapping seed -- 339 GL accounts mapped to
// normalized_category / `excluded`, i.e. what counts as revenue vs opex in NOI, read by warehouse-backfill,
// warehouse-verify and warehouse-live-drift-check -- and (b) any `.json` sitting inside a financial source
// directory (server/warehouse/om-extract-fields.json is the OM price/SF extraction spec). Directories are
// a prefix (fail closed); the one out-of-tree data file is named.
const FINANCIAL_JSON_PREFIXES: readonly string[] = [
  // 2026-09-22 refute of the default-deny change: server/ is now a default-deny root for SOURCE, so
  // a .json under it is financial by the same rule that added server/ar/ (a weights table under
  // server/insights/ or a benchmark table under server/macro/ would otherwise slip through the
  // blanket .json exemption, which runs before the root rule). Subsumes the former server/warehouse/,
  // server/workbook/ and server/ar/ entries; tests pin each. scripts/ is deliberately NOT here:
  // scripts/data/*.json is an ingest receipt nothing reads back (see the test), and the only
  // tracked .json under scripts/ today is that file.
  'server/',
  'src/analytics/',
];
// Subtracted from the prefixes above (Gabriel, 2026-09-21): server/warehouse/placeholders/*.placeholder.json are
// self-labelled PLACEHOLDER stand-ins for broker/assessor data (docs/placeholder-data.md), overridden
// automatically once real rows exist -- not live governor inputs. Without this every edit demanded a refute
// trailer, which trains people to reach for Refute-Skip.
const NON_FINANCIAL_JSON_PATTERN = /^server\/warehouse\/placeholders\/[^/]+\.placeholder\.json$/;
const FINANCIAL_DATA_PATHS: ReadonlySet<string> = new Set([
  'docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json',
  // 2026-09-22 (weekly sweep, finding 6): the 2026-09-21 round above closed the blanket-`.json` hole
  // for warehouse/workbook/analytics and ONE seed file, and missed these two — the same failure mode
  // one day later. ar-mapping-cache.json is the persistent tenant-name → Lease.id map the AR feed
  // consults BEFORE any name matching (a cache hit skips review entirely) and it carries durable
  // human SKIP rulings; a one-line edit re-attributes a delinquency balance to a different lease
  // with no attestation demanded. overlay.json is the canonical mutation store the headless feed
  // writes arrears into. It is gitignored (.gitignore), so this entry is defense-in-depth against a
  // force-add — the cache IS tracked and PR-committed, and is the live gap. Named individually, not
  // as a `data/` prefix: data/snapshots/portfolio.json is re-baked and auto-committed by the
  // snapshot-refresh fleet, and data/ar/review-queue.json is a report surface nothing reads back —
  // a prefix would demand a trailer on every scheduled bake (see the placeholder subtraction above
  // for what that trains people to do).
  'data/ar-mapping-cache.json',
  'data/overlay.json',
]);

// DEFAULT-DENY ROOTS (2026-09-22, Gabriel — after the SIXTH occurrence of the scope-staleness mode).
// Every incident this file records has the same shape: a financial subsystem landed in a directory
// the allow-list had not been told about, and the gate reported "no financial-decision source files
// changed" until someone noticed and patched the list —
//   2026-07-24  src/contracts (the LTV-bound episode)
//   2026-08-11  server/workbook/   (three DSCR-denominator commits merged unattested)
//   2026-08-12  server/sources/    (the Deal-ID joiner + confidential default, whole branch silent)
//   2026-08-17  AR data files      (the sweep's own path list went stale)
//   2026-09-21  config/ + data json (the blanket .json rule)
//   2026-09-22  server/ar/** + the AR writer scripts
// An allow-list defaults every unlisted path to NOT financial — the unsafe direction. For the two
// roots that produced every source-file incident, the default is now inverted: a path under
// server/ or scripts/ IS financial-decision source unless it is explicitly named below. The old
// prefixes (server/warehouse/, server/workbook/, server/sources/, server/ar/) and named scripts
// (ar-import-headless.ts, seed-ar-mappings.ts, ar-import.ts) are subsumed by the root rule and are
// pinned by tests so folding them here never narrowed coverage. DELIVERY_ONLY_PATHS still applies
// (it is checked first), so the reviewed subtractions inside server/warehouse/ and server/sources/
// are unchanged. .test/.spec/.md and the .json rules stay ahead of this rule, as before.
export const DEFAULT_DENY_ROOTS: readonly string[] = ['server/', 'scripts/'];

// Reviewed NON-financial exemptions under the default-deny roots — the inverse of the old model:
// instead of listing what is exempt from a matched prefix, this lists what is exempt from the root
// itself. A path may appear here only if ALL of the following held on reading it (2026-09-22 survey
// of every file under both roots): (a) it holds no financial figure, threshold, mapping, ranking or
// writer and computes none; (b) it is not an input boundary (parser / extractor) or output boundary
// (route with logic, publisher, writer) for one; (c) it is not Hard-Invariant-3 gate wiring or the
// warehouse's access boundary — a silent weakening there exposes every figure at once, so
// access-authz.ts, host-guard.ts, cors-policy.ts, rate-limit.ts, briefing/confidential.ts,
// prepush-confidential-scan.mjs, install-git-hooks.ts, prepare-hooks.mjs, deploy-mirror.ps1
// (MIRROR_INCLUDE_CONFIDENTIAL=1 + the Access-gate probe) and lib/deploy-alert.ps1 (decides whether
// the GATE CHECK FAILED alert is suppressible) all stay IN scope; and (d) history shows it
// edited in non-financial PRs, so the entry removes a real false positive, not a hypothetical one.
// Deliberately file-level, never a directory: a new file beside an exempt one is IN scope until
// someone reads it and adds it here. Doubt resolves toward "financial" (governance-check.ts stays in
// for its governor-literal scan; server/lib/pdf-text.ts for being the PDF input boundary, the same
// reasoning that kept server/ar/pdf-extract.ts; brief/render.ts for its top-exposure selection).
export const NON_FINANCIAL_ROOT_PATHS: ReadonlySet<string> = new Set([
  // ── server/ ──
  // .env KEY=VALUE loader with override-on-empty; resolves the file relative to itself. No figure.
  'server/load-env.ts',
  // Outlook COM transport for the daily brief + the data/outbox fallback. Recipients (routing canon)
  // and content are decided in brief/run.ts; this is transport in the graph-auth.ts sense.
  'server/brief/send.ts',
  // Attachment-filename sanitizer for a streamed briefing (ORA_Briefing_<Subject>_<YYYYMMDD>.pdf).
  'server/briefing/filename.ts',
  // ORA Style Guide tokens + brand-font registration for the PDF, and the dependency-free WOFF1 -> TTF
  // decoder it uses. Pure presentation.
  'server/briefing/theme.ts',
  'server/briefing/woff-to-ttf.ts',
  // Pure BriefingModel -> PDF renderer: every figure and string is read off the model the composer
  // built (compose.ts stays in scope). Same reasoning as server/warehouse/ic-memo.ts above.
  'server/briefing/pdf.tsx',
  // ── scripts/ — dev tooling that never touches a figure ──
  // Bundle-size gate over dist/assets after `vite build`.
  'scripts/check-bundle.ts',
  // Dev-mode CSS parse gate (regression guard for PR #194).
  'scripts/check-dev-css.ts',
  // Static analysis over route / Zod / migration SOURCE TEXT (form-field vs column drift). Reads no
  // figure, opens no database; a regression makes a dev gate quieter, not a number wrong.
  'scripts/check-write-schema-drift.ts',
  // `--require` preload that reports a tsx-watch startup stall.
  'scripts/dev-watchdog.cjs',
  // `pregate` node_modules self-heal (`npm ci` when sentinels are missing).
  'scripts/ensure-deps.mjs',
  // Resumable document-embedding driver over server/sources/documents.ts, which is itself
  // delivery-only above.
  'scripts/index-docs.ts',
  // Junction-safe git-worktree add/remove/prune helper.
  'scripts/safe-worktree.ts',
  // ── scripts/ — Windows scheduled-task and mirror-deploy ops helpers ──
  // The historical false-positive class: 17 merged PRs (#172 … #341) touched only these files and
  // decided no figure. deploy-mirror.ps1 itself is NOT here (see (c) above); its helpers are.
  // Read-only classifier of the last Mirror Deploy run (beacon + Task Scheduler log -> JSON), and
  // the off-fleet alerting wrapper that calls it from a native task.
  'scripts/mirror-run-classify.ps1',
  'scripts/mirror-classify-offfleet.ps1',
  // One-shot Windows scheduled-task registrars (triggers, window style, WakeToRun).
  'scripts/register-brain-server-task.ps1',
  'scripts/register-mirror-classify-offfleet-task.ps1',
  'scripts/register-mirror-task.ps1',
  // Loops index-docs.ts until every chunk is embedded.
  'scripts/reindex-loop.ps1',
  // Hidden-window launcher / process-tree killer for the local dev server.
  'scripts/start-brain-server.ps1',
  'scripts/stop-brain-server.ps1',
  // scripts/lib/: shared PowerShell helpers dot-sourced by deploy-mirror.ps1 and the classifier —
  // cmd.exe argument guard, run-completion beacon, isolated build root, git-fetch capture,
  // in-process and native-command timeouts, task-action argument builder.
  // deploy-alert.ps1 is deliberately NOT here (2026-09-22 refute pass): Test-SuppressibleReason and
  // the -Critical guard in Send-DeployFailureAlert decide whether a GATE CHECK FAILED alert — "a
  // confidential bake may be publicly reachable" — can be suppressed. That is the same
  // Hard-Invariant-3 wiring that keeps deploy-mirror.ps1 in scope (criterion (c)); a one-token
  // edit to the '^(GATE CHECK|GIT AUTH FAILURE)' regex silences the exposure alert.
  'scripts/lib/cmd-arg-guard.ps1',
  'scripts/lib/deploy-beacon.ps1',
  'scripts/lib/deploy-buildroot.ps1',
  'scripts/lib/git-capture.ps1',
  'scripts/lib/job-timeout.ps1',
  'scripts/lib/mirror-task-action.ps1',
  'scripts/lib/native-timeout.ps1',
]);
// PowerShell smoke tests are test scaffolding (the .test/.spec rule above only knows .ts/.tsx).
// Scoped to scripts/ and scripts/lib/ directly — a deeper or differently-suffixed file is in scope.
const NON_FINANCIAL_ROOT_PATTERNS: readonly RegExp[] = [/^scripts\/(?:lib\/)?[^/]+\.smoke-test\.ps1$/];

/** True when a changed path holds financial-decision SOURCE (not a test / doc / json fixture). */
export function isFinancialSourcePath(p: string): boolean {
  const path = p.replace(/\\/g, '/');
  if (path.startsWith('config/') && path.endsWith('.json') && !NON_FINANCIAL_CONFIG_PATHS.has(path)) {
    return true;
  }
  if (
    path.endsWith('.json') &&
    !NON_FINANCIAL_JSON_PATTERN.test(path) &&
    (FINANCIAL_DATA_PATHS.has(path) || FINANCIAL_JSON_PREFIXES.some((pre) => path.startsWith(pre)))
  ) {
    return true;
  }
  if (/\.(test|spec)\.(ts|tsx)$/.test(path) || path.endsWith('.md') || path.endsWith('.json')) return false;
  if (DELIVERY_ONLY_PATHS.has(path)) return false;
  // Default-deny roots: in scope unless explicitly exempted. This branch subsumes the retired
  // explicit entries — server/warehouse/, server/workbook/ (2026-08-11: parse.ts and
  // debt-service-crosscheck.ts sit in the annualDebtService chain feeding the DSCR verdict; commits
  // 9ab137d, 59d1995, b9a58c2 merged unattested), server/sources/ (2026-08-12: the seed<->Notion
  // joiner decides which price / cap rate / IRR lands on which deal and which rows keep the
  // fail-closed confidential default), server/ar/ (2026-09-22: which lease a delinquency attaches
  // to; pdf-extract.ts deliberately NOT subtracted — it is the input boundary of every PDF balance),
  // server/overlay.ts, and the three AR writer scripts (ar-import-headless.ts writes arrears into
  // overlay + snapshot unattended; seed-ar-mappings.ts hardcodes tenant->lease rulings; ar-import.ts
  // carries its own inline `autoAccept` attribution threshold). Full narratives: git history of this
  // file (d230096, 6f68fe4) and tests/unit/check-refute-required.test.ts.
  if (DEFAULT_DENY_ROOTS.some((root) => path.startsWith(root))) {
    return !(NON_FINANCIAL_ROOT_PATHS.has(path) || NON_FINANCIAL_ROOT_PATTERNS.some((re) => re.test(path)));
  }
  // Outside the default-deny roots the model is still an explicit allow-list.
  return (
    path.startsWith('src/analytics/') ||
    // The seed pipeline: source of truth for Deal.confidential AND the fallback deal set a Notion
    // outage publishes. A wrong edit here is a Hard-Invariant-3 exposure, not a fixture change.
    path === 'src/data/seed-deals.ts' ||
    path === 'src/data/public-deals.ts' ||
    FINANCIAL_CONTRACT_PATHS.has(path) ||
    path === 'src/brain/anomaly-insights.ts' ||
    path === 'src/brain/principal-digest.ts' ||
    // Priced against RCT v03, the ratified basis denominator — a governor-adjacent constant table.
    path === 'src/brain/replacement-cost.ts'
  );
}

/**
 * Shape of a refute-financial-change Workflow run id (e.g. `wf_d10ede49-078`). NOT required:
 * `Refute-Reviewed:` also accepts a prose record of a non-workflow review (subagent passes, the
 * adversarial merge gate — main carries dozens, e.g. "five-mandate adversarial merge gate (Opus 5.5
 * subagents ...)"). Ratified by Gabriel 2026-09-27: accept prose, reject only placeholders. What it
 * IS used for: a first token that claims to be a run id (starts with `wf_`) must actually look like
 * one — lowercase id characters and at least one digit — so `wf_pending` / `wf_------` cannot
 * pose as a run. (`_` is allowed: main carries `wf_refute-financial-change_m5`.)
 */
export const REFUTE_RUN_ID = /^wf_[a-z0-9_-]{6,}$/;

/**
 * A value that is ONLY a placeholder word (after normalizeTrailerValue). Whole-value match, so
 * "Refute-Skip: none of this is math" and "Refute-Skip: TODO-list UI string only" still pass.
 */
const PLACEHOLDER_VALUE =
  /^(?:pending|todo|tbd|tba|n[./]?a\.?|none|placeholder|wip|later|fixme|done|ok|yes|reviewed|pass(?:ed)?|reason|x+|\?+|[-–—]+|\.+|…+|\*+|#+)[.!:?,;]*$/i;

/**
 * An unfilled template blank standing as its own word: `<date>`, `<reviewer/run ref>`, `<n> findings`.
 * Catches a template pasted without being filled in ("Fable 5.1 adversarial pass <date> — <n> findings").
 * Standalone only — start or whitespace before; end, whitespace or punctuation after (incl. `'s`, `/`,
 * `%`, `+`, `#`: `<date>'s`, `<n>/5`) — so prose that merely
 * contains angle brackets still attests: `.tmp-<pid>-<ts>` (on main, #367), `Map<string>`,
 * `a<b and c>d`, `<b>display-only</b>`. Emails and URLs (`@`, `://`) are never blanks.
 */
const UNFILLED_TEMPLATE = /(?:^|\s)(<(?![^<>\n]*(?:@|:\/\/))[A-Za-z][^<>\n]{0,40}>)(?=$|[\s.,;:!?)\]—–'’/%+#-])/;

/**
 * Strip invisible format characters (zero-width space, BOM, bidi marks) and wrapping quotes/brackets/
 * Markdown emphasis. Angle brackets are deliberately NOT a wrapper: `` `<run id>` `` must normalize to
 * `<run id>` so the unfilled-blank check still sees it, not to the plain words `run id`.
 */
function normalizeTrailerValue(value: string): string {
  let v = value.replace(/\p{Cf}/gu, '').trim();
  for (;;) {
    const unwrapped = v
      .replace(/^(["'`‘’“”([{])(.*)(["'`‘’“”)\]}])$/su, '$2')
      .replace(/^(\*{1,2}|_{1,2})(.+)\1$/su, '$2')
      .trim();
    if (unwrapped === v) return v;
    v = unwrapped;
  }
}

function refuteTrailers(message: string): Array<{ kind: 'reviewed' | 'skip'; value: string }> {
  return [...message.matchAll(/(?:^|\n)[ \t]*Refute-(Reviewed|Skip):([^\n]*)/gi)].map((m) => ({
    kind: (m[1] ?? '').toLowerCase() === 'reviewed' ? 'reviewed' : 'skip',
    value: (m[2] ?? '').trim(),
  }));
}

/**
 * Why one trailer does not attest, or null when it does. Both kinds accept any real value — a run
 * id, or prose describing the review / the skip justification — and reject: an empty value, the
 * gate's own pasted hint, an unfilled template blank (`<date>`), a bare placeholder word (PENDING,
 * TODO, TBD, N/A, ..., with trailing punctuation), and a `wf_`
 * token that is not a real run id shape (`wf_pending`, `wf_------`: no digit, or bad characters).
 */
function trailerRejection(value: string): string | null {
  if (value === '') return 'empty value';
  const norm = normalizeTrailerValue(value);
  // Checked on the raw AND normalized value: a WRAPPED hint (`"wf_<runId>"`, `(wf_<runId>)`) only
  // starts with the hint once unwrapped, and its `<runId>` is not a standalone blank.
  if ([value, norm].some((v) => v.startsWith('wf_<runId>') || v.startsWith('<reason>'))) {
    return "the gate's own placeholder, pasted verbatim";
  }
  // Normalized value too: a blank right after a stripped wrapper or invisible character
  // (`"<date> — 0 findings"`, `**<date> pass**`, a zero-width space + `<date>`) has no whitespace before it raw.
  const blank = UNFILLED_TEMPLATE.exec(value)?.[1] ?? UNFILLED_TEMPLATE.exec(norm)?.[1];
  if (blank !== undefined) return `unfilled template blank "${blank}"`;
  if (norm === '' || PLACEHOLDER_VALUE.test(norm)) return `placeholder "${value}" is not an attestation`;
  // Only the id-shaped prefix of the first word: `wf_d10ede49-078: 0 findings` / `...078's` are real ids.
  const id = /^wf_[A-Za-z0-9_-]*/i.exec(norm)?.[0];
  if (id !== undefined && !(REFUTE_RUN_ID.test(id) && /\d/.test(id))) {
    return `"${id}" poses as a refute run id but is not one (expected wf_<id> like wf_d10ede49-078)`;
  }
  return null;
}

/**
 * True when a refute attestation trailer with a real value appears in a commit message. Pass ONE
 * commit's message — a concatenated range blob is the defect this gate was fixed for (see the file
 * header). A bare `Refute-Skip:` with no value, the gate's own pasted hint line
 * (`Refute-Reviewed: wf_<runId>` / `Refute-Skip: <reason>`), a bare placeholder (PENDING/TODO/TBD),
 * or a fake run id (`wf_pending`) does not attest anything.
 */
export function hasRefuteApproval(message: string): boolean {
  return refuteTrailers(message).some((t) => trailerRejection(t.value) === null);
}

/** Each trailer present in the message that was rejected, with the reason — for the gate's error output. */
export function rejectedRefuteTrailers(message: string): string[] {
  return refuteTrailers(message).flatMap((t) => {
    const why = trailerRejection(t.value);
    return why === null ? [] : [`Refute-${t.kind === 'reviewed' ? 'Reviewed' : 'Skip'}: ${t.value} — rejected: ${why}`];
  });
}

/**
 * One commit's message and its OWN changed paths (not the range's). `readError` is set when the
 * commit sits inside a range that resolved but could not itself be read: it cannot be verified, so it
 * is a violation (fail CLOSED), not a skip.
 */
export interface CommitRecord {
  sha: string;
  message: string;
  files: string[];
  readError?: string;
  /** Set (true) only on merge commits; drives the reword recipe's merge warning. */
  merge?: true;
}

/** A commit that changed financial-decision source without attesting it in its own message, or could not be read. */
export interface UnattestedCommit {
  sha: string;
  subject: string;
  financial: string[];
  readError?: string;
  /** Trailers the commit DID carry that were rejected (placeholder, non-run-id), with the reason. */
  rejected?: string[];
}

/**
 * `git show` arguments for one commit, the sha appended last. See the file header for why each
 * flag is here; -z makes the output: message, NUL (from %x00), NUL-terminated paths.
 */
/** git's well-known empty tree (SHA-1 object format). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Global git options for every range read: ignore replace refs, and pin the merge settings the
 * --remerge-diff re-merge consults, so that local config cannot change the answer.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  '--no-replace-objects',
  // Read attributes from the EMPTY TREE, not the checked-out tree. In CI the checkout is the PR's
  // own tree, so a committed `.gitattributes` (not itself financial, so no trailer needed) could
  // set `merge=union` on a financial path and make git's re-merge resolve a real conflict by
  // itself, which --remerge-diff would then list as clean. Needs git >= 2.41 (the global
  // --attr-source option shipped in 2.41; 2.40 only added `check-attr --source`).
  `--attr-source=${EMPTY_TREE}`,
  '-c',
  'merge.renameLimit=0',
  '-c',
  'merge.renames=true',
  '-c',
  'merge.directoryRenames=conflict',
];

export const SHOW_ARGS: readonly string[] = [
  ...GIT_GLOBAL_ARGS,
  'show',
  // --no-relative: a user's diff.relative=true, with the gate run from a subdirectory, would print
  // paths relative to it (and drop the rest), so nothing would match a financial prefix.
  '--no-relative',
  '-z',
  '--remerge-diff',
  '--root',
  '--no-renames',
  '--ignore-submodules=none',
  '--name-only',
  '--format=%B%x00',
];

/**
 * The same for an OCTOPUS merge (3+ parents): git skips --remerge-diff for those. It prints a warning
 * in place of the path list, so they would pass as "no financial files". Instead they are diffed against their
 * first parent — every path any merged-in branch brought, so over-inclusive by design (octopus merges
 * are rare; a false positive costs one trailer).
 */
export const OCTOPUS_SHOW_ARGS: readonly string[] = SHOW_ARGS.map((a) =>
  a === '--remerge-diff' ? '--diff-merges=first-parent' : a,
);

/**
 * The second read for a TWO-parent merge: a combined diff (-c) lists every path whose merged
 * content differs from BOTH parents. --remerge-diff alone misses a merge whose automatic re-merge
 * follows a rename (or directory rename) INTO a financial path: main moves src/lib/x.ts to
 * src/analytics/x.ts, the branch edits the old, non-financial path, and the clean merge carries
 * that edit into financial source that no commit's own path list names. The union of the two reads
 * is what the merge must attest. Cost, by design: a catch-up merge that combines both sides'
 * changes to the same financial file needs a trailer too.
 */
export const COMBINED_SHOW_ARGS: readonly string[] = SHOW_ARGS.map((a) => (a === '--remerge-diff' ? '-c' : a));

/**
 * Parse `git show ${SHOW_ARGS} <sha>` output. The first NUL ends the message: without it, the only
 * message / path-list boundary is a blank line, which messages also contain. Paths are split on NUL
 * only — never trimmed — so a path with spaces or quote characters survives intact. Throws unless
 * the output is exactly that shape — a missing message terminator, or anything after the last
 * path terminator (the octopus remerge-diff warning was one) — so an unexpected shape is reported
 * as an unreadable commit instead of being read as a harmless path.
 */
export function parseCommitShow(sha: string, raw: string): CommitRecord {
  const nul = raw.indexOf('\0');
  if (nul === -1) throw new Error(`unexpected git show output for ${sha} (no message terminator)`);
  const rest = raw.slice(nul + 1).replace(/^\0*\n?/, '');
  if (rest !== '' && !rest.endsWith('\0')) {
    throw new Error(`unexpected git show output for ${sha} (unterminated path list: ${JSON.stringify(rest.slice(-80))})`);
  }
  const files = rest.split('\0').filter((p) => p !== '');
  return { sha, message: raw.slice(0, nul), files };
}

/** Every commit whose own changed paths include financial source and whose own message has no trailer. */
export function findUnattestedCommits(commits: readonly CommitRecord[]): UnattestedCommit[] {
  const out: UnattestedCommit[] = [];
  for (const c of commits) {
    if (c.readError !== undefined) {
      out.push({ sha: c.sha, subject: '(could not be read)', financial: [], readError: c.readError });
      continue;
    }
    const financial = c.files.filter(isFinancialSourcePath);
    if (financial.length === 0 || hasRefuteApproval(c.message)) continue;
    const rejected = rejectedRefuteTrailers(c.message);
    out.push({
      sha: c.sha,
      subject: c.message.split('\n')[0]?.trim() ?? '',
      financial,
      ...(rejected.length > 0 ? { rejected } : {}),
    });
  }
  return out;
}

export type GitRunner = (args: string[]) => string;

/**
 * Environment for every git call. GIT_GRAFT_FILE points at a path that does not exist, so a legacy
 * `.git/info/grafts` file (which --no-replace-objects does NOT disable) cannot rewrite parents and
 * hide a commit from the range.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_GRAFT_FILE: join(tmpdir(), 'check-refute-required.no-grafts') };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
}

/**
 * Every commit in base..head (merges included), each with its own message and paths. Throws only
 * when the RANGE cannot be resolved (the caller fails open). A commit inside a resolved range that
 * cannot be read — git error, buffer overflow, unexpected output shape — comes back with
 * `readError` set, because failing open there would let one crafted commit (a ~5 KiB tree listing
 * 256k paths overflows any buffer) switch the gate off for the whole range.
 */
export function collectCommits(base: string, head = 'HEAD', run: GitRunner = git): CommitRecord[] {
  // Trailing `--`: without it git also stats the range as a possible PATH, which fails on Windows in
  // a deep working directory ("Filename too long") — now a fail-CLOSED violation, i.e. a false block.
  const rows = run([...GIT_GLOBAL_ARGS, 'rev-list', '--parents', `${base}..${head}`, '--'])
    .split('\n')
    .map((s) => s.trim().split(/\s+/))
    .filter((r) => r[0]);
  return rows.map(([sha = '', ...parents]): CommitRecord => {
    try {
      if (parents.length > 2) return { ...parseCommitShow(sha, run([...OCTOPUS_SHOW_ARGS, sha])), merge: true };
      const record = parseCommitShow(sha, run([...SHOW_ARGS, sha]));
      if (parents.length < 2) return record;
      const combined = parseCommitShow(sha, run([...COMBINED_SHOW_ARGS, sha]));
      return { ...record, files: [...new Set([...record.files, ...combined.files])], merge: true };
    } catch (err) {
      return { sha, message: '', files: [], readError: (err as Error).message.split('\n')[0] ?? 'unknown error' };
    }
  });
}

/** ok: nothing to attest or all attested · skip: tooling gap, fail open · violation: see message. */
export interface GateResult {
  outcome: 'ok' | 'skip' | 'violation';
  message: string;
}

/**
 * A reason this checkout cannot be verified at all, or undefined. Unparseable probe output means
 * "no known gap" (proceed); a probe that throws means git itself is unusable (skip).
 */
export function probeToolingGap(run: GitRunner): string | undefined {
  try {
    const v = /git version (\d+)\.(\d+)/.exec(run(['version']));
    if (v && (Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 41))) {
      return `git ${v[1]}.${v[2]} lacks --attr-source / --remerge-diff (needs >= 2.41)`;
    }
    if (run(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      return 'shallow clone: a boundary commit reads as a root commit and hides every commit behind it (fetch full history, e.g. fetch-depth: 0)';
    }
  } catch (err) {
    return `git unusable (${(err as Error).message.split('\n')[0]})`;
  }
  return undefined;
}

/** The whole gate minus process I/O; main() maps the outcome to a console stream and exit code. */
export function evaluate(base: string, run: GitRunner = git, head = 'HEAD'): GateResult {
  if (base.trim() === '') {
    // `--base=` or REFUTE_BASE='' would otherwise read the empty range `..HEAD` and report OK.
    return { outcome: 'skip', message: 'check:refute — skipped: empty base ref (pass --base=<ref>).' };
  }
  const gap = probeToolingGap(run);
  if (gap !== undefined) return { outcome: 'skip', message: `check:refute — skipped: ${gap}.` };
  // Resolve both ends BEFORE listing the range. Only a failure HERE is a tooling gap: once both
  // ends resolve, a failure to list the range (e.g. `rev-list` output overflowing the buffer on a
  // PR carrying ~830k commits) must not switch the gate off.
  const firstLine = (err: unknown): string => (err as Error).message.split('\n')[0] ?? 'unknown error';
  // Every later step uses the RESOLVED shas, never the names again: in a shared checkout another
  // session can switch HEAD (or move a branch) between this check and the range read, and a
  // re-resolved name would then read a range nobody verified. (Output that is not a sha falls back to
  // the name; rev-parse --verify always prints one.)
  const shaOr = (out: string, name: string): string => {
    const sha = out.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : name;
  };
  let baseSha: string;
  let headSha: string;
  try {
    // GIT_GLOBAL_ARGS here too: a replace ref on the head would otherwise resolve it to a decoy.
    baseSha = shaOr(run([...GIT_GLOBAL_ARGS, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`]), base);
  } catch (err) {
    // No usable base ref (not fetched, typo, fresh repo) — never block on a tooling gap.
    return { outcome: 'skip', message: `check:refute — skipped: base '${base}' does not resolve (${firstLine(err)}).` };
  }
  try {
    headSha = shaOr(run([...GIT_GLOBAL_ARGS, 'rev-parse', '--verify', '--quiet', `${head}^{commit}`]), head);
  } catch (err) {
    // The default HEAD not resolving means a repo with no commits: a tooling gap. An EXPLICIT
    // --head that does not resolve is a caller error, and under --strict it must not pass.
    if (head === 'HEAD') return { outcome: 'skip', message: `check:refute — skipped: HEAD does not resolve (${firstLine(err)}).` };
    return { outcome: 'violation', message: `check:refute — --head '${head}' does not resolve to a commit (${firstLine(err)}).` };
  }
  let commits: CommitRecord[];
  try {
    commits = collectCommits(baseSha, headSha, run);
  } catch (err) {
    return {
      outcome: 'violation',
      message: `check:refute — could not list the commits in the resolved range '${base}..${head}', so none can be verified (${firstLine(err)}).`,
    };
  }

  const financialCommits = commits.filter((c) => c.readError !== undefined || c.files.some(isFinancialSourcePath));
  if (financialCommits.length === 0) {
    return { outcome: 'ok', message: 'check:refute — OK: no financial-decision source files changed in this range.' };
  }
  const unattested = findUnattestedCommits(commits);
  if (unattested.length === 0) {
    return {
      outcome: 'ok',
      message: `check:refute — OK: ${financialCommits.length} commit(s) change financial-decision source; each carries its own Refute-Reviewed/Skip trailer.`,
    };
  }
  const unreadable = unattested.some((u) => u.readError !== undefined);
  // The rebase target is the merge-base, not the base REF: the ref may move (another PR lands, a
  // fetch) between this message and the reader running it, and a rebase onto the moved ref would
  // replay the branch onto new main instead of rewording one message. --rebase-merges keeps a merge
  // commit (which may be the one needing the trailer) instead of dropping it and replaying its conflicts.
  let rebaseOnto = base;
  try {
    const mb = run([...GIT_GLOBAL_ARGS, 'merge-base', baseSha, headSha]).trim();
    if (/^[0-9a-f]{40,64}$/.test(mb)) rebaseOnto = mb;
  } catch {
    // Keep the ref; the reword still works when the ref has not moved.
  }
  const message = [
    `check:refute — ${unattested.length} of ${financialCommits.length} commit(s) changing financial-decision source are unattested${unreadable ? ' or unreadable' : ''}:`,
    ...unattested.flatMap((u) => [
      `  ${u.sha.slice(0, 7)} ${u.subject}`,
      ...(u.readError !== undefined ? [`      unreadable, so unverifiable: ${u.readError}`] : []),
      ...(u.rejected ?? []).map((r) => `      ${r}`),
      ...u.financial.map((f) => `      ${f}`),
    ]),
    '',
    ...(unreadable
      ? [
          'An UNREADABLE commit cannot be cleared by any trailer: its content was never verified. Rewrite',
          'it (split an oversized commit, recreate a malformed one) so that git show can read it.',
          '',
        ]
      : []),
    'A trailer on another commit in the range does not attest these. Run the refute-financial-change',
    "workflow on each, then add a trailer to THAT commit's message:",
    '    Refute-Reviewed: wf_<runId>        (or, with justification)  Refute-Skip: <reason>',
    'Substitute the real run id (or describe the non-workflow review that ran). Placeholders are',
    'rejected: wf_<runId>, PENDING, TODO, TBD, N/A, wf_pending, unfilled <blanks>. Not run yet? Run it, or',
    'Refute-Skip: with the real reason.',
    'HEAD: git commit --amend. An earlier commit: do it in your own worktree (git worktree add), never a',
    'shared checkout, with no editor at all (POSIX shell / Git Bash):',
    '    PRE=$(git rev-parse HEAD)                  (pin the tip: ORIG_HEAD is one slot another session can overwrite)',
    `    GIT_EDITOR="git interpret-trailers --in-place --trailer 'Refute-Reviewed: wf_<runId>'" git commit --fixup=reword:<sha>`,
    `    GIT_SEQUENCE_EDITOR=: git rebase -i --rebase-merges --autosquash ${rebaseOnto}${rebaseOnto === base ? '' : `    (merge-base of ${base} and ${head})`}`,
    '    git diff --exit-code "$PRE" HEAD           (MUST print nothing: a reword changes no content)',
    ...(commits.some((c) => c.merge)
      ? [
          'This range contains a merge commit: --rebase-merges RE-CREATES every merge after the reworded',
          'commit and silently drops its hand edits and conflict resolutions. If the diff above is not',
          'empty, restore the branch with `git reset --keep "$PRE"` (never --hard, which also discards',
          'uncommitted work) and reword by hand instead.',
        ]
      : []),
    `(checked range: ${base} (${baseSha.slice(0, 12)})..${head} (${headSha.slice(0, 12)}), merges read by --remerge-diff + -c)`,
  ].join('\n');
  return { outcome: 'violation', message };
}

/** What main() prints and exits with; pure so the CLI contract CI depends on is unit-testable. */
export interface CliResult {
  stream: 'log' | 'warn' | 'error';
  exitCode: 0 | 1;
  message: string;
}

export function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, run: GitRunner = git): CliResult {
  const strict = argv.includes('--strict');
  const base = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? env.REFUTE_BASE ?? 'origin/main';
  // --head lets CI name the PR head sha directly instead of its synthetic refs/pull/N/merge HEAD.
  const head = argv.find((a) => a.startsWith('--head='))?.slice('--head='.length) || 'HEAD';
  const result = evaluate(base, run, head);
  if (result.outcome === 'ok') return { stream: 'log', exitCode: 0, message: result.message };
  if (result.outcome === 'violation' && strict) return { stream: 'error', exitCode: 1, message: result.message };
  return { stream: 'warn', exitCode: 0, message: result.message };
}

function main(): void {
  const r = runCli(process.argv.slice(2), process.env);
  console[r.stream](r.message);
  if (r.exitCode !== 0) process.exit(r.exitCode);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-refute-required.ts')) {
  main();
}
