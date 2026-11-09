import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  isFinancialSourcePath,
  hasRefuteApproval,
  rejectedRefuteTrailers,
  findUnattestedCommits,
  parseCommitShow,
  collectCommits,
  evaluate,
  runCli,
  gitEnv,
  probeToolingGap,
  SHOW_ARGS,
  OCTOPUS_SHOW_ARGS,
  GIT_GLOBAL_ARGS,
  type CommitRecord,
  type GitRunner,
  DELIVERY_ONLY_PATHS,
  NON_FINANCIAL_CONFIG_PATHS,
  DEFAULT_DENY_ROOTS,
  NON_FINANCIAL_ROOT_PATHS,
  REFUTE_GATE_PATHS,
  REFUTE_GATE_PATH_PREFIXES,
  resolveGitExecutable,
  gitRunnerFor,
  NON_FINANCIAL_JSON_PATTERN,
  NON_FINANCIAL_ROOT_PATTERNS,
} from '../../scripts/check-refute-required';

describe('check-refute-required — financial-source classification', () => {
  it('flags financial-decision source (incl. Windows separators)', () => {
    expect(isFinancialSourcePath('src/analytics/conditions.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/calibration.ts')).toBe(true);
    expect(isFinancialSourcePath('server/overlay.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/anomaly-insights.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\warehouse\\anomalies.ts')).toBe(true);
  });
  // 2026-08-11 sweep: server/workbook/ was absent from the gate while parse.ts and
  // debt-service-crosscheck.ts both sit in the annualDebtService chain feeding debt-scoring.ts
  // (DSCR) and src/analytics/engine.ts. Three commits touching the DSCR denominator landed
  // without a gate-required refute trailer. This is the second occurrence of the scope-staleness
  // mode (2026-07-24 was the first, one directory over) — a NEW financial directory must not be
  // invisible by default.
  it('flags the refute gate itself: the refute workflow and this check script are trailer-required', () => {
    expect(isFinancialSourcePath('.claude/workflows/refute-financial-change.js')).toBe(true);
    expect(isFinancialSourcePath('.claude\\workflows\\refute-financial-change.js')).toBe(true);
    expect(isFinancialSourcePath('scripts/check-refute-required.ts')).toBe(true);
    // Pinned ahead of the exemption list: listing the gate as non-financial must not switch it off.
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/check-refute-required.ts')).toBe(false);
    // Only the named file, not the whole directory.
    expect(isFinancialSourcePath('.claude/workflows/some-other-workflow.js')).toBe(false);
  });
  it('flags the gate WIRING: ci.yml (runs check:refute) and package.json (defines the check:refute script)', () => {
    expect(isFinancialSourcePath('.github/workflows/ci.yml')).toBe(true);
    expect(isFinancialSourcePath('.github\\workflows\\ci.yml')).toBe(true);
    // Path-level only (the gate reads --name-only, never diff content): EVERY package.json edit needs a trailer.
    expect(isFinancialSourcePath('package.json')).toBe(true);
    // Root .npmrc: npm exports its `node-options` key as NODE_OPTIONS to every `npm run` script, so a preload there
    // can force `npm run check:refute` to exit 0 without running the check (wf_19fea163-b81, reproduced).
    expect(isFinancialSourcePath('.npmrc')).toBe(true);
    // Nested package.json files, nested .npmrc files and the lockfile stay out (lockfile: owner's call, see header).
    expect(isFinancialSourcePath('functions/package.json')).toBe(false);
    expect(isFinancialSourcePath('functions/.npmrc')).toBe(false);
    expect(isFinancialSourcePath('package-lock.json')).toBe(false);
    expect([...REFUTE_GATE_PATHS].sort()).toEqual(
      ['.claude/workflows/refute-financial-change.js', '.npmrc', 'package.json', 'scripts/check-refute-required.ts', 'scripts/package.json'].sort(),
    );
    expect([...REFUTE_GATE_PATH_PREFIXES]).toEqual(['.github/workflows/']);
  });
  it('scripts/package.json is a gate path: it is the package.json nearest the gate script (module format for node/tsx)', () => {
    expect(isFinancialSourcePath('scripts/package.json')).toBe(true);
    // scripts/lib/package.json would only govern scripts/lib/**, which the gate script does not import: not a gate path.
    expect(isFinancialSourcePath('scripts/lib/package.json')).toBe(false);
  });
  it('a REPO-ROOT Windows executable is a gate path (cmd.exe searches the cwd before PATH: tsx.cmd / node.cmd / git.exe hijack)', () => {
    for (const p of ['tsx.cmd', 'TSX.CMD', 'Tsx.Bat', 'node.cmd', 'git.exe', 'GIT.EXE', 'npm.com', 'anything.ps1', 'x.Cmd']) {
      expect({ p, gate: isFinancialSourcePath(p) }).toEqual({ p, gate: true });
    }
    // cmd.exe also tries the other PATHEXT script-host extensions for a bare command name (tsx -> tsx.js via WSH),
    // so a root file that shadows a command the gate step runs is a gate path with those extensions too.
    for (const p of ['tsx.js', 'node.vbs', 'git.wsf', 'npm.jse', 'npx.vbe', 'TSX.JS']) {
      expect({ p, gate: isFinancialSourcePath(p) }).toEqual({ p, gate: true });
    }
    // Root only, and only executable extensions / shadowed command names.
    for (const p of ['docs/tsx.cmd', 'tests/fixtures/run.bat', 'eslint.config.js', 'vite.config.ts', 'README.md', 'tsx.json', 'cmd']) {
      expect({ p, gate: isFinancialSourcePath(p) }).toEqual({ p, gate: false });
    }
  });
  it('gate paths and the workflows prefix match case-insensitively (the Windows runner checks out case-insensitively)', () => {
    for (const p of [
      'PACKAGE.JSON',
      'Package.json',
      '.NPMRC',
      'Scripts/Check-Refute-Required.ts',
      '.Claude/Workflows/Refute-Financial-Change.JS',
      '.GitHub/Workflows/ci.yml',
      '.GITHUB\\WORKFLOWS\\X.YML',
      'SCRIPTS/PACKAGE.JSON',
    ]) {
      expect({ p, gate: isFinancialSourcePath(p) }).toEqual({ p, gate: true });
    }
    expect(isFinancialSourcePath('.GitHub/Workflows-notes.md')).toBe(false);
  });
  it('EVERY rule is case-insensitive: an NTFS case-variant of a financial file is financial (wf_d3be7fbd-39e)', () => {
    for (const p of [
      'Server/warehouse/x.ts',
      'SERVER/OVERLAY.TS',
      'server/Warehouse/Scores.ts',
      'Scripts/foo.ts',
      'SCRIPTS\\AR-IMPORT.TS',
      'SRC/Analytics/y.ts',
      'src/ANALYTICS/conditions.ts',
      'Src/Data/Seed-Deals.ts',
      'src/data/PUBLIC-DEALS.ts',
      'src/contracts/LOAN.ts',
      'Src/Contracts/Deal.ts',
      'src/brain/Replacement-Cost.ts',
      'Config/anything.json',
      'CONFIG/x.JSON',
    ]) {
      expect({ p, financial: isFinancialSourcePath(p) }).toEqual({ p, financial: true });
    }
  });
  it('exemptions are case-insensitive too: a case-variant of an exempt file stays exempt (it IS that file on NTFS)', () => {
    for (const p of [
      'Tests/Unit/Conditions.Test.TS',
      'tests/unit/x.SPEC.tsx',
      'server/warehouse/scores.TEST.ts',
      'Architecture/Coding-Standards.MD',
      'README.MD',
      'SERVER/LOAD-ENV.TS',
      'Server/Brief/Send.ts',
      'src/contracts/Lease.ts',
      'SRC/LIB/CN.TS',
      // DELIVERY_ONLY_PATHS entry in odd case (real entry: server/warehouse/debt-api.ts). api.ts left
      // the allowlist 2026-11-09 (it now classifies financial; its odd-case form is asserted below).
      'SERVER/WAREHOUSE/DEBT-API.TS',
    ]) {
      expect({ p, financial: isFinancialSourcePath(p) }).toEqual({ p, financial: false });
    }
  });
  it('every classification set and path literal is lower-case, so lower-casing the path once is exact', () => {
    for (const set of [DELIVERY_ONLY_PATHS, NON_FINANCIAL_CONFIG_PATHS, NON_FINANCIAL_ROOT_PATHS, REFUTE_GATE_PATHS]) {
      for (const e of set) expect(e).toBe(e.toLowerCase());
    }
    for (const e of [...DEFAULT_DENY_ROOTS, ...REFUTE_GATE_PATH_PREFIXES]) expect(e).toBe(e.toLowerCase());
    // The non-exported sets and literals: every quoted path between the first classification constant and the end of
    // isFinancialSourcePath.
    const src = readFileSync(join(process.cwd(), 'scripts', 'check-refute-required.ts'), 'utf8');
    const from = src.indexOf('export const DELIVERY_ONLY_PATHS');
    const to = src.indexOf('\n}', src.indexOf('export function isFinancialSourcePath'));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const literals = [...src.slice(from, to).matchAll(/'([^'\n]*\/[^'\n]*)'/g)].map((m) => m[1] ?? '');
    expect(literals.length).toBeGreaterThan(20);
    for (const l of literals) expect({ l, lower: l === l.toLowerCase() }).toEqual({ l, lower: true });
    // Extension / suffix literals (`.md`, `.json`, ...) used by endsWith() in the classifier.
    const exts = [...src.slice(from, to).matchAll(/'(\.[A-Za-z0-9.]+)'/g)].map((m) => m[1] ?? '');
    expect(exts).toEqual(expect.arrayContaining(['.md', '.json']));
    for (const l of exts) expect({ l, lower: l === l.toLowerCase() }).toEqual({ l, lower: true });
    // The exemption regexes: their source must be lower-case too (no /i needed, none silently case-sensitive).
    for (const re of [NON_FINANCIAL_JSON_PATTERN, ...NON_FINANCIAL_ROOT_PATTERNS]) {
      expect({ re: re.source, lower: re.source === re.source.toLowerCase() }).toEqual({ re: re.source, lower: true });
    }
  });
  it('flags the WHOLE .github/workflows/ directory by prefix (any workflow can publish a look-alike check name)', () => {
    for (const p of [
      '.github/workflows/ci.yml',
      '.github/workflows/full-gate-selfhosted.yml',
      '.github/workflows/order-fragility.yml',
      '.github/workflows/brand-new.yml',
      '.github/workflows/nested/dir/x.yaml',
      '.github\\workflows\\brand-new.yml',
    ]) {
      expect(isFinancialSourcePath(p)).toBe(true);
    }
    // Look-alikes are NOT gate paths: the prefix is anchored at the repo root and ends in a slash.
    for (const p of ['.github/workflows-notes.md', '.github/workflows.yml', 'docs/.github/workflows/x.yml', 'x/.github/workflows/ci.yml', '.github/ISSUE_TEMPLATE/bug.yml']) {
      expect(isFinancialSourcePath(p)).toBe(false);
    }
  });
  it('CI runs the gate without any cwd-searchable command lookup: job env + direct tsx entry point', () => {
    const root = process.cwd();
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
    const job = ci.slice(ci.indexOf('\n  refute-required:\n'));
    expect(job.startsWith('\n  refute-required:\n')).toBe(true);
    const jobHead = job.slice(0, job.indexOf('\n    steps:\n') + 1);
    // cmd.exe (npm's script shell on Windows) searches the cwd before PATH unless this is set: a committed root
    // tsx.cmd / node.cmd would otherwise run instead of the real tool on the self-hosted Windows runner.
    expect(jobHead).toMatch(/\n {4}env:\n(?: {6}[^\n]*\n)* {6}NoDefaultCurrentDirectoryInExePath: '1'\n/);
    // The gate step itself must not go through `npm run` (cmd.exe lookup of tsx) or a bare `tsx`.
    const steps = job.split('\n').filter((l) => /^\s*- run: .*check-refute-required/.test(l) || /^\s*- run: .*check:refute/.test(l));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatch(/- run: node node_modules\/tsx\/dist\/cli\.mjs scripts\/check-refute-required\.ts --strict /);
    expect(steps[0]).not.toMatch(/npm run|npx|(?<![/\w])tsx /);
    // ...and that path really is tsx's CLI entry (its package.json bin), present after `npm ci`.
    const tsxPkg = JSON.parse(readFileSync(join(root, 'node_modules', 'tsx', 'package.json'), 'utf8')) as { bin: string | Record<string, string> };
    const bin = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx;
    expect(bin?.replace(/^\.\//, '')).toBe('dist/cli.mjs');
    expect(readFileSync(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'utf8').length).toBeGreaterThan(0);
  });
  it('every protected runtime input of the CI gate step, read from the repo itself, is classified financial', () => {
    const root = process.cwd();
    // The CI gate step runs the check THROUGH npm, so its inputs are ci.yml, the package.json script entry, the root
    // .npmrc (node-options -> NODE_OPTIONS), the script that entry names, and the workflow whose result it attests.
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const target = /\b(scripts\/[\w./-]+\.ts)\b/.exec(pkg.scripts['check:refute'] ?? '')?.[1];
    expect(target).toBe('scripts/check-refute-required.ts');
    // The CI step runs the same script file the developer `npm run check:refute` entry names.
    expect(ci).toContain(`node node_modules/tsx/dist/cli.mjs ${target} --strict`);
    const tracked = execFileSync('git', ['ls-files', '--', '.npmrc', '.github/workflows'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(tracked).toContain('.npmrc');
    expect(tracked).toContain('.github/workflows/ci.yml');
    expect(tracked.length).toBeGreaterThan(2); // the sibling workflows are tracked too
    const inputs = ['.github/workflows/ci.yml', 'package.json', '.npmrc', target ?? '', '.claude/workflows/refute-financial-change.js', ...tracked];
    for (const p of inputs) expect({ p, financial: isFinancialSourcePath(p) }).toEqual({ p, financial: true });
  });
  it('gate paths are checked FIRST: listing them in an exemption set does not switch the gate off', () => {
    const gate = [
      '.claude/workflows/refute-financial-change.js',
      'scripts/check-refute-required.ts',
      '.github/workflows/ci.yml',
      '.github/workflows/brand-new.yml',
      'package.json',
      '.npmrc',
      'scripts/package.json',
      'tsx.cmd',
      'PACKAGE.JSON',
    ];
    const exemptions = [NON_FINANCIAL_ROOT_PATHS, DELIVERY_ONLY_PATHS] as unknown as Set<string>[];
    const added: Array<[Set<string>, string]> = [];
    try {
      for (const set of exemptions) {
        for (const p of gate) {
          if (!set.has(p)) {
            set.add(p);
            added.push([set, p]);
          }
        }
      }
      // Sanity: the exemption really is in effect for a non-gate sibling path.
      (NON_FINANCIAL_ROOT_PATHS as unknown as Set<string>).add('scripts/__exempt-probe.ts');
      added.push([NON_FINANCIAL_ROOT_PATHS as unknown as Set<string>, 'scripts/__exempt-probe.ts']);
      expect(isFinancialSourcePath('scripts/__exempt-probe.ts')).toBe(false);
      for (const p of gate) expect(isFinancialSourcePath(p)).toBe(true);
    } finally {
      for (const [set, p] of added) set.delete(p);
    }
  });
  it('flags server/workbook/ — the workbook parser and debt-service cross-check feed DSCR', () => {
    expect(isFinancialSourcePath('server/workbook/parse.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/debt-service-crosscheck.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/counterparties.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\workbook\\parse.ts')).toBe(true);
  });
  it('still ignores workbook tests and docs', () => {
    expect(isFinancialSourcePath('tests/unit/debt-service-crosscheck.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/workbook/debt-maturity.DESIGN.md')).toBe(false);
  });
  // 2026-08-12, THIRD occurrence of the scope-staleness mode. The Deal-ID join redesign rewrote
  // the seed<->Notion joiner — which decides which live price / cap rate / IRR / lender attaches
  // to which deal record, and which rows keep the fail-closed confidential default — and this gate
  // reported "no financial-decision source files changed" for the whole branch. Same shape as
  // src/contracts (2026-07-24) and server/workbook (2026-08-11): an enumeration that goes stale
  // silently. Fixed with a prefix, which fails closed as new files appear.
  it('flags server/sources/ — the deal joiner, the confidentiality gate, QuickBooks, tenants', () => {
    expect(isFinancialSourcePath('server/sources/notion-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-name.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-declassification.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/quickbooks.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/notion-tenants.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\sources\\notion-deals.ts')).toBe(true);
  });
  it('subtracts the transport/indexing plumbing under server/sources/', () => {
    expect(isFinancialSourcePath('server/sources/graph-auth.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/m365-tasks.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/documents.ts')).toBe(false);
    // …but a test beside them is still a test.
    expect(isFinancialSourcePath('server/sources/notion-deals.test.ts')).toBe(false);
  });
  it('flags the seed deal set and the RCT denominator table', () => {
    // seed-deals.ts is the source of truth for Deal.confidential AND the set published when Notion
    // is unreachable; replacement-cost.ts holds RCT v03, the ratified basis denominator.
    expect(isFinancialSourcePath('src/data/seed-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/data/public-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/replacement-cost.ts')).toBe(true);
  });
  it('flags the deal + common contracts (deal economics, confidential flag, Market enum)', () => {
    expect(isFinancialSourcePath('src/contracts/deal.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });
  it('ignores tests, docs, json, and non-financial source', () => {
    expect(isFinancialSourcePath('tests/unit/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('src/analytics/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('architecture/coding-standards.md')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('src/modules/principal/PrincipalModule.tsx')).toBe(false);
    expect(isFinancialSourcePath('src/lib/cn.ts')).toBe(false);
  });

  // 2026-07-24 (PR #233 follow-up): the LTV-bound episode proved a CONTRACT schema change can
  // carry direct governor blast radius — a bound briefly added to src/contracts/loan.ts's ltv
  // field made one bad workbook cell fail the entire portfolio snapshot, and the field feeds
  // computePortfolioAggregateLtv's Hard-Invariant-4 verdict. Yet no contracts file required a
  // refute trailer: the enforcement gate had the same file-enumeration blind spot the weekly
  // sweep's path list did. The four financial contracts are now classified as financial source.
  it('flags the financial contract schemas (loan/debt/warehouse/macro + capital pair)', () => {
    expect(isFinancialSourcePath('src/contracts/loan.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/debt.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/warehouse.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/macro.ts')).toBe(true);
    // Round-9 (fifth adversarial pass, all three lenses independently): capital.ts holds
    // HurdleRateConfig — the ratified hurdle-rate governor consumed by capital-allocation.ts and
    // calibration.ts — and capital-allocation.ts bounds the capstone scoring response. Both meet
    // the same inclusion criterion that added loan.ts; omitting them repeated the exact
    // enumeration blind spot this set exists to close.
    expect(isFinancialSourcePath('src/contracts/capital.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/capital-allocation.ts')).toBe(true);
  });

  it('still ignores non-financial contract schemas', () => {
    expect(isFinancialSourcePath('src/contracts/index.ts')).toBe(false);
    // common.ts moved to the financial set 2026-08-12 — see the case below. Deliberately narrow:
    // the barrel index stays out, so a re-export edit does not demand an attestation.
    expect(isFinancialSourcePath('src/contracts/lease.ts')).toBe(false);
    expect(isFinancialSourcePath('src/contracts/property.ts')).toBe(false);
  });

  // 2026-08-12: common.ts was explicitly pinned as NON-financial until this date. It holds the
  // Market enum, which keys RCT_V03 (the ratified replacement-cost denominator) and the cap-rate
  // benchmark table — so dropping or renaming a member silently unprices every deal in that market
  // rather than failing loudly. That meets this gate's stated inclusion criterion ("fields consumed
  // by governor/scoring math"). Accepted cost: the file also holds generic plumbing (Cell, slug,
  // DataQualityFlag), so unrelated edits there now need a trailer too. Fail closed on the enum
  // beats staying quiet on it.
  it('flags src/contracts/common.ts — the Market enum keys the RCT denominator', () => {
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });

  // Fix round 1, item 6 (Task 14 review): src/contracts/lease-market.ts carries LmThresholds (the
  // benchmark/similarity/radar governor thresholds) and CellBenchmark/ComparableStats — fields
  // consumed directly by the radar score and comparable-set math in
  // src/analytics/lease-market/{benchmarks,similarity,signals,radar}.ts. A silent field drop/rename
  // there would desync the contract from the math it types, the same governor-adjacent risk that put
  // loan.ts/debt.ts/capital.ts on this list.
  it('flags src/contracts/lease-market.ts — LmThresholds/CellBenchmark type the radar and comparable-set governor math', () => {
    expect(isFinancialSourcePath('src/contracts/lease-market.ts')).toBe(true);
  });

  // 2026-11-08 (medium-findings remediation Wave 1, E-2): the acquisition scorecard's own contract
  // and its client input-shaping were outside the gate, so a change to how a deal's SF / price /
  // IRR / market is turned into an AcquisitionInput (or to the Zod shape the engine parses) merged
  // with no attestation even though coding-standards requires the refute pass on the scorecard.
  // The same sweep found the literal governor constants (DSCR 1.25 / LTV 0.40), the ratified cash
  // floor, and the edge scoring Function outside it too.
  it('flags the acquisition scorecard contract and its input-shaping (2026-11-08)', () => {
    expect(isFinancialSourcePath('src/contracts/acquisition.ts')).toBe(true);
    expect(isFinancialSourcePath('src/modules/acquisitions/acquisition-score.ts')).toBe(true);
    // the edge copy of the score route: resolves the ratified config and applies the governor proxy
    expect(isFinancialSourcePath('functions/api/warehouse/acquisition/score.ts')).toBe(true);
  });
  it('flags the ratified governor and liquidity-floor constants (2026-11-08)', () => {
    expect(isFinancialSourcePath('src/contracts/governor-constants.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/liquidity-policy.ts')).toBe(true);
  });
  it('is case- and separator-insensitive for the 2026-11-08 additions, like every other entry', () => {
    expect(isFinancialSourcePath('src\\contracts\\Acquisition.ts')).toBe(true);
    expect(isFinancialSourcePath('SRC/modules/acquisitions/acquisition-score.ts')).toBe(true);
    expect(isFinancialSourcePath('functions\\api\\warehouse\\acquisition\\score.ts')).toBe(true);
  });
  it('keeps the 2026-11-08 additions narrow: neighbouring display and auth files stay out', () => {
    expect(isFinancialSourcePath('src/modules/acquisitions/AcquisitionWorkbench.tsx')).toBe(false);
    expect(isFinancialSourcePath('src/modules/acquisitions/tabs.ts')).toBe(false);
    expect(isFinancialSourcePath('functions/api/whoami.ts')).toBe(false);
    expect(isFinancialSourcePath('functions/_shared/access-identity.ts')).toBe(false);
    // tests of the newly-covered files stay exempt, like every other test
    expect(isFinancialSourcePath('src/modules/acquisitions/acquisition-score.test.ts')).toBe(false);
  });
  it('a commit touching only acquisition-score.ts now needs its own trailer', () => {
    const commits = [{ sha: 'a1', message: 'fix(acq): prefill portfolio SF', files: ['src/modules/acquisitions/acquisition-score.ts'] }];
    expect(findUnattestedCommits(commits).map((c) => c.sha)).toEqual(['a1']);
    const attested = [{ ...commits[0]!, message: 'fix(acq): prefill portfolio SF\n\nRefute-Reviewed: wf_d10ede49-078\n' }];
    expect(findUnattestedCommits(attested)).toEqual([]);
  });

  // Broad-prefix coverage (server/warehouse/, src/analytics/) already reaches these — asserted
  // explicitly so a future DELIVERY_ONLY_PATHS or prefix change can't silently exempt them.
  it('reaches lease-market math files via the existing broad prefixes', () => {
    expect(isFinancialSourcePath('server/warehouse/lease-market/compute.ts')).toBe(true);
    expect(isFinancialSourcePath('src/analytics/lease-market/radar.ts')).toBe(true);
  });
});

describe('check-refute-required — financial config prefix (weekly sweep 2026-09-21)', () => {
  // 2026-09-17 enumerated config/lease-market.json only and explicitly exempted
  // config/lease-market.costar-headers.json as "no governor math" — but that file's
  // rentPeriodDefault / rentBasisMap drive the x12 rent-period conversion and NNN/MG/IG basis
  // classification of every ingested rent. replacement-cost.v3.json (RCT v03) and
  // acquisition-ruleset.v1.json (0.65/0.90 basis floors) were also uncovered. config/ is now a
  // fail-closed prefix: every .json under it is financial unless explicitly subtracted.
  it.each([
    'config/lease-market.json',
    'config/lease-market.costar-headers.json',
    'config/replacement-cost.v3.json',
    'config/acquisition-ruleset.v1.json',
    'config/acquisition-ruleset.v1.proposed.json',
    'config/archive/acquisition-ruleset.v1.0.0.json',
  ])('flags %s', (p) => {
    expect(isFinancialSourcePath(p)).toBe(true);
  });
  it('flags a config file added later without anyone remembering to enumerate it', () => {
    expect(isFinancialSourcePath('config/some-future-thresholds.json')).toBe(true);
  });
  it('normalizes Windows separators', () => {
    expect(isFinancialSourcePath('config\\lease-market.costar-headers.json')).toBe(true);
    expect(isFinancialSourcePath('config\\replacement-cost.v3.json')).toBe(true);
  });
  it('keeps the non-financial subtraction list empty and visible', () => {
    // Adding to this set is a reviewed decision. If you are here to add a config, justify it.
    expect(NON_FINANCIAL_CONFIG_PATHS.size).toBe(0);
  });
  it('flags financial DATA json outside config/: the account-mapping seed and json inside financial source dirs', () => {
    expect(isFinancialSourcePath('docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/om-extract-fields.json')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/some-table.json')).toBe(true);
    expect(isFinancialSourcePath('src/analytics/some-thresholds.json')).toBe(true);
  });
  it('exempts the self-labelled placeholder fixtures (Gabriel, 2026-09-21) but nothing else beside them', () => {
    for (const f of ['dec-pages', 'depreciable-basis', 'filed-returns', 'loss-runs']) {
      expect(isFinancialSourcePath(`server/warehouse/placeholders/${f}.placeholder.json`)).toBe(false);
      expect(isFinancialSourcePath(`server\\warehouse\\placeholders\\${f}.placeholder.json`)).toBe(false);
    }
    // a sibling json in the same directory tree is still financial
    expect(isFinancialSourcePath('server/warehouse/om-extract-fields.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/placeholders-real/x.json')).toBe(true);
    // only the *.placeholder.json fixtures directly in the folder: a future non-placeholder json is NOT exempt
    expect(isFinancialSourcePath('server/warehouse/placeholders/anything.json')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/placeholders/sub/deep.placeholder.json')).toBe(true);
  });
  it('still exempts .json outside config/ — the blanket rule applies elsewhere', () => {
    expect(isFinancialSourcePath('docs/superpowers/specs/some-other-spec.json')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('data/snapshots/portfolio.json')).toBe(false);
  });
});

describe('check-refute-required — AR delinquency subsystem (sweep 2026-09-22)', () => {
  // 2026-09-22: the SIXTH occurrence of the scope-staleness mode. server/ar/** — tenant-name →
  // Lease.id matching, confidence partitioning, latest-as-of resolution, dropped-lease clears — is
  // what decides WHICH lease a delinquency balance attaches to, and scripts/ar-import-headless.ts
  // writes those balances (tenantArrears / arBalances) into the overlay and snapshot unattended.
  // Against a real diff touching match-tenant.ts + ar-import-headless.ts, `check:refute --strict`
  // reported "no financial-decision source files changed". The weekly sweep's own SKILL.md has
  // listed `server/ar/**, scripts/ar-import-headless.ts, scripts/seed-ar-mappings.ts` in scope
  // since 2026-08-17; the gate that is supposed to enforce that sweep never did. Same remedy as
  // workbook/sources: a directory prefix (fails closed on new files) plus the named scripts.
  it('flags server/ar/ — the attribution matchers, the mapping cache, and the arrears resolvers', () => {
    expect(isFinancialSourcePath('server/ar/match-tenant.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/partition-confidence.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/mapping-cache.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/resolve-latest.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/resolve-by-unit.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/clear-dropped-leases.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/derive-ar-balances.ts')).toBe(true);
    // the report parsers turn PDF/xlsx text into per-tenant balances — figures, not plumbing
    expect(isFinancialSourcePath('server/ar/ar-aging.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/rent-manager-delinquency.ts')).toBe(true);
    // a file added to the directory later is in scope by default
    expect(isFinancialSourcePath('server/ar/some-future-matcher.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\ar\\match-tenant.ts')).toBe(true);
  });
  it('flags the AR writer scripts: the headless feed and the hand-confirmed mapping seed', () => {
    expect(isFinancialSourcePath('scripts/ar-import-headless.ts')).toBe(true);
    // seed-ar-mappings.ts hardcodes human-ruled tenant→lease attributions and writes them into the
    // cache; editing which lease a name resolves to is the same decision class as the matcher.
    expect(isFinancialSourcePath('scripts/seed-ar-mappings.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\ar-import-headless.ts')).toBe(true);
    // Refute pass: the interactive importer holds its own `autoAccept` attribution threshold and
    // writes cache entries + arrears; the sweep SKILL.md's scope list omits it — same stale-enumeration
    // mode as everything above.
    expect(isFinancialSourcePath('scripts/ar-import.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\ar-import.ts')).toBe(true);
  });
  it('treats a .json inside server/ar/ as financial data, like the other financial source dirs', () => {
    expect(isFinancialSourcePath('server/ar/tenant-aliases.json')).toBe(true);
    expect(isFinancialSourcePath('server\\ar\\property-headers.json')).toBe(true);
  });
  it('still ignores AR tests', () => {
    expect(isFinancialSourcePath('tests/unit/mapping-cache.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/ar/match-tenant.test.ts')).toBe(false);
  });
  // Same 2026-09-21 failure mode, missed for two files: the blanket `.json` exemption also covered
  // data/ar-mapping-cache.json (persistent tenant-name → Lease.id map incl. durable human SKIP
  // rulings — it governs which delinquency rows auto-attribute without review) and data/overlay.json
  // (the canonical mutation store the headless feed writes arrears into). overlay.json is gitignored,
  // so the entry is defense-in-depth against a force-add; the cache IS tracked and PR-committed.
  it('flags the AR mapping cache and the overlay store — top-level data/ json the blanket rule exempted', () => {
    expect(isFinancialSourcePath('data/ar-mapping-cache.json')).toBe(true);
    expect(isFinancialSourcePath('data/overlay.json')).toBe(true);
    expect(isFinancialSourcePath('data\\ar-mapping-cache.json')).toBe(true);
  });
  it('does not widen to the rest of data/ — the snapshot and review queue stay exempt', () => {
    expect(isFinancialSourcePath('data/snapshots/portfolio.json')).toBe(false);
    expect(isFinancialSourcePath('data/ar/review-queue.json')).toBe(false);
  });
});

describe('check-refute-required — default-deny roots server/ and scripts/ (Gabriel, 2026-09-22)', () => {
  // Six times by the identical mechanism (contracts 2026-07-24, workbook 2026-08-11, sources
  // 2026-08-12, AR data 2026-08-17, config/data json 2026-09-21, server/ar + writer scripts
  // 2026-09-22) a financial subsystem landed in a directory the allow-list had not been told about,
  // and this gate said "no financial-decision source files changed" until someone noticed. An
  // allow-list defaults every unlisted path to NOT financial — the unsafe direction. server/ and
  // scripts/ are now DEFAULT-DENY: every path under them is financial-decision source unless it is
  // named in NON_FINANCIAL_ROOT_PATHS with a justification. The cases below are files that exist on
  // main today, hold financial decisions, and were NOT reached by any prefix or name before this.
  it('flags top-level server/ files no prefix ever reached', () => {
    // brain.ts orchestrates the snapshot: which QuickBooks block wins, when persist() declines.
    expect(isFinancialSourcePath('server/brain.ts')).toBe(true);
    // reconcile-runtime.ts holds the NOI / rent / cash invariants and the 1% unresolved-rent share.
    expect(isFinancialSourcePath('server/reconcile-runtime.ts')).toBe(true);
    // anomaly-floor.ts is the refusal threshold on every lease-set write.
    expect(isFinancialSourcePath('server/anomaly-floor.ts')).toBe(true);
    // config.ts holds WORKBOOK_AS_OF / referenceDate — the run-date basis for WALT and day-counts.
    expect(isFinancialSourcePath('server/config.ts')).toBe(true);
    // index.ts is the write surface: noi-budget, tenant-arrears, market-rent, acquisition-input.
    expect(isFinancialSourcePath('server/index.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\brain.ts')).toBe(true);
  });
  it('flags server/ subdirectories no prefix ever reached', () => {
    // insights/: the ranking weights and the honesty constants (MIN_PAIRS) behind every insight.
    expect(isFinancialSourcePath('server/insights/rank.ts')).toBe(true);
    expect(isFinancialSourcePath('server/insights/stats.ts')).toBe(true);
    expect(isFinancialSourcePath('server/insights/generators/cf-hurdle-drag.ts')).toBe(true);
    // macro/: the DGS5 market rate conditions.ts reads, and the cap-rate benchmark bands.
    expect(isFinancialSourcePath('server/macro/fred.ts')).toBe(true);
    expect(isFinancialSourcePath('server/macro/market-benchmarks.ts')).toBe(true);
    // brief/: the collections alerts' confirm-clear lifecycle and the daily-brief conditions run.
    expect(isFinancialSourcePath('server/brief/run.ts')).toBe(true);
    expect(isFinancialSourcePath('server/brief/state.ts')).toBe(true);
    // briefing/compose.ts selects which engine figures a briefing carries; confidential.ts is the
    // Hard-Invariant-3 scanner behind it.
    expect(isFinancialSourcePath('server/briefing/compose.ts')).toBe(true);
    expect(isFinancialSourcePath('server/briefing/confidential.ts')).toBe(true);
    // notion/capital-writeback.ts persists capitalAction + priorityScore into the Property Register.
    expect(isFinancialSourcePath('server/notion/capital-writeback.ts')).toBe(true);
    // reconcile/: the workbook-vs-Notion lease reconciliation.
    expect(isFinancialSourcePath('server/reconcile/lease-source-reconciliation.ts')).toBe(true);
    // ai/: the tools that decide which figures the agent quotes, and the comps egress guard.
    expect(isFinancialSourcePath('server/ai/tools.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ai/comps.ts')).toBe(true);
    // lib/pdf-text.ts is the input boundary of every PDF figure — same reasoning that kept
    // server/ar/pdf-extract.ts in scope.
    expect(isFinancialSourcePath('server/lib/pdf-text.ts')).toBe(true);
    // alerts/store.ts persists which collections/DSCR alerts are acknowledged or snoozed.
    expect(isFinancialSourcePath('server/alerts/store.ts')).toBe(true);
  });
  it('flags the warehouse access boundary — a silent weakening exposes every figure at once', () => {
    expect(isFinancialSourcePath('server/access-authz.ts')).toBe(true);
    expect(isFinancialSourcePath('server/host-guard.ts')).toBe(true);
    expect(isFinancialSourcePath('server/cors-policy.ts')).toBe(true);
    expect(isFinancialSourcePath('server/rate-limit.ts')).toBe(true);
  });
  it('flags scripts/ writers and gates that were never named', () => {
    // extract-workbook.ts and lease-snapshot-drift-check.ts WRITE data/snapshots/portfolio.json.
    expect(isFinancialSourcePath('scripts/extract-workbook.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lease-snapshot-drift-check.ts')).toBe(true);
    // bake-mirror.ts / bake-warehouse.ts publish the snapshot and computed route payloads externally.
    expect(isFinancialSourcePath('scripts/bake-mirror.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/bake-warehouse.ts')).toBe(true);
    // debt-scores-snapshot.ts persists DSCR verdicts; debt-snapshot-backfill.ts writes debt_positions.
    expect(isFinancialSourcePath('scripts/debt-scores-snapshot.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/debt-snapshot-backfill.ts')).toBe(true);
    // calibration-refit.ts proposes health weights; calibration-snapshot.ts logs verdicts.
    expect(isFinancialSourcePath('scripts/calibration-refit.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/calibration-snapshot.ts')).toBe(true);
    // importers write premiums / tax assessments into the warehouse.
    expect(isFinancialSourcePath('scripts/import-insurance-data.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/import-assessments.ts')).toBe(true);
    // the workbook / warehouse / NOI reconciliation gates and the lease-market CLI.
    expect(isFinancialSourcePath('scripts/reconcile.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/reconcile-noi-crosscheck.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/warehouse-verify.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/warehouse-backfill.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lease-market.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/migrate-lease-overlay-ids.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts\\extract-workbook.ts')).toBe(true);
  });
  it('flags scripts/ files in other languages — the root is what matters, not the extension', () => {
    // The owner-screen bridge classifies which owners may be called (fail-closed guard).
    expect(isFinancialSourcePath('scripts/lease-market-owner-screen.py')).toBe(true);
    // deploy-mirror.ps1 sets MIRROR_INCLUDE_CONFIDENTIAL=1 and owns the Access-gate probe that keeps
    // a confidential bake from being left publicly reachable — Hard-Invariant-3 wiring.
    expect(isFinancialSourcePath('scripts/deploy-mirror.ps1')).toBe(true);
    // lib/deploy-alert.ps1 (refute pass, 2026-09-22): Test-SuppressibleReason + the -Critical guard
    // decide whether the GATE CHECK FAILED (confidential bake publicly reachable) alert can be
    // suppressed — the same Hard-Invariant-3 wiring that keeps deploy-mirror.ps1 in scope. Its
    // sibling helpers (beacon, buildroot, timeouts) stay exempt.
    expect(isFinancialSourcePath('scripts/lib/deploy-alert.ps1')).toBe(true);
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/lib/deploy-alert.ps1')).toBe(false);
    // The pre-push confidentiality scanner and the installer that decides whether it blocks.
    expect(isFinancialSourcePath('scripts/prepush-confidential-scan.mjs')).toBe(true);
    expect(isFinancialSourcePath('scripts/install-git-hooks.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/prepare-hooks.mjs')).toBe(true);
    expect(isFinancialSourcePath('scripts/prepush-noi-crosscheck.mjs')).toBe(true);
    // governance-check.ts carries checkGovernorLiteralCoupling — the DSCR/LTV literal-drift guard.
    expect(isFinancialSourcePath('scripts/governance-check.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/check-snapshot-freshness.ts')).toBe(true);
  });
  it('flags this gate itself — the file that defines the financial scope is in that scope', () => {
    expect(isFinancialSourcePath('scripts/check-refute-required.ts')).toBe(true);
  });
  it('flags a subsystem added later without anyone remembering to enumerate it', () => {
    // The seventh occurrence cannot happen by this mechanism: an unlisted directory is IN scope.
    expect(isFinancialSourcePath('server/some-future-subsystem/engine.ts')).toBe(true);
    expect(isFinancialSourcePath('server/new-top-level-file.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/some-future-writer.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/lib/some-future-helper.ps1')).toBe(true);
    expect(isFinancialSourcePath('scripts/new-dir/anything.mjs')).toBe(true);
  });
  it('still reaches every path the retired explicit prefixes and names covered', () => {
    // These were the six patched-in entries. Under default-deny they are reached by the root; this
    // pins that folding the prefixes into the root never narrowed coverage.
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/parse.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/notion-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('server/ar/match-tenant.ts')).toBe(true);
    expect(isFinancialSourcePath('server/overlay.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/ar-import-headless.ts')).toBe(true);
    expect(isFinancialSourcePath('scripts/seed-ar-mappings.ts')).toBe(true);
    // ar-import.ts is reached by the root — the weekly sweep SKILL.md no longer needs to name it.
    expect(isFinancialSourcePath('scripts/ar-import.ts')).toBe(true);
  });
  it('keeps the test / doc / json rules ahead of the root rule', () => {
    expect(isFinancialSourcePath('server/brain.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/insights/rank.spec.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/debt-maturity.DESIGN.md')).toBe(false);
    expect(isFinancialSourcePath('scripts/README.md')).toBe(false);
    // scripts/data/*.json is an ingest receipt nothing reads back (import-insurance-data.ts writes
    // it); the blanket .json rule still applies outside the FINANCIAL_JSON_PREFIXES — unchanged.
    expect(isFinancialSourcePath('scripts/data/2026-08-22-insurance-premium-history.json')).toBe(false);
    // …but a .json ANYWHERE under server/ is financial data (refute pass, 2026-09-22): the header's
    // "every path under server/ is financial" was untrue for a weights or benchmark table dropped
    // beside the source that reads it, because the blanket .json exemption runs before the root
    // rule. FINANCIAL_JSON_PREFIXES now carries 'server/' (subsuming warehouse/workbook/ar).
    expect(isFinancialSourcePath('server/insights/weights.json')).toBe(true);
    expect(isFinancialSourcePath('server/macro/benchmarks.json')).toBe(true);
    expect(isFinancialSourcePath('server/some-future-subsystem/table.json')).toBe(true);
    expect(isFinancialSourcePath('server\\macro\\benchmarks.json')).toBe(true);
    // The reviewed placeholder subtraction is unchanged.
    expect(isFinancialSourcePath('server/warehouse/placeholders/loss-runs.placeholder.json')).toBe(false);
  });
  it('keeps the DELIVERY_ONLY_PATHS subtractions ahead of the root rule', () => {
    expect(isFinancialSourcePath('server/warehouse/debt-api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/graph-auth.ts')).toBe(false);
  });
  it('exposes the two roots so a future edit cannot silently drop one', () => {
    expect([...DEFAULT_DENY_ROOTS]).toEqual(['server/', 'scripts/']);
  });
});

describe('check-refute-required — reviewed non-financial exemptions under the default-deny roots', () => {
  // Every entry below was read (2026-09-22 survey) and exempted for a stated reason; each holds no
  // financial figure, threshold, mapping or writer, is not an input/output boundary for one, and is
  // not Hard-Invariant-3 gate wiring. Adding to this set is a reviewed decision — justify it inline
  // in NON_FINANCIAL_ROOT_PATHS, then add the path here with the same reason.
  it('exempts server/ plumbing that carries no figure', () => {
    // .env KEY=VALUE loader with override-on-empty.
    expect(isFinancialSourcePath('server/load-env.ts')).toBe(false);
    // Outlook COM transport + data/outbox fallback; recipients and content are decided in run.ts.
    expect(isFinancialSourcePath('server/brief/send.ts')).toBe(false);
    // attachment-filename sanitizer.
    expect(isFinancialSourcePath('server/briefing/filename.ts')).toBe(false);
    // brand tokens + font registration, and the WOFF1 -> TTF decoder behind it.
    expect(isFinancialSourcePath('server/briefing/theme.ts')).toBe(false);
    expect(isFinancialSourcePath('server/briefing/woff-to-ttf.ts')).toBe(false);
    // pure BriefingModel -> PDF renderer; every figure is read off the model (ic-memo.ts precedent).
    expect(isFinancialSourcePath('server/briefing/pdf.tsx')).toBe(false);
    expect(isFinancialSourcePath('server\\briefing\\pdf.tsx')).toBe(false);
  });
  it('exempts scripts/ dev tooling that never touches a figure', () => {
    // bundle-size gate, dev-CSS parse gate, dev-server startup watchdog, npm-ci self-heal.
    expect(isFinancialSourcePath('scripts/check-bundle.ts')).toBe(false);
    expect(isFinancialSourcePath('scripts/check-dev-css.ts')).toBe(false);
    expect(isFinancialSourcePath('scripts/dev-watchdog.cjs')).toBe(false);
    expect(isFinancialSourcePath('scripts/ensure-deps.mjs')).toBe(false);
    // static analysis over route/migration/Zod source text — reads no figure, writes no table.
    expect(isFinancialSourcePath('scripts/check-write-schema-drift.ts')).toBe(false);
    // document-embedding driver (server/sources/documents.ts is already delivery-only).
    expect(isFinancialSourcePath('scripts/index-docs.ts')).toBe(false);
    // git-worktree helper.
    expect(isFinancialSourcePath('scripts/safe-worktree.ts')).toBe(false);
  });
  it('exempts the Windows scheduled-task and mirror-deploy ops helpers (the historical false-positive class)', () => {
    // 17 ops PRs (#172 … #341) touched only these; none decided a figure. deploy-mirror.ps1 itself
    // stays IN scope (confidential bake flag + Access-gate probe) — only its helpers are exempt.
    for (const p of [
      'scripts/mirror-run-classify.ps1',
      'scripts/mirror-classify-offfleet.ps1',
      'scripts/register-brain-server-task.ps1',
      'scripts/register-mirror-classify-offfleet-task.ps1',
      'scripts/register-mirror-task.ps1',
      'scripts/reindex-loop.ps1',
      'scripts/start-brain-server.ps1',
      'scripts/stop-brain-server.ps1',
      'scripts/lib/cmd-arg-guard.ps1',
      'scripts/lib/deploy-beacon.ps1',
      'scripts/lib/deploy-buildroot.ps1',
      'scripts/lib/git-capture.ps1',
      'scripts/lib/job-timeout.ps1',
      'scripts/lib/mirror-task-action.ps1',
      'scripts/lib/native-timeout.ps1',
    ]) {
      expect(isFinancialSourcePath(p), p).toBe(false);
      expect(isFinancialSourcePath(p.replace(/\//g, '\\')), p).toBe(false);
    }
  });
  it('exempts PowerShell smoke tests as test scaffolding, in scripts/ and scripts/lib/ only', () => {
    expect(isFinancialSourcePath('scripts/deploy-beacon.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts/mirror-run-classify.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts/lib/fake-mailer.smoke-test.ps1')).toBe(false);
    expect(isFinancialSourcePath('scripts\\job-timeout.smoke-test.ps1')).toBe(false);
    // a future smoke test is still a test …
    expect(isFinancialSourcePath('scripts/some-future.smoke-test.ps1')).toBe(false);
    // … but the suffix alone does not exempt a file outside those two folders or a non-ps1.
    expect(isFinancialSourcePath('scripts/deep/nested.smoke-test.ps1')).toBe(true);
    expect(isFinancialSourcePath('scripts/something.smoke-test.ts')).toBe(true);
  });
  it('exposes the exemption set with the expected membership so a silent widening is visible', () => {
    expect(NON_FINANCIAL_ROOT_PATHS.size).toBe(28);
    for (const p of NON_FINANCIAL_ROOT_PATHS) {
      expect(p.startsWith('server/') || p.startsWith('scripts/'), p).toBe(true);
      expect(isFinancialSourcePath(p), p).toBe(false);
    }
    // No entry may name a path that a narrower, already-reviewed rule keeps in scope.
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/deploy-mirror.ps1')).toBe(false);
    expect(NON_FINANCIAL_ROOT_PATHS.has('scripts/check-refute-required.ts')).toBe(false);
  });
});

describe('check-refute-required — delivery-only allowlist', () => {
  it('treats delivery-only warehouse routing files as non-financial', () => {
    expect(isFinancialSourcePath('server/warehouse/debt-api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/actions.ts')).toBe(false);
    // Phase 3 W1: lease-forecast-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-forecast-api.ts')).toBe(false);
    // Lease Market Intelligence P1 Task 14: lease-market-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-market-api.ts')).toBe(false);
    // Windows separators normalize before set lookup
    expect(isFinancialSourcePath('server\\warehouse\\debt-api.ts')).toBe(false);
  });
  // 2026-11-09 (refute run wf_44a3341e-b41, medium; architect sign-off: Gabriel (architect) approved
  // 2026-11-09). server/warehouse/api.ts is NOT pure plumbing: its POST /acquisition/score handler
  // resolves the ratified config, calls scoreAcquisition and applies the governor proxy, and it owns
  // the /acq/intel verdict-rank ORDER BY. Its edge twin functions/api/warehouse/acquisition/score.ts
  // was gated by the 2026-11-08 sweep, so the two halves of one governor-proxy contract had different
  // attestation requirements. Both must classify the same way.
  it('classifies the Brain Server and edge acquisition-score routes the same way (both financial)', () => {
    const brain = isFinancialSourcePath('server/warehouse/api.ts');
    const edge = isFinancialSourcePath('functions/api/warehouse/acquisition/score.ts');
    expect(brain).toBe(edge);
    expect(brain).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/api.ts')).toBe(false);
    expect(isFinancialSourcePath('Server\\Warehouse\\API.ts')).toBe(true);
    const commits = [{ sha: 'b1', message: 'fix(acq): reorder intel ranking', files: ['server/warehouse/api.ts'] }];
    expect(findUnattestedCommits(commits).map((c) => c.sha)).toEqual(['b1']);
  });
  it('still flags non-allowlisted warehouse files', () => {
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/debt-scoring.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/acq-engine.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/queries.ts')).toBe(true);
    // lease-velocity.ts holds financial math — must NOT be in delivery-only
    expect(isFinancialSourcePath('server/warehouse/lease-velocity.ts')).toBe(true);
  });
  it('exposes the delivery-only allowlist with the expected membership', () => {
    expect(DELIVERY_ONLY_PATHS.size).toBe(10);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/debt-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/actions.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-forecast-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-market-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/capital-allocation-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/property-onboarding.ts')).toBe(true);
    // server/sources/ subtractions, added with the prefix 2026-08-12: transport and indexing
    // plumbing that carries no deal or portfolio figures.
    expect(DELIVERY_ONLY_PATHS.has('server/sources/graph-auth.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/m365-tasks.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/documents.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/ic-memo.ts')).toBe(true);
  });
});

describe('check-refute-required — trailer detection', () => {
  it('detects Refute-Reviewed / Refute-Skip in a commit message (case-insensitive)', () => {
    expect(hasRefuteApproval('fix: x\n\nRefute-Reviewed: wf_abc123')).toBe(true);
    expect(hasRefuteApproval('chore\n\nRefute-Skip: docs-only adjustment')).toBe(true);
    expect(hasRefuteApproval('refute-reviewed: wf_fixture0-x')).toBe(true);
  });
  it('returns false when no attestation trailer is present', () => {
    expect(hasRefuteApproval('fix: something\n\nCo-Authored-By: someone')).toBe(false);
    expect(hasRefuteApproval('')).toBe(false);
  });
});

// 2026-09-23: attestation is per COMMIT, not per range. The gate used to search the concatenated
// `git log base..HEAD` blob, so one Refute-Skip anywhere attested every commit in the PR.
describe('check-refute-required — trailer value', () => {
  it('a trailer needs a real value on its own line', () => {
    expect(hasRefuteApproval('fix\n\nRefute-Skip:\n')).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip:   \n')).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip:\nnot a value on the same line\n')).toBe(false);
    expect(hasRefuteApproval('fix\n\n  Refute-Skip: indented is still a trailer\n')).toBe(true);
  });
  it('a trailer mentioned mid-line (subject or body prose) does not attest', () => {
    expect(hasRefuteApproval('fix(analytics): stop honouring a stale Refute-Skip: marker in dedup\n')).toBe(false);
    expect(hasRefuteApproval('fix: x\n\nWe used to accept Refute-Reviewed: anywhere in the body.\n')).toBe(false);
  });

  it("pasting the gate's own hint line does not attest", () => {
    expect(
      hasRefuteApproval('fix\n\n    Refute-Reviewed: wf_<runId>        (or, with justification)  Refute-Skip: <reason>\n'),
    ).toBe(false);
    expect(hasRefuteApproval('fix\n\nRefute-Skip: <reason>\n')).toBe(false);
    // A second, real trailer in the same message still counts.
    expect(hasRefuteApproval('fix\n\nRefute-Skip: <reason>\nRefute-Reviewed: wf_fixture0-real1\n')).toBe(true);
  });
});

// `Refute-Reviewed: PENDING` used to pass as if a refute ran. Ratified 2026-09-27: prose records of a
// non-workflow review stay valid; only placeholders and fake run ids are rejected.
describe('check-refute-required — Refute-Reviewed value', () => {
  it.each([
    'wf_d10ede49-078',
    'wf_c23f5fd8-ddf + 3 independent Opus adversarial passes',
    'wf_e4c405d9-2ff wf_d8fd3fce-646',
    'wf_refute-financial-change_m5',
    'five-mandate adversarial merge gate (Opus 5.5 subagents, 2 rounds)',
    'Fable 5.1 adversarial pass 2026-09-17 — 3 findings, 3 fixed',
    'refute-financial-change x5 (wf_d0987dd9-c8c, wf_1a2b3c4d-5e6)',
    // Merge-gate round 3: prose that merely contains angle brackets is not an unfilled blank.
    'adversarial pass — both CLIs leak their .tmp-<pid>-<ts> on an exhausted rename (#367)',
    'Map<string> type-only change',
    'Record<string, number> to ReadonlyMap',
    'compares a<b and c>d only',
    '<b>display-only</b> markup',
    'reviewed by Gabriel <ggoldberg@oxfordra.net>',
    'see <https://example.com/run/42> for the transcript',
    // A real run id followed by punctuation is still a real run id.
    'wf_d10ede49-078: 0 findings',
    "wf_d10ede49-078's three lenses",
    'wf_d10ede49-078/opus',
    'wf_d10ede49-078! clean',
  ])('accepts Refute-Reviewed: %s', (value) => {
    expect(hasRefuteApproval(`fix\n\nRefute-Reviewed: ${value}\n`)).toBe(true);
  });
  it.each([
    'PENDING', 'pending', 'TODO', 'TBD', 'N/A', 'n.a.', 'none', '???', '---', 'yes', 'done', 'reviewed',
    '"TODO"', '(pending)', 'TODO​', '​PENDING', 'wf_pending', 'wf_------', 'wf_todotbd', 'wf_PENDING1',
    // Merge-gate round 2: trailing punctuation, autocorrected dashes/ellipsis, Markdown emphasis.
    'TODO?', 'TODO,', 'TODO;', 'pass', 'passed', '—', '–', '…', '*', '#', '**TODO**', '_TODO_',
    // Unfilled template blanks, and the gate's own hint disguised by wrapping.
    '<reviewer/run ref>', 'Fable 5.1 adversarial pass <date> — <n> findings, <m> fixed',
    '"<reason>"', '[<reason>]', '​<reason>', 'reason',
    // Merge-gate round 3.
    'ok', 'OK.', 'route-only — <file(s)> contain no financial math', 'wf_<id>', 'x <date> y',
    // Merge-gate round 4: wrapped whole-value blanks, a blank right after a wrapper / invisible
    // character (normalized-value check), and blanks followed by 's / % + #.
    '`<run id>`', '"<run id>"', "'<date>'", '[<date>]', '*<date>*', '**<reviewer/run ref>**', '(<reason for skip>)',
    '"<date> — 0 findings"', '**<date> pass**', '​<date> pass',
    "Fable pass <date>'s findings", 'scored <n>/5', '<n>% coverage', '<n>+ lenses', 'pass at <sha>#L1',
  ])('rejects Refute-Reviewed: %j', (value) => {
    expect(hasRefuteApproval(`fix\n\nRefute-Reviewed: ${value}\n`)).toBe(false);
  });
  it('explains each rejection', () => {
    const [pending] = rejectedRefuteTrailers('fix\n\nRefute-Reviewed: PENDING\n');
    expect(pending).toMatch(/Refute-Reviewed: PENDING — rejected: placeholder/);
    const [fake] = rejectedRefuteTrailers('fix\n\nRefute-Reviewed: wf_pending\n');
    expect(fake).toMatch(/"wf_pending" poses as a refute run id/);
    expect(rejectedRefuteTrailers('fix\n\nRefute-Reviewed: wf_d10ede49-078\n')).toEqual([]);
    // A wrapped hint is named as the gate's own hint (pins the normalized-value hint check).
    for (const v of ['"wf_<runId>"', '(wf_<runId>)', '**wf_<runId>**']) {
      expect(rejectedRefuteTrailers(`fix\n\nRefute-Reviewed: ${v}\n`)[0]).toMatch(/the gate's own placeholder/);
    }
    const [blank] = rejectedRefuteTrailers('fix\n\nRefute-Reviewed: pass <date> — <n> findings\n');
    expect(blank).toMatch(/unfilled template blank "<date>"/);
    // Only the normalized-value check can see this blank (a quote, not whitespace, precedes it raw).
    const [wrapped] = rejectedRefuteTrailers('fix\n\nRefute-Reviewed: "<date> — 0 findings"\n');
    expect(wrapped).toMatch(/unfilled template blank "<date>"/);
  });
  it('a placeholder Refute-Reviewed does not mask a valid Refute-Skip in the same message', () => {
    expect(hasRefuteApproval('fix\n\nRefute-Reviewed: TODO\nRefute-Skip: formatting only\n')).toBe(true);
  });
  // Every distinct trailer line on origin/main as of the sha in the fixture header. A tightening of the rule
  // must never reject what main already carries — round 3 caught exactly that (#367's `<pid>`).
  it('every historical trailer line on main still attests', () => {
    const fixture = readFileSync(resolve(__dirname, '../fixtures/refute-trailers-main.txt'), 'utf8');
    const lines = fixture.split('\n').filter((l) => /^Refute-(?:Reviewed|Skip):/i.test(l));
    expect(lines.length).toBeGreaterThan(200);
    const rejected = lines.filter((l) => !hasRefuteApproval(`x\n\n${l}\n`));
    expect(rejected).toEqual([]);
  });
  it('CRLF messages behave the same', () => {
    expect(hasRefuteApproval('fix\r\n\r\nRefute-Reviewed: wf_d10ede49-078\r\n')).toBe(true);
    expect(hasRefuteApproval('fix\r\n\r\nRefute-Reviewed: PENDING\r\n')).toBe(false);
  });
});

describe('check-refute-required — run qualifier grammar', () => {
  it.each([
    'wf_d10ede49-078',
    'wf_d10ede49-078 (clean)',
    'wf_d10ede49-078 (scoped)',
    'wf_d10ede49-078 (effort=low)',
    'wf_d10ede49-078 (EFFORT=XHigh)',
    'wf_d10ede49-078 (base-workflow)',
    'wf_d10ede49-078 (scoped, effort=max, base-workflow)',
    'wf_d10ede49-078 (partial: security lens failed twice, rerun pending on the follow-up)',
    'wf_d10ede49-078 (effort=low, accepted: one low, doc wording; fixed in next commit)',
    'wf_d10ede49-078 (opus 5.5 subagents)',
    'wf_d10ede49-078 (cleanly applied)',
    'wf_d10ede49-078: clean (scoped)',
    // main's own phrasing (#480): a note after `clean:` is free text, commas and all.
    'wf_911caeac-216 (clean: nothing above LOW; reviewed commit 13ec71df, tree bc5c2d19; 3 lows fixed, 1 deferred)',
    'wf_d10ede49-078 (scoped: guard only, mechanism out of scope)',
    // Nested parentheses inside a reason or note are part of it.
    'wf_d10ede49-078 (partial: security lens failed (timeout), rerun pending)',
    'wf_d10ede49-078 (effort=low, accepted: one low (doc wording), fixed next commit)',
    // Text after the closing paren is prose.
    'wf_d10ede49-078 (scoped) see the PR (#500) for the change set',
    // Head word not followed by , : = ) or the end is prose.
    'wf_d10ede49-078 (scoped to the ingest change)',
    'wf_d10ede49-078 (accepted 2 MEDIUMs)',
    'wf_d10ede49-078 (clean-up only)',
    'wf_d10ede49-078 (clean (opus 5.5))',
    // A note or reason runs to the next comma segment that starts a qualifier item, so item order is free.
    'wf_d10ede49-078 (clean: fine, effort=low)',
    'wf_d10ede49-078 (effort=low, clean: fine)',
    'wf_d10ede49-078 (accepted: one low, doc wording, scoped)',
  ])('accepts %j', (value) => {
    expect(rejectedRefuteTrailers(`fix\n\nRefute-Reviewed: ${value}\n`)).toEqual([]);
    expect(hasRefuteApproval(`fix\n\nRefute-Reviewed: ${value}\n`)).toBe(true);
  });
  it.each([
    ['wf_d10ede49-078 (effort=ultra)', /effort level "ultra"/],
    ['wf_d10ede49-078 (effort=)', /effort level ""/],
    ['wf_d10ede49-078 (effort)', /unknown qualifier "effort"/],
    ['wf_d10ede49-078 (partial)', /unknown qualifier "partial"/],
    ['wf_d10ede49-078 (partial:)', /needs a real reason/],
    ['wf_d10ede49-078 (accepted: TODO)', /needs a real reason/],
    ['wf_d10ede49-078 (accepted: <findings>)', /unfilled template blank "<findings>"/],
    ['wf_d10ede49-078 (scoped, bogus)', /unknown qualifier "bogus"/],
    // The grammar survives parentheses inside the qualifier (was: fell back to prose and attested).
    ['wf_d10ede49-078 (effort=bogus (note))', /unknown qualifier "effort=bogus/],
    ['wf_d10ede49-078 (clean, partial: TODO (x))', /contradicts|needs a real reason/],
    ['wf_d10ede49-078 (effort=low, effort=max)', /given twice/],
    ['wf_d10ede49-078 (scoped, scoped)', /given twice/],
    // Order independence: a note placed first must not swallow a later item.
    ['wf_d10ede49-078 (clean: fine, scoped)', /contradicts/],
    ['wf_d10ede49-078 (scoped, clean: fine)', /contradicts/],
    ['wf_d10ede49-078 (clean: x, effort=ultra)', /effort level "ultra"/],
    ['wf_d10ede49-078 (effort=ultra, clean: x)', /effort level "ultra"/],
    ['wf_d10ede49-078 (scoped: x, scoped)', /given twice/],
    ['wf_d10ede49-078 (base-workflow: note, effort=bogus, partial: )', /effort level "bogus"/],
    ['wf_d10ede49-078 (partial: one lens failed, clean)', /contradicts/],
    ['wf_d10ede49-078 (partial: wf_<runId>)', /needs a real reason/],
    // A wrapper around the id must not hide the qualifier.
    ['(wf_d10ede49-078) (effort=zzz)', /effort level "zzz"/],
    ['`wf_d10ede49-078` (effort=zzz)', /effort level "zzz"/],
    ['"wf_d10ede49-078" (scoped, bogus)', /unknown qualifier "bogus"/],
    ['[wf_d10ede49-078] (effort=ultra)', /effort level "ultra"/],
    ['wf_d10ede49-078 (clean, partial: one lens failed)', /contradicts/],
    ['wf_d10ede49-078 (clean, scoped)', /contradicts/],
  ])('rejects %j', (value, why) => {
    expect(hasRefuteApproval(`fix\n\nRefute-Reviewed: ${value}\n`)).toBe(false);
    expect(rejectedRefuteTrailers(`fix\n\nRefute-Reviewed: ${value}\n`)[0]).toMatch(why);
  });
  it('a malformed qualifier does not mask a valid Refute-Skip in the same message', () => {
    expect(hasRefuteApproval('fix\n\nRefute-Reviewed: wf_d10ede49-078 (effort=ultra)\nRefute-Skip: formatting only\n')).toBe(true);
  });
});

describe('check-refute-required — Refute-Skip semantics unchanged', () => {
  it('any real justification still passes, including ones starting with a placeholder-ish word', () => {
    expect(hasRefuteApproval('fix\n\nRefute-Skip: docs-only adjustment\n')).toBe(true);
    expect(hasRefuteApproval('fix\n\nRefute-Skip: none of this changes financial math\n')).toBe(true);
    expect(hasRefuteApproval('fix\n\nRefute-Skip: todo-list UI string only\n')).toBe(true);
  });
  it('a bare placeholder word is not a justification', () => {
    for (const v of ['PENDING', 'TODO', 'TBD', 'n/a', 'n.a.', '"TODO"', 'TODO​', 'pass', 'TODO?', '"<reason>"']) {
      expect(hasRefuteApproval(`fix\n\nRefute-Skip: ${v}\n`)).toBe(false);
    }
  });
});

describe('check-refute-required — rejected trailers surface in the violation', () => {
  it('findUnattestedCommits carries the rejection reason', () => {
    const out = findUnattestedCommits([
      {
        sha: 'a'.repeat(40),
        message: 'fix(analytics): x\n\nRefute-Reviewed: PENDING\n',
        files: ['src/analytics/engine.ts'],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.rejected?.[0]).toMatch(/Refute-Reviewed: PENDING — rejected/);
  });
  it('a commit with no trailer has no rejected field', () => {
    const out = findUnattestedCommits([
      { sha: 'b'.repeat(40), message: 'fix(analytics): y\n', files: ['src/analytics/engine.ts'] },
    ]);
    expect(out[0]).not.toHaveProperty('rejected');
  });
});

describe('check-refute-required — per-commit attestation', () => {
  const skipParent: CommitRecord = {
    sha: '4e2be44000000000000000000000000000000000',
    message:
      'fix(warehouse): JSON error bodies for uncaught route errors\n\n' +
      'Refute-Skip: error transport only — no financial computation, ranking, or threshold touched\n',
    files: ['server/warehouse/sub-routers.ts', 'src/modules/sourcing/SourcingModule.tsx'],
  };
  const unattestedChild: CommitRecord = {
    sha: '588fa81000000000000000000000000000000000',
    message: 'fix(alerts): one expiry insight per lease — stop double-counting risk $\n',
    files: ['src/analytics/conditions.ts', 'tests/unit/conditions.test.ts'],
  };
  const showOutput = (c: CommitRecord): string => `${c.message}\0\0\n${c.files.map((f) => `${f}\0`).join('')}`;

  it('a Refute-Skip on the parent does NOT attest an unattested financial child (the 2026-09-23 repro)', () => {
    // The old range-level check passed this range: the concatenated blob contains a trailer.
    expect(hasRefuteApproval([skipParent, unattestedChild].map((c) => c.message).join('\n'))).toBe(true);
    expect(findUnattestedCommits([skipParent, unattestedChild])).toEqual([
      {
        sha: unattestedChild.sha,
        subject: 'fix(alerts): one expiry insight per lease — stop double-counting risk $',
        financial: ['src/analytics/conditions.ts'],
      },
    ]);
  });

  it('order does not matter — a later trailer does not attest an earlier commit', () => {
    expect(findUnattestedCommits([unattestedChild, skipParent]).map((u) => u.sha)).toEqual([unattestedChild.sha]);
  });

  it('passes when every financial commit carries its own trailer', () => {
    const attestedChild = { ...unattestedChild, message: unattestedChild.message + '\nRefute-Reviewed: wf_abc123\n' };
    expect(findUnattestedCommits([skipParent, attestedChild])).toEqual([]);
  });

  it('a commit with no financial source needs no trailer', () => {
    const docsOnly: CommitRecord = { sha: 'd0c5', message: 'docs: x\n', files: ['README.md', 'tests/unit/a.test.ts'] };
    expect(findUnattestedCommits([docsOnly])).toEqual([]);
  });

  it('parseCommitShow splits the -z output: message, NUL, NUL-terminated paths (never trimmed)', () => {
    const raw = 'fix: x\n\nbody\n\nRefute-Skip: y\n\0\0\nsrc/analytics/conditions.ts\0 lead space.ts\0src/analytics/q"x.ts\0';
    expect(parseCommitShow('abc', raw)).toEqual({
      sha: 'abc',
      message: 'fix: x\n\nbody\n\nRefute-Skip: y\n',
      files: ['src/analytics/conditions.ts', ' lead space.ts', 'src/analytics/q"x.ts'],
    });
    // A clean merge under --remerge-diff: message and terminators, no paths.
    expect(parseCommitShow('m', 'Merge x into y\n\0\0').files).toEqual([]);
    // A trailer-looking path after the NUL is a path, not an attestation.
    expect(parseCommitShow('e', 'chore\n\0\0\nRefute-Skip: evil.ts\0').message).toBe('chore\n');
  });

  it('parseCommitShow throws on output without the terminator', () => {
    expect(() => parseCommitShow('abc', 'fix: x\n\nsrc/analytics/conditions.ts\n')).toThrow(/no message terminator/);
  });

  it('parseCommitShow throws on anything after the last path terminator (the octopus warning shape)', () => {
    // git 2.55 on an octopus under --remerge-diff: the warning replaces the path list.
    expect(() => parseCommitShow('o', 'octo\n\0\0diff: warning: Skipping remerge-diff for octopus merges.\n')).toThrow(
      /unterminated path list/,
    );
    expect(() => parseCommitShow('o', 'x\n\0\0\nsrc/analytics/a.ts\0trailing')).toThrow(/unterminated path list/);
  });

  it('collectCommits reads an octopus (3+ parents) against its first parent', () => {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args.includes('rev-list')) return 'octo p1 p2 p3\n';
      return 'octo\n\0\0\nsrc/analytics/a.ts\0';
    };
    expect(collectCommits('b', 'HEAD', run)[0]?.files).toEqual(['src/analytics/a.ts']);
    expect(calls[1]).toEqual([...OCTOPUS_SHOW_ARGS, 'octo']);
    expect(OCTOPUS_SHOW_ARGS).toContain('--diff-merges=first-parent');
    expect(OCTOPUS_SHOW_ARGS).not.toContain('--remerge-diff');
  });

  it('a commit that cannot be read inside a resolved range is a VIOLATION, not a skip', () => {
    // A ~5 KiB tree listing 256k paths overflows any output buffer; failing open there would let one
    // crafted commit switch the gate off for the whole range.
    const run = (args: string[]): string => {
      if (args.includes('rev-list')) return `${skipParent.sha} b0\nbig0 b0\n`;
      if (args[args.length - 1] === 'big0') throw new Error('spawnSync git ENOBUFS');
      return showOutput(skipParent);
    };
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('are unattested or unreadable');
    expect(r.message).toContain('cannot be cleared by any trailer');
    expect(r.message).toContain('big0 (could not be read)');
    expect(r.message).toContain('unreadable, so unverifiable: spawnSync git ENOBUFS');
    expect(r.message).not.toContain('4e2be44');
  });

  it('collectCommits reads every commit in the range, merges included, with its own git show', () => {
    const calls: string[][] = [];
    const run = (args: string[]): string => {
      calls.push(args);
      if (args.includes('rev-list')) return `${unattestedChild.sha} ${skipParent.sha}\n${skipParent.sha} b0\n`;
      const sha = args[args.length - 1];
      const c = [skipParent, unattestedChild].find((x) => x.sha === sha);
      if (!c) throw new Error(`unexpected sha ${sha}`);
      return showOutput(c);
    };
    const commits = collectCommits('origin/main', 'HEAD', run);
    // Trailing `--`: without it git also stats the range as a possible PATH, which fails on Windows
    // in a deep working directory ("Filename too long") and would now fail the gate CLOSED.
    expect(calls[0]).toEqual([...GIT_GLOBAL_ARGS, 'rev-list', '--parents', 'origin/main..HEAD', '--']);
    expect(GIT_GLOBAL_ARGS).toContain('--no-replace-objects');
    expect(GIT_GLOBAL_ARGS).toContain('merge.renameLimit=0');
    expect(calls.slice(1)).toEqual([
      [...SHOW_ARGS, unattestedChild.sha],
      [...SHOW_ARGS, skipParent.sha],
    ]);
    expect(commits).toEqual([unattestedChild, skipParent]);
  });

  it('evaluate: a rejected placeholder trailer is printed with its reason in the violation', () => {
    const pending: CommitRecord = {
      sha: 'c0ffee0000000000000000000000000000000000',
      message: 'fix(analytics): tweak\n\nRefute-Reviewed: PENDING\n',
      files: ['src/analytics/conditions.ts'],
    };
    const run = (args: string[]): string => (args.includes('rev-list') ? `${pending.sha} b0\n` : showOutput(pending));
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('violation');
    const lines = r.message.split('\n');
    const rejectedAt = lines.findIndex((l) => l.includes('Refute-Reviewed: PENDING — rejected: placeholder'));
    const pathAt = lines.findIndex((l) => l.trim() === 'src/analytics/conditions.ts');
    expect(rejectedAt).toBeGreaterThan(-1);
    expect(pathAt).toBeGreaterThan(rejectedAt);
  });

  it('evaluate: violation names only the unattested commit; the remedy is in the message', () => {
    const run = (args: string[]): string =>
      args.includes('rev-list')
        ? `${unattestedChild.sha} ${skipParent.sha}\n${skipParent.sha} b0\n`
        : showOutput(args[args.length - 1] === skipParent.sha ? skipParent : unattestedChild);
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('1 of 2 commit(s)');
    expect(r.message).toContain('588fa81 fix(alerts)');
    expect(r.message).toContain('src/analytics/conditions.ts');
    expect(r.message).not.toContain('4e2be44');
    expect(r.message).toContain('git interpret-trailers --in-place');
    expect(r.message).toContain('git commit --fixup=reword:<sha>');
    expect(r.message).toContain('GIT_SEQUENCE_EDITOR=: git rebase -i --rebase-merges --autosquash origin/main');
  });

  it('evaluate fails OPEN on a git failure and on an empty base', () => {
    const boom = (): string => {
      throw new Error("fatal: bad revision 'nope..HEAD'");
    };
    expect(evaluate('nope', boom)).toMatchObject({ outcome: 'skip' });
    expect(evaluate('nope', boom).message).toContain('bad revision');
    // `--base=` would otherwise read the empty range `..HEAD` and report OK without looking at anything.
    const never = (): string => {
      throw new Error('must not be called');
    };
    expect(evaluate('', never)).toMatchObject({ outcome: 'skip' });
    expect(evaluate('  ', never)).toMatchObject({ outcome: 'skip' });
  });

  it('evaluate skips (fails open) on a shallow clone and on git < 2.41, before reading any commit', () => {
    const probe = (version: string, shallow: string) => (args: string[]): string => {
      if (args[0] === 'version') return version;
      if (args[0] === 'rev-parse') return shallow;
      throw new Error('commits must not be read');
    };
    // --attr-source shipped in git 2.41 (2.40 only added `check-attr --source`).
    expect(evaluate('origin/main', probe('git version 2.40.4\n', 'false\n'))).toMatchObject({ outcome: 'skip' });
    expect(evaluate('origin/main', probe('git version 2.40.4\n', 'false\n')).message).toContain('2.41');
    expect(evaluate('origin/main', probe('git version 2.55.0.windows.2\n', 'true\n')).message).toContain('shallow clone');
    expect(probeToolingGap(probe('git version 2.41.0\n', 'false\n'))).toBeUndefined();
    expect(GIT_GLOBAL_ARGS.some((a) => a.startsWith('--attr-source='))).toBe(true);
    expect(probeToolingGap(probe('git version 3.0.0\n', 'false\n'))).toBeUndefined();
    expect(probeToolingGap(probe('git version 1.9.5\n', 'false\n'))).toContain('2.41');
  });

  it('evaluate: an unresolvable BASE skips; an unresolvable explicit --head, or a rev-list failure after the range resolved, is a violation', () => {
    const runner =
      (opts: { base?: boolean; head?: boolean; revList?: boolean }) =>
      (args: string[]): string => {
        if (args[0] === 'version') return 'git version 2.55.0\n';
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
        if (args.includes('rev-parse')) {
          const ref = args[args.length - 1] ?? '';
          const ok = ref.startsWith('origin/main') ? opts.base !== false : opts.head !== false;
          if (!ok) throw new Error(`fatal: Needed a single revision (${ref})`);
          return 'f'.repeat(40) + '\n';
        }
        if (args.includes('rev-list')) {
          // e.g. 830k commits: `rev-list --parents` output overflows maxBuffer.
          if (opts.revList === false) throw new Error('spawnSync git ENOBUFS');
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      };
    expect(evaluate('origin/main', runner({ base: false }))).toMatchObject({ outcome: 'skip' });
    const badHead = evaluate('origin/main', runner({ head: false }), '588fa8l');
    expect(badHead.outcome).toBe('violation');
    expect(badHead.message).toContain('588fa8l');
    // The default HEAD not resolving (a repo with no commits) is a tooling gap, not a violation.
    expect(evaluate('origin/main', runner({ head: false }))).toMatchObject({ outcome: 'skip' });
    const overflow = evaluate('origin/main', runner({ revList: false }));
    expect(overflow.outcome).toBe('violation');
    expect(overflow.message).toContain('ENOBUFS');
    expect(evaluate('origin/main', runner({}))).toMatchObject({ outcome: 'ok' });
  });

  // A runner that answers every probe and range call, so an assertion cannot pass because some
  // unrelated call threw (the earlier empty-base test used a throw-on-everything runner, which
  // made probeToolingGap return "git unusable" -> skip even with the guard deleted).
  const healthy =
    (commits: CommitRecord[], fail: Record<string, string> = {}) =>
    (args: string[]): string => {
      if (args[0] === 'version') return 'git version 2.55.0\n';
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return 'false\n';
      if (args.includes('rev-parse')) return 'f'.repeat(40) + '\n';
      if (args.includes('merge-base')) return 'e'.repeat(40) + '\n';
      if (args.includes('rev-list')) return commits.map((c) => `${c.sha} p0\n`).join('');
      const sha = args[args.length - 1] ?? '';
      if (fail[sha] !== undefined) throw new Error(fail[sha]);
      const c = commits.find((x) => x.sha === sha);
      if (!c) throw new Error(`unexpected ${args.join(' ')}`);
      return showOutput(c);
    };

  it('runCli: --head is honoured, --strict exits 1 on a violation, default mode warns and exits 0', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    const seen: string[] = [];
    const run = (args: string[]): string => {
      if (args.includes('rev-parse') && args.includes('--verify')) seen.push(args[args.length - 1] ?? '');
      return healthy([fin])(args);
    };
    const strict = runCli(['--strict', '--base=origin/main', '--head=abc123'], {}, run);
    expect(strict).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(seen).toContain('abc123^{commit}');
    expect(seen).not.toContain('HEAD^{commit}');
    expect(runCli(['--base=origin/main'], {}, run)).toMatchObject({ stream: 'warn', exitCode: 0 });
    // REFUTE_BASE is the default base; --base= (empty) skips instead of reading `..HEAD`.
    seen.length = 0;
    runCli([], { REFUTE_BASE: 'origin/release' }, run);
    expect(seen).toContain('origin/release^{commit}');
    expect(runCli(['--strict', '--base='], {}, run)).toMatchObject({ stream: 'warn', exitCode: 0 });
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    expect(runCli(['--strict'], {}, healthy([docs]))).toMatchObject({ stream: 'log', exitCode: 0 });
  });

  it('runCli --strict FAILS CLOSED on a git tooling gap (wf_d3be7fbd-39e); non-strict still warns and exits 0', () => {
    const broken = (): string => {
      throw new Error('git: broken install');
    };
    // git resolves but every call throws -> probeToolingGap reports "git unusable".
    const strict = runCli(['--strict', '--base=origin/main'], {}, broken);
    expect(strict).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(strict.message).toMatch(/FAILED CLOSED/);
    expect(strict.message).toMatch(/git unusable/);
    expect(runCli(['--base=origin/main'], {}, broken)).toMatchObject({ stream: 'warn', exitCode: 0 });

    // Probes pass, but git throws on rev-parse: the base "does not resolve" -> also a tooling gap on git.
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    const revParseBroken = (args: string[]): string => {
      if (args.includes('rev-parse') && args.includes('--verify')) throw new Error('fatal: broken object store');
      return healthy([fin])(args);
    };
    expect(runCli(['--strict', '--base=origin/main'], {}, revParseBroken)).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(runCli(['--base=origin/main'], {}, revParseBroken)).toMatchObject({ stream: 'warn', exitCode: 0 });

    // Old git and a shallow clone are git tooling gaps too.
    const probe = (version: string, shallow: string) => (args: string[]): string => {
      if (args[0] === 'version') return version;
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return shallow;
      return healthy([fin])(args);
    };
    expect(runCli(['--strict'], {}, probe('git version 2.40.4\n', 'false\n'))).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(runCli(['--strict'], {}, probe('git version 2.55.0\n', 'true\n'))).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(runCli([], {}, probe('git version 2.55.0\n', 'true\n'))).toMatchObject({ stream: 'warn', exitCode: 0 });

    // An empty --base is caller configuration, not a git gap: unchanged (warns, exit 0, also under --strict).
    expect(runCli(['--strict', '--base='], {}, broken)).toMatchObject({ stream: 'warn', exitCode: 0 });
  });

  it('runCli --strict FAILS CLOSED on a git that EXITS 0 with garbage; non-strict controls unchanged', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    // Empty stdout for EVERY command (git "succeeds" but says nothing): used to be "OK: no financial ... changed".
    const empty = (): string => '';
    const s1 = runCli(['--strict', '--base=origin/main'], {}, empty);
    expect(s1).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(s1.message).toMatch(/FAILED CLOSED/);
    expect(runCli(['--base=origin/main'], {}, empty)).toMatchObject({ exitCode: 0 });

    // Probes fine, rev-parse prints a non-SHA, rev-list prints nothing.
    const nonSha = (args: string[]): string => {
      if (args.includes('rev-parse') && args.includes('--verify')) return 'not-a-sha\n';
      if (args.includes('rev-list')) return '';
      return healthy([fin])(args);
    };
    const s2 = runCli(['--strict', '--base=origin/main'], {}, nonSha);
    expect(s2).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(s2.message).toMatch(/FAILED CLOSED/);
    expect(runCli(['--base=origin/main'], {}, nonSha)).toMatchObject({ exitCode: 0 });
    // A 41..63-hex string is not a SHA either (only 40 or 64).
    const longish = (args: string[]): string =>
      args.includes('rev-parse') && args.includes('--verify') ? 'a'.repeat(41) + '\n' : nonSha(args);
    expect(runCli(['--strict', '--base=origin/main'], {}, longish)).toMatchObject({ stream: 'error', exitCode: 1 });

    // Unparseable `git version`.
    const badVersion = (args: string[]): string => (args[0] === 'version' ? 'hello\n' : healthy([fin])(args));
    const s3 = runCli(['--strict', '--base=origin/main'], {}, badVersion);
    expect(s3).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(s3.message).toMatch(/FAILED CLOSED/);
    expect(runCli(['--base=origin/main'], {}, badVersion)).toMatchObject({ exitCode: 0 });

    // Shallow probe that is neither 'true' nor 'false'.
    const maybe = (args: string[]): string =>
      args[0] === 'rev-parse' && args[1] === '--is-shallow-repository' ? 'maybe\n' : healthy([fin])(args);
    const s4 = runCli(['--strict', '--base=origin/main'], {}, maybe);
    expect(s4).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(s4.message).toMatch(/FAILED CLOSED/);
    expect(runCli(['--base=origin/main'], {}, maybe)).toMatchObject({ exitCode: 0 });

    // The empty --base= carve-out stays (caller configuration).
    expect(runCli(['--strict', '--base='], {}, empty)).toMatchObject({ stream: 'warn', exitCode: 0 });
    // Control: a well-formed healthy git still passes/violates exactly as before.
    expect(runCli(['--strict', '--base=origin/main'], {}, healthy([fin]))).toMatchObject({ stream: 'error', exitCode: 1 });
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    expect(runCli(['--strict', '--base=origin/main'], {}, healthy([docs]))).toMatchObject({ stream: 'log', exitCode: 0 });
  });

  it('runCli --strict with NO --head FAILS CLOSED when the default HEAD does not resolve', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    const headThrows = (args: string[]): string => {
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD^{commit}') throw new Error('fatal: bad HEAD');
      return healthy([fin])(args);
    };
    const r = runCli(['--strict'], {}, headThrows);
    expect(r).toMatchObject({ stream: 'error', exitCode: 1 });
    expect(r.message).toMatch(/FAILED CLOSED/);
    expect(r.message).toMatch(/HEAD does not resolve/);
    expect(runCli([], {}, headThrows)).toMatchObject({ stream: 'warn', exitCode: 0 });
  });

  it('runCli --strict with a git that returns garbage for everything is NOT a pass', () => {
    const garbage = (): string => 'garbage\n';
    const r = runCli(['--strict', '--base=origin/main'], {}, garbage);
    expect(r.exitCode).toBe(1);
    expect(r.stream).toBe('error');
  });

  it('evaluate reads the range by the RESOLVED shas, never by re-resolving the names', () => {
    const calls: string[][] = [];
    const base = healthy([]);
    const run = (args: string[]): string => {
      calls.push(args);
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD^{commit}') return 'a'.repeat(40) + '\n';
      if (args.includes('rev-parse') && args[args.length - 1] === 'origin/main^{commit}') return 'b'.repeat(40) + '\n';
      return base(args);
    };
    evaluate('origin/main', run);
    const revList = calls.find((a) => a.includes('rev-list'));
    expect(revList).toContain(`${'b'.repeat(40)}..${'a'.repeat(40)}`);
  });

  it('evaluate: a probe that throws (git present, shallow check broken) skips, not proceeds', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    const run = (args: string[]): string => {
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') throw new Error('fatal: broken repo');
      return healthy([fin])(args);
    };
    const r = evaluate('origin/main', run);
    expect(r.outcome).toBe('skip');
    expect(r.message).toContain('git unusable');
  });

  it('evaluate: an empty base skips on the guard itself, not on a probe failure', () => {
    const fin: CommitRecord = { sha: 'f1n', message: 'fin, no trailer\n', files: ['src/analytics/a.ts'] };
    for (const empty of ['', '  ']) {
      const r = evaluate(empty, healthy([fin]));
      expect(r.outcome).toBe('skip');
      expect(r.message).toContain('empty base ref');
    }
  });

  it('evaluate: an unreadable commit is a violation even when nothing else in the range is financial', () => {
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    const big: CommitRecord = { sha: 'b1g0', message: '', files: [] };
    const r = evaluate('origin/main', healthy([docs, big], { b1g0: 'spawnSync git ENOBUFS' }));
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('b1g0 (could not be read)');
    // Control: the same docs-only range without the unreadable commit is OK.
    expect(evaluate('origin/main', healthy([docs]))).toMatchObject({ outcome: 'ok' });
  });

  it('evaluate: OK when nothing financial changed', () => {
    const docs: CommitRecord = { sha: 'd0c5', message: 'docs\n', files: ['README.md'] };
    const run = (args: string[]): string => (args.includes('rev-list') ? 'd0c5 b0\n' : showOutput(docs));
    expect(evaluate('origin/main', run)).toMatchObject({ outcome: 'ok' });
  });

  it('evaluate: a change to the refute workflow itself needs a trailer (the gate cannot be weakened unattested)', () => {
    for (const file of [
      '.claude/workflows/refute-financial-change.js',
      '.claude\\workflows\\refute-financial-change.js',
      'scripts/check-refute-required.ts',
      '.github/workflows/ci.yml',
      '.github/workflows/order-fragility.yml',
      '.github/workflows/brand-new.yml',
      'package.json',
      '.npmrc',
      'tsx.cmd',
      'git.exe',
      'scripts/package.json',
    ]) {
      const bare: CommitRecord = { sha: 'w0f1', message: 'chore(refute): tweak the gate\n', files: [file] };
      const r = evaluate('origin/main', healthy([bare]));
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain('w0f1');
      const attested: CommitRecord = { ...bare, message: bare.message + '\nRefute-Skip: test fixture — gate self-change\n' };
      expect(evaluate('origin/main', healthy([attested]))).toMatchObject({ outcome: 'ok' });
    }
  });
});

// Real git, real SHOW_ARGS: the stub tests above only prove the parser agrees with itself. Every
// scenario is built with plumbing (hash-object / update-index / commit-tree / merge-tree) into a
// throwaway repo under os.tmpdir(), so paths NTFS cannot hold as files ('"', tab) still get
// committed, and nothing touches this checkout. Isolated from the user's git config.
describe('check-refute-required — integration against real git', () => {
  let root = ''; // the mkdtemp result — the ONLY path afterAll may delete
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const g = (args: string[], input?: string): string =>
    execFileSync('git', ['-c', 'core.protectNTFS=false', ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      input,
      maxBuffer: 16 * 1024 * 1024,
    });
  const run: GitRunner = (args) => g(args);
  const lines = (n: number, edit?: [number, string]): string =>
    Array.from({ length: n }, (_, i) => (edit && edit[0] === i ? edit[1] : `line ${i}`)).join('\n') + '\n';

  type Entry = string | { gitlink: string } | null;
  /** Commit `files` on top of parents[0] (or `fromTree`); null removes a path. Returns the sha. */
  const mk = (parents: string[], files: Record<string, Entry>, msg: string, fromTree?: string): string => {
    const tree = fromTree ?? (parents[0] ? `${parents[0]}^{tree}` : undefined);
    if (tree) g(['read-tree', tree]);
    else g(['read-tree', '--empty']);
    for (const [path, entry] of Object.entries(files)) {
      if (entry === null) g(['update-index', '--force-remove', '--', path]);
      else if (typeof entry === 'string') {
        const blob = g(['hash-object', '-w', '--stdin'], entry).trim();
        g(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      } else g(['update-index', '--add', '--cacheinfo', `160000,${entry.gitlink},${path}`]);
    }
    const written = g(['write-tree']).trim();
    return g(['commit-tree', written, ...parents.flatMap((p) => ['-p', p]), '-m', msg]).trim();
  };

  let b0 = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'refute-gate-it-'));
    dir = root;
    const emptyCfg = join(root, '.empty-gitconfig');
    writeFileSync(emptyCfg, '');
    // Strip every inherited GIT_* variable: under `git rebase --exec` or a pre-commit hook in a linked
    // worktree, GIT_DIR / GIT_INDEX_FILE point at the REAL repo, and every g() call would rewrite
    // that repo's index with these fixtures.
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: emptyCfg,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    g(['init', '-q', 'repo']);
    dir = join(root, 'repo');
    b0 = mk([], { 'src/analytics/a.ts': lines(12), 'README.md': 'r\n' }, 'root');
  });
  afterAll(() => {
    // afterAll runs even when beforeAll throws. Delete only a non-empty mkdtemp result under
    // tmpdir(), never a path derived from `dir`: '' + '..' would be the parent of the cwd.
    if (!root || !resolve(root).startsWith(resolve(tmpdir())) || !basename(root).startsWith('refute-gate-it-')) return;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows AV can hold a handle in tmpdir; a leftover temp dir is harmless.
    }
  });

  it('skip-trailer parent + unattested financial child → violation on the child only', () => {
    const parent = mk([b0], { 'server/x.ts': 'x\n' }, 'plumb\n\nRefute-Skip: error transport only');
    const child = mk([parent], { 'src/analytics/a.ts': lines(12, [3, 'dedup']) }, 'fix(alerts): dedup');
    const r = evaluate(b0, run, child);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${child.slice(0, 7)} fix(alerts): dedup`);
    expect(r.message).not.toContain(parent.slice(0, 7));
    // The same range with the child attested passes.
    const fixed = mk([parent], { 'src/analytics/a.ts': lines(12, [3, 'dedup']) }, 'fix: dedup\n\nRefute-Reviewed: wf_fixture0-1');
    expect(evaluate(b0, run, fixed).outcome).toBe('ok');
  }, 60_000);

  it('a clean catch-up merge where the two sides touch DIFFERENT files needs no trailer', () => {
    const mainSide = mk([b0], { 'src/analytics/a.ts': lines(12, [0, 'main']) }, 'main\n\nRefute-Reviewed: wf_fixture0-m');
    const prSide = mk([b0], { 'src/analytics/other.ts': 'pr\n' }, 'pr\n\nRefute-Reviewed: wf_fixture0-p');
    const tree = g(['merge-tree', '--write-tree', prSide, mainSide]).trim().split('\n')[0] ?? '';
    const catchup = mk([prSide, mainSide], {}, 'Merge main into pr', tree);
    expect(evaluate(mainSide, run, catchup)).toMatchObject({ outcome: 'ok' });
  }, 60_000);

  it('a clean merge that combines BOTH sides\' changes to one financial file needs its own trailer (documented cost)', () => {
    const mainSide = mk([b0], { 'src/analytics/a.ts': lines(12, [0, 'main']) }, 'main\n\nRefute-Reviewed: wf_fixture0-m');
    const prSide = mk([b0], { 'src/analytics/a.ts': lines(12, [11, 'pr']) }, 'pr\n\nRefute-Reviewed: wf_fixture0-p');
    const tree = g(['merge-tree', '--write-tree', prSide, mainSide]).trim().split('\n')[0] ?? '';
    const catchup = mk([prSide, mainSide], {}, 'Merge main into pr', tree);
    const r = evaluate(mainSide, run, catchup);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${catchup.slice(0, 7)} Merge main into pr`);
    const attested = mk([prSide, mainSide], {}, 'Merge main into pr\n\nRefute-Skip: catch-up merge, no hand edits', tree);
    expect(evaluate(mainSide, run, attested)).toMatchObject({ outcome: 'ok' });
  }, 60_000);

  it('an evil merge that hand-edits financial source needs its own trailer (--no-merges skipped it)', () => {
    const mainSide = mk([b0], { 'README.md': 'main\n' }, 'main docs');
    const prSide = mk([b0], { 'docs/x.md': 'x\n' }, 'pr docs');
    const tree = g(['merge-tree', '--write-tree', mainSide, prSide]).trim().split('\n')[0] ?? '';
    const evil = mk([mainSide, prSide], { 'src/analytics/a.ts': lines(12, [5, 'evil']) }, 'Merge branch pr', tree);
    const r = evaluate(mainSide, run, evil);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${evil.slice(0, 7)} Merge branch pr`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('moving a file OUT of a financial path still names the financial path', () => {
    const moved = mk([b0], { 'src/analytics/a.ts': null, 'docs/a.ts': lines(12) }, 'chore: move');
    expect(evaluate(b0, run, moved).message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('paths git would C-quote still match the financial prefixes', () => {
    const q = mk([b0], { 'src/analytics/risk"calc.ts': 'x\n', 'src/analytics/tab\there.ts': 'y\n' }, 'feat: q');
    const r = evaluate(b0, run, q);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/risk"calc.ts');
    expect(r.message).toContain('src/analytics/tab\there.ts');
  }, 60_000);

  it('an octopus merge that hand-edits financial source is caught (git skips remerge-diff for it)', () => {
    const a = mk([b0], { 'docs/a.md': 'a\n' }, 'a');
    const b = mk([b0], { 'docs/b.md': 'b\n' }, 'b');
    const c = mk([b0], { 'docs/c.md': 'c\n' }, 'c');
    const clean = mk([a], { 'docs/b.md': 'b\n', 'docs/c.md': 'c\n' }, 'unused');
    const octo = mk([a, b, c], { 'docs/b.md': 'b\n', 'docs/c.md': 'c\n', 'src/analytics/a.ts': lines(12, [7, 'octo']) }, 'Merge b, c', `${clean}^{tree}`);
    const r = evaluate(a, run, octo);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${octo.slice(0, 7)} Merge b, c`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('a shallow clone skips instead of silently checking only the boundary commit', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [2, 'fin']) }, 'fin, no trailer');
    const tip = mk([fin], { 'README.md': 'tip\n' }, 'docs tip\n\nRefute-Skip: docs only');
    g(['update-ref', 'refs/heads/shallow-src', tip]);
    const clone = join(root, 'shallow');
    g(['clone', '-q', '--depth', '1', '--branch', 'shallow-src', `file://${dir.replace(/\\/g, '/')}`, clone]);
    const inClone: GitRunner = (args) =>
      execFileSync('git', args, { cwd: clone, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const r = evaluate('HEAD~1', inClone);
    expect(r.outcome).toBe('skip');
    expect(r.message).toContain('shallow clone');
    // The full repo, same range: the unattested commit is found.
    expect(evaluate(b0, run, tip).message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
  }, 60_000);

  it('the printed reword recipe rebases onto the merge-base sha, not a base ref that may have moved', () => {
    const movedMain = mk([b0], { 'README.md': 'moved\n' }, 'main moved on');
    const child = mk([b0], { 'src/analytics/a.ts': lines(12, [9, 'x']) }, 'fin, no trailer');
    const r = evaluate(movedMain, run, child);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`git rebase -i --rebase-merges --autosquash ${b0}`);
    expect(r.message).not.toContain(`--autosquash ${movedMain}`);
  }, 60_000);

  it('a committed .gitattributes merge=union cannot make a conflict in financial source look clean', () => {
    // The attack: attributes in the checked-out tree (the PR controls it in CI) make git's own
    // re-merge resolve a real conflict, so --remerge-diff would list nothing.
    const aSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'LTV_MAX = 0.41']) }, 'a\n\nRefute-Reviewed: wf_fixture0-a');
    const bSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'LTV_AGG = 0.40']), '.gitattributes': 'src/** merge=union\n' }, 'b\n\nRefute-Reviewed: wf_fixture0-b');
    const attrs = join(dir, '.gitattributes');
    writeFileSync(attrs, 'src/** merge=union\n');
    try {
      // Parent order must match the merge-tree order, or the union's line order differs and the
      // re-merge lists the path for the wrong reason.
      const unionTree = g(['merge-tree', '--write-tree', bSide, aSide]).trim().split('\n')[0] ?? '';
      const merge = mk([bSide, aSide], {}, 'Merge a into b', unionTree);
      const r = evaluate(bSide, run, merge);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${merge.slice(0, 7)} Merge a into b`);
      expect(r.message).toContain('src/analytics/a.ts');
    } finally {
      rmSync(attrs, { force: true });
    }
  }, 60_000);

  it('a root commit in the range is read even under log.showRoot=false (--root)', () => {
    g(['config', 'log.showRoot', 'false']);
    try {
      const orphan = mk([], { 'src/analytics/z.ts': 'z\n' }, 'orphan root, no trailer');
      const r = evaluate(b0, run, orphan);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain('src/analytics/z.ts');
    } finally {
      g(['config', '--unset', 'log.showRoot']);
    }
  }, 60_000);

  it('a clean merge that carries an edit across a rename INTO a financial path needs its own trailer', () => {
    // The 2026-09-23 merge-gate bypass: main moves src/lib/x.ts (NOT financial) to
    // src/analytics/x.ts; the branch edits the old path. git's re-merge follows the rename, so
    // --remerge-diff lists nothing, and the edit commit's own paths are non-financial. Only a path
    // that differs from BOTH parents (a combined diff) shows the financial change the merge made.
    const base = mk([b0], { 'src/lib/x.ts': lines(12) }, 'lib');
    const moveMain = mk([base], { 'src/lib/x.ts': null, 'src/analytics/x.ts': lines(12) }, 'main: move\n\nRefute-Skip: pure file move, no content change');
    const tweak = mk([base], { 'src/lib/x.ts': lines(12, [6, 'return 0.99']) }, 'tweak util');
    const tree = g(['merge-tree', '--write-tree', tweak, moveMain]).trim().split('\n')[0] ?? '';
    expect(g(['show', `${tree}:src/analytics/x.ts`])).toContain('return 0.99');
    const merge = mk([tweak, moveMain], {}, 'Merge main into feature', tree);
    const r = evaluate(moveMain, run, merge);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${merge.slice(0, 7)} Merge main into feature`);
    expect(r.message).toContain('src/analytics/x.ts');
  }, 60_000);

  it('a directory rename that moves a new file INTO a financial path needs a trailer on the merge', () => {
    const base = mk([b0], { 'src/lib/p.ts': lines(8), 'src/lib/q.ts': lines(9) }, 'lib dir');
    const moveDir = mk(
      [base],
      { 'src/lib/p.ts': null, 'src/lib/q.ts': null, 'src/analytics/lib2/p.ts': lines(8), 'src/analytics/lib2/q.ts': lines(9) },
      'main: move dir\n\nRefute-Skip: pure move',
    );
    const addNew = mk([base], { 'src/lib/new.ts': 'export const RATE = 0.99;\n' }, 'add new util');
    let tree = '';
    try {
      tree = g(['merge-tree', '--write-tree', addNew, moveDir]);
    } catch (err) {
      tree = String((err as { stdout?: string }).stdout ?? '');
    }
    tree = tree.trim().split('\n')[0] ?? '';
    expect(g(['ls-tree', '-r', '--name-only', tree])).toContain('src/analytics/lib2/new.ts');
    const merge = mk([addNew, moveDir], {}, 'Merge main (dir move)', tree);
    const r = evaluate(moveDir, run, merge);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/lib2/new.ts');
  }, 60_000);

  it('a local merge.renames=false / directoryRenames=false cannot add paths to a merge listing (pinned via -c)', () => {
    // Financial rename on main + an edit on the branch: the catch-up merge is itself a violation
    // (it combines both sides' changes). What the pin guarantees is WHICH paths are listed: an
    // unpinned re-merge under renames=false would also report the old path as a modify/delete.
    const mainR = mk([b0], { 'src/analytics/a.ts': null, 'src/analytics/b.ts': lines(12) }, 'main: rename\n\nRefute-Reviewed: wf_fixture0-m');
    const edit = mk([b0], { 'src/analytics/a.ts': lines(12, [1, 'edited']) }, 'edit\n\nRefute-Reviewed: wf_fixture0-e');
    const t1 = g(['merge-tree', '--write-tree', edit, mainR]).trim().split('\n')[0] ?? '';
    const catchup = mk([edit, mainR], {}, 'Merge main into branch', t1);
    const base2 = mk([b0], { 'src/analytics/d/x.ts': lines(8) }, 'dir\n\nRefute-Reviewed: wf_fixture0-d');
    const mainD = mk([base2], { 'src/analytics/d/x.ts': null, 'src/analytics/e/x.ts': lines(8) }, 'main: move dir\n\nRefute-Reviewed: wf_fixture0-md');
    const addY = mk([base2], { 'src/analytics/d/y.ts': 'y\n' }, 'add y\n\nRefute-Reviewed: wf_fixture0-y');
    // Git's default merge.directoryRenames=conflict reports a file-location conflict here (exit 1)
    // but still writes the moved result tree on stdout's first line.
    let t2 = '';
    try {
      t2 = g(['merge-tree', '--write-tree', addY, mainD]);
    } catch (err) {
      t2 = String((err as { stdout?: string }).stdout ?? '');
    }
    t2 = t2.trim().split('\n')[0] ?? '';
    expect(g(['ls-tree', '-r', '--name-only', t2])).toContain('src/analytics/e/y.ts');
    const catchupD = mk([addY, mainD], {}, 'Merge main (dir move) into branch', t2);
    const check = (): void => {
      const r1 = evaluate(mainR, run, catchup);
      expect(r1.outcome).toBe('violation');
      expect(r1.message).toContain('src/analytics/b.ts');
      expect(r1.message).not.toContain('src/analytics/a.ts');
      const r2 = evaluate(mainD, run, catchupD);
      expect(r2.outcome).toBe('violation');
      expect(r2.message).toContain('src/analytics/e/y.ts');
      expect(r2.message).not.toContain('src/analytics/d/y.ts');
    };
    check();
    g(['config', 'merge.renames', 'false']);
    g(['config', 'merge.directoryRenames', 'false']);
    try {
      check();
    } finally {
      g(['config', '--unset', 'merge.renames']);
      g(['config', '--unset', 'merge.directoryRenames']);
    }
  }, 60_000);

  it('the reword recipe warns about later merges and demands a tree-unchanged check', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [8, 'fin']) }, 'fin, no trailer');
    const other = mk([b0], { 'README.md': 'other\n' }, 'other');
    const tree = g(['merge-tree', '--write-tree', fin, other]).trim().split('\n')[0] ?? '';
    const later = mk([fin, other], {}, 'Merge other', tree);
    const r = evaluate(b0, run, later);
    expect(r.outcome).toBe('violation');
    // The pre-rebase tip is PINNED to a variable, never ORIG_HEAD: ORIG_HEAD is one slot per
    // worktree, so another session's `git reset` in a shared checkout overwrites it and the check
    // passes on a rebase that dropped a merge's hand edit. Recovery is --keep, never --hard, which
    // would destroy another session's uncommitted work.
    expect(r.message).toContain('PRE=$(git rev-parse HEAD)');
    expect(r.message).toContain('git diff --exit-code "$PRE" HEAD');
    expect(r.message).toContain('git reset --keep "$PRE"');
    expect(r.message).toContain('own worktree');
    expect(r.message).not.toMatch(/git (diff|reset)[^\n]*ORIG_HEAD/);
    expect(r.message).not.toMatch(/git reset --hard/);
    expect(r.message).toContain('This range contains a merge commit');
    // Without a merge in the range there is nothing to re-create, so no merge warning.
    const r2 = evaluate(b0, run, fin);
    expect(r2.message).toContain('git diff --exit-code "$PRE" HEAD');
    expect(r2.message).not.toContain('This range contains a merge commit');
  }, 60_000);

  it('--head / --base naming a TREE (not a commit) do not resolve: head is a violation, base skips', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [3, 'tree-test']) }, 'fin, no trailer');
    const tree = g(['rev-parse', `${b0}^{tree}`]).trim();
    const badHead = evaluate(b0, run, tree);
    expect(badHead.outcome).toBe('violation');
    expect(badHead.message).toContain('does not resolve to a commit');
    expect(evaluate(tree, run, fin)).toMatchObject({ outcome: 'skip' });
  }, 60_000);

  it('a local replace ref cannot swap an unattested financial commit for an attested decoy', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [5, 'replaced?']) }, 'fin, no trailer');
    const decoy = mk([b0], { 'README.md': 'decoy\n' }, 'decoy\n\nRefute-Skip: docs only');
    g(['replace', fin, decoy]);
    try {
      const r = evaluate(b0, run, fin);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
    } finally {
      g(['replace', '-d', fin]);
    }
  }, 60_000);

  it('a local merge.renameLimit cannot add paths to a merge listing (pinned renameLimit=0)', () => {
    // Two INEXACT financial renames on main (exact renames ignore the limit) and an edit to one of
    // the old paths on the branch. Under a local renameLimit=1 an unpinned re-merge gives up on
    // rename detection and reports the old paths as modify/delete as well.
    const r1 = mk([b0], { 'src/analytics/r1.ts': lines(20), 'src/analytics/r2.ts': lines(21) }, 'two files\n\nRefute-Reviewed: wf_fixture0-2');
    const mainR = mk(
      [r1],
      { 'src/analytics/r1.ts': null, 'src/analytics/r2.ts': null, 'src/analytics/s1.ts': lines(20, [19, 'moved1']), 'src/analytics/s2.ts': lines(21, [20, 'moved2']) },
      'main: inexact renames\n\nRefute-Reviewed: wf_fixture0-r',
    );
    const edit = mk([r1], { 'src/analytics/r1.ts': lines(20, [0, 'edited']) }, 'edit r1\n\nRefute-Reviewed: wf_fixture0-e');
    const tree = g(['merge-tree', '--write-tree', edit, mainR]).trim().split('\n')[0] ?? '';
    const merge = mk([edit, mainR], {}, 'Merge main', tree);
    const check = (): void => {
      const r = evaluate(mainR, run, merge);
      expect(r.message).not.toContain('src/analytics/r1.ts');
      expect(r.message).not.toContain('src/analytics/r2.ts');
    };
    check();
    g(['config', 'merge.renameLimit', '1']);
    g(['config', 'diff.renameLimit', '1']);
    try {
      check();
    } finally {
      g(['config', '--unset', 'merge.renameLimit']);
      g(['config', '--unset', 'diff.renameLimit']);
    }
  }, 60_000);

  it('commits only on the BASE side are not the PR\'s (base..head, not base...head)', () => {
    const baseMoved = mk([b0], { 'src/analytics/a.ts': lines(12, [2, 'main-only']) }, 'main fin, no trailer');
    const head = mk([b0], { 'README.md': 'pr docs\n' }, 'pr docs');
    expect(evaluate(baseMoved, run, head)).toMatchObject({ outcome: 'ok' });
  }, 60_000);

  it('an octopus is diffed against its FIRST parent: a financial file it brings in from another parent is listed', () => {
    const p1 = mk([b0], { 'docs/p1.md': '1\n' }, 'p1');
    const p2 = mk([b0], { 'src/analytics/fromB.ts': 'b\n' }, 'p2\n\nRefute-Reviewed: wf_fixture0-p2');
    const p3 = mk([b0], { 'docs/p3.md': '3\n' }, 'p3');
    const combinedTree = mk([p1], { 'src/analytics/fromB.ts': 'b\n', 'docs/p3.md': '3\n' }, 'unused');
    const octo = mk([p1, p2, p3], { 'src/analytics/fromB.ts': 'b\n', 'docs/p3.md': '3\n' }, 'Octopus, no trailer', `${combinedTree}^{tree}`);
    const r = evaluate(p1, run, octo);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/fromB.ts');
  }, 60_000);

  it('a conflict in a financial file resolved VERBATIM to one side still needs a trailer on the merge', () => {
    // The combined diff lists nothing here (the result equals one parent); only --remerge-diff sees
    // that git's own re-merge would have left conflict markers. The real #364 / #369 catch-up shape.
    const mainSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'main side']) }, 'main\n\nRefute-Reviewed: wf_fixture0-m');
    const prSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'pr side']) }, 'pr\n\nRefute-Reviewed: wf_fixture0-p');
    const takeMain = mk([prSide, mainSide], { 'src/analytics/a.ts': lines(12, [4, 'main side']) }, 'Merge main (took theirs)');
    const r = evaluate(mainSide, run, takeMain);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${takeMain.slice(0, 7)} Merge main (took theirs)`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('a replace ref that turns the HEAD commit into a tag of the base cannot resolve --head to a decoy', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [6, 'swap-head']) }, 'fin, no trailer');
    const tag = g(['hash-object', '-t', 'tag', '-w', '--stdin'], `object ${b0}\ntype commit\ntag decoy\ntagger t <t@t> 0 +0000\n\nx\n`).trim();
    g(['replace', '-f', fin, tag]);
    try {
      const r = evaluate(b0, run, fin);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
    } finally {
      g(['replace', '-d', fin]);
    }
  }, 60_000);

  it('a legacy .git/info/grafts file cannot rewrite parents (the production runner sets GIT_GRAFT_FILE)', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [7, 'grafted']) }, 'fin, no trailer');
    const tip = mk([fin], { 'README.md': 'tip\n' }, 'docs tip');
    const decoy = mk([], { 'README.md': 'decoy\n' }, 'decoy root');
    const grafts = join(dir, '.git', 'info', 'grafts');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(grafts, `${tip} ${decoy}\n`);
    try {
      // The production environment (gitEnv) on top of the isolated test environment.
      const prodRun: GitRunner = (args) =>
        execFileSync('git', args, { cwd: dir, env: gitEnv(env), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const r = evaluate(b0, prodRun, tip);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
    } finally {
      rmSync(grafts, { force: true });
    }
  }, 60_000);

  it('a local diff.relative=true, run from a subdirectory, cannot strip the financial prefix (--no-relative)', () => {
    const base = mk([b0], { 'src/lib/y.ts': 'y\n' }, 'lib y');
    const moveIn = mk([base], { 'src/lib/y.ts': null, 'src/analytics/y.ts': 'y\n' }, 'move in, no trailer');
    const sub = join(dir, 'src', 'lib');
    mkdirSync(sub, { recursive: true });
    g(['config', 'diff.relative', 'true']);
    try {
      const subRun: GitRunner = (args) =>
        execFileSync('git', args, { cwd: sub, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const r = evaluate(base, subRun, moveIn);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain('src/analytics/y.ts');
    } finally {
      g(['config', '--unset', 'diff.relative']);
    }
  }, 60_000);

  it('a merge that records its FIRST parent\'s tree (merge -s ours) silently reverting main\'s change needs a trailer', () => {
    // The combined diff lists nothing (the result equals parent 1); only --remerge-diff shows that the
    // automatic merge would have kept main's attested change. Squashed, this PR would revert it.
    const mainSide = mk([b0], { 'src/analytics/a.ts': lines(12, [3, 'LTV_MAX = 0.40']) }, 'main\n\nRefute-Reviewed: wf_fixture0-m');
    const pr = mk([b0], { 'docs/x.md': 'x\n' }, 'pr docs');
    const ours = mk([pr, mainSide], {}, 'Merge main into pr', `${pr}^{tree}`);
    const r = evaluate(mainSide, run, ours);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${ours.slice(0, 7)} Merge main into pr`);
    expect(r.message).toContain('src/analytics/a.ts');
  }, 60_000);

  it('.gitattributes merge=union whose result EQUALS parent 1 (modify vs delete) is still caught (--attr-source)', () => {
    // Here -c lists nothing (result == parent 1), so only the attribute-free re-merge sees the conflict.
    const aSide = mk([b0], { 'src/analytics/a.ts': lines(12).split('\n').filter((l) => l !== 'line 4').join('\n') }, 'main: drop line 4\n\nRefute-Reviewed: wf_fixture0-a');
    const bSide = mk([b0], { 'src/analytics/a.ts': lines(12, [4, 'line 4 modified']), '.gitattributes': 'src/** merge=union\n' }, 'b\n\nRefute-Reviewed: wf_fixture0-b');
    const attrs = join(dir, '.gitattributes');
    writeFileSync(attrs, 'src/** merge=union\n');
    try {
      const unionTree = g(['merge-tree', '--write-tree', bSide, aSide]).trim().split('\n')[0] ?? '';
      expect(unionTree).toBe(g(['rev-parse', `${bSide}^{tree}`]).trim());
      const merge = mk([bSide, aSide], {}, 'Merge main into b', unionTree);
      const r = evaluate(aSide, run, merge);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain('src/analytics/a.ts');
    } finally {
      rmSync(attrs, { force: true });
    }
  }, 60_000);

  it('a replace ref that RE-PARENTS the tip onto the base cannot hide a commit from rev-list', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [9, 'hidden']) }, 'fin, no trailer');
    const tip = mk([fin], { 'README.md': 'tip\n' }, 'docs tip');
    const decoy = mk([b0], {}, 'docs tip', `${tip}^{tree}`);
    g(['replace', tip, decoy]);
    try {
      const r = evaluate(b0, run, tip);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
    } finally {
      g(['replace', '-d', tip]);
    }
  }, 60_000);

  it('runCli against real git: --head overrides HEAD, REFUTE_BASE is the base, an empty --head= means HEAD', () => {
    const docs = mk([b0], { 'README.md': 'cli docs\n' }, 'docs');
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [10, 'cli']) }, 'fin, no trailer');
    g(['update-ref', 'HEAD', docs]);
    expect(runCli(['--strict', `--base=${b0}`, `--head=${fin}`], {}, run)).toMatchObject({ exitCode: 1, stream: 'error' });
    expect(runCli(['--strict', `--base=${b0}`], {}, run)).toMatchObject({ exitCode: 0, stream: 'log' });
    expect(runCli(['--strict', `--base=${b0}`, '--head='], {}, run)).toMatchObject({ exitCode: 0, stream: 'log' });
    g(['update-ref', 'HEAD', fin]);
    // No origin/main in this repo: without REFUTE_BASE the base would not resolve and the gate skip.
    expect(runCli(['--strict'], { REFUTE_BASE: b0 }, run)).toMatchObject({ exitCode: 1, stream: 'error' });
  }, 60_000);

  it('a base ref that MOVES mid-run: the range and the recipe use the shas resolved up front', () => {
    const mainOld = mk([b0], { 'README.md': 'old main\n' }, 'main old');
    const fin = mk([mainOld], { 'src/analytics/a.ts': lines(12, [11, 'race']) }, 'fin, no trailer');
    g(['update-ref', 'refs/heads/rmain', mainOld]);
    const racer: GitRunner = (args) => {
      const out = run(args);
      // Another session moves rmain onto the commit under test right after it is verified.
      if (args.includes('rev-parse') && args[args.length - 1] === 'rmain^{commit}') g(['update-ref', 'refs/heads/rmain', fin]);
      return out;
    };
    try {
      const r = evaluate('rmain', racer, fin);
      expect(r.outcome).toBe('violation');
      expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
      expect(r.message).toContain(`--autosquash ${mainOld}`);
    } finally {
      g(['update-ref', '-d', 'refs/heads/rmain']);
    }
  }, 60_000);

  it('an octopus in the range turns on the reword recipe\'s merge warning', () => {
    const fin = mk([b0], { 'src/analytics/a.ts': lines(12, [2, 'octo-warn']) }, 'fin, no trailer');
    const q2 = mk([b0], { 'docs/q2.md': '2\n' }, 'q2');
    const q3 = mk([b0], { 'docs/q3.md': '3\n' }, 'q3');
    const octo = mk([fin, q2, q3], { 'docs/q2.md': '2\n', 'docs/q3.md': '3\n' }, 'Octopus of docs');
    const r = evaluate(b0, run, octo);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain(`${fin.slice(0, 7)} fin, no trailer`);
    expect(r.message).toContain('This range contains a merge commit');
  }, 60_000);

  it('a path containing a NEWLINE still matches its financial prefix (split on NUL only)', () => {
    const nl = mk([b0], { 'config/lease\nmarket.json': '{}\n' }, 'config with newline, no trailer');
    const r = evaluate(b0, run, nl);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('config/lease\nmarket.json');
  }, 60_000);

  it('a gitlink bump is visible even when .gitmodules says ignore = all', () => {
    const gitmodules = '[submodule "lib"]\n\tpath = src/analytics/lib\n\turl = ./lib\n\tignore = all\n';
    const g1 = mk([b0], { '.gitmodules': gitmodules, 'src/analytics/lib': { gitlink: b0 } }, 'add lib\n\nRefute-Skip: vendoring');
    const other = mk([b0], { 'README.md': 'o\n' }, 'other');
    const g2 = mk([g1], { 'src/analytics/lib': { gitlink: other } }, 'bump lib');
    const r = evaluate(g1, run, g2);
    expect(r.outcome).toBe('violation');
    expect(r.message).toContain('src/analytics/lib');
  }, 60_000);
});

// A committed repo-root git.exe / git.cmd must never be what the gate runs. On Windows, libuv's executable search
// (execFileSync('git')) tries the cwd first, so the gate resolves git to an absolute path OUTSIDE the checkout up front.
// Coverage: the PATH-walk semantics are tested with synthetic win32 AND posix paths (injected isFile, so they run on
// any host); the fail-closed CLI path and the real-PATH resolution run against a real fs fixture on the host. What is
// NOT re-proved here is libuv's own cwd-first lookup: the resolver makes the result independent of it.
describe('check-refute-required — git is resolved outside the checkout (fail CLOSED)', () => {
  // ── PATH-walk semantics, synthetic paths ──
  const W_REPO = 'C:\\work\\repo';
  const W_TRUSTED = 'C:\\Program Files\\Git\\cmd';
  const P_REPO = '/work/repo';
  const P_TRUSTED = '/usr/bin';
  const files = new Set([
    `${W_REPO}\\git.exe`,
    `${W_REPO}\\bin\\git.exe`,
    `${W_REPO}\\git.cmd`,
    `${W_TRUSTED}\\git.exe`,
    'C:\\cmd-only\\git.cmd',
    'C:\\cmd-only\\git.bat',
    `${P_REPO}/git`,
    `${P_REPO}/bin/git`,
    `${P_TRUSTED}/git`,
  ]);
  const has = (p: string): boolean => files.has(p);

  it('win32: skips every PATH entry inside the checkout and returns the first git.exe outside it', () => {
    const pathEnv = [W_REPO, `${W_REPO}\\bin`, W_TRUSTED].join(';');
    expect(resolveGitExecutable({ pathEnv, platform: 'win32', untrusted: [W_REPO], isFile: has })).toBe(`${W_TRUSTED}\\git.exe`);
  });

  it('win32: never returns a .cmd/.bat git (execFile cannot run one without a shell)', () => {
    expect(() => resolveGitExecutable({ pathEnv: 'C:\\cmd-only', platform: 'win32', untrusted: [W_REPO], isFile: has })).toThrow(
      /outside the repository/,
    );
  });

  it('win32: untrusted directories match case-insensitively, with or without a trailing separator', () => {
    const pathEnv = [W_REPO.toUpperCase() + '\\', W_TRUSTED].join(';');
    expect(resolveGitExecutable({ pathEnv, platform: 'win32', untrusted: [W_REPO.toLowerCase()], isFile: has })).toBe(`${W_TRUSTED}\\git.exe`);
  });

  it('skips relative and empty PATH entries (they resolve against the cwd)', () => {
    for (const rel of ['.', '', 'bin', '.\\bin', './bin', '..\\x']) {
      expect(resolveGitExecutable({ pathEnv: [rel, W_TRUSTED].join(';'), platform: 'win32', untrusted: [W_REPO], isFile: () => true })).toBe(
        `${W_TRUSTED}\\git.exe`,
      );
    }
    expect(resolveGitExecutable({ pathEnv: ['', '.', 'bin', P_TRUSTED].join(':'), platform: 'linux', untrusted: [P_REPO], isFile: () => true })).toBe(
      `${P_TRUSTED}/git`,
    );
  });

  it('posix: same rule with ":" separators and an extension-less git', () => {
    const pathEnv = [P_REPO, `${P_REPO}/bin`, P_TRUSTED].join(':');
    expect(resolveGitExecutable({ pathEnv, platform: 'linux', untrusted: [P_REPO], isFile: has })).toBe(`${P_TRUSTED}/git`);
  });

  it('throws (fail closed) when the only git on PATH is inside the checkout, or there is none', () => {
    for (const pathEnv of [W_REPO, [W_REPO, `${W_REPO}\\bin`].join(';'), '', undefined]) {
      expect(() => resolveGitExecutable({ pathEnv, platform: 'win32', untrusted: [W_REPO], isFile: has })).toThrow(/outside the repository/);
    }
    expect(() => resolveGitExecutable({ pathEnv: P_REPO, platform: 'linux', untrusted: [P_REPO], isFile: has })).toThrow(/outside the repository/);
  });

  // ── real fs fixture on the host ──
  let dir = '';
  let repo = '';
  let marker = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'refute-gitres-'));
    repo = join(dir, 'repo');
    marker = join(dir, 'FAKE-GIT-RAN');
    mkdirSync(join(repo, 'bin'), { recursive: true });
    // Fake gits inside the "repo": each would drop a marker file if it were ever executed.
    const drop = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    for (const d of [repo, join(repo, 'bin')]) {
      writeFileSync(join(d, 'git.exe'), 'MZ fake');
      writeFileSync(join(d, 'git.cmd'), `@node -e "${drop.replace(/"/g, '\\"')}"\r\n`);
      writeFileSync(join(d, 'git'), `#!/bin/sh\nnode -e '${drop}'\n`, { mode: 0o755 });
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runCli exits NON-ZERO with a clear message when git cannot be resolved outside the repo, and never runs the fake', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const r = runCli(['--strict', '--base=origin/main'], { PATH: [repo, join(repo, 'bin')].join(sep) }, undefined, [repo]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stream).toBe('error');
    expect(r.message).toMatch(/FAILED CLOSED/);
    expect(r.message).toMatch(/outside the repository/);
    // Non-strict mode too: an unresolvable git is never a warning-and-pass.
    const nonStrict = runCli([], { PATH: '' }, undefined, [repo]);
    expect(nonStrict.exitCode).not.toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('on this host, the real PATH resolves to an absolute git outside the checkout, and that git runs', () => {
    const real = resolveGitExecutable({ pathEnv: process.env.PATH, platform: process.platform, untrusted: [process.cwd()] });
    expect(resolve(real)).toBe(real);
    expect(real.toLowerCase().startsWith(process.cwd().toLowerCase())).toBe(false);
    expect(gitRunnerFor(real)(['version'])).toMatch(/^git version /);
  });
});
