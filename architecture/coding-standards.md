# Coding Standards — Oxford Command Center

**Status:** Architecture lock file — all agents must follow these standards. `npm run gate` enforces most of them automatically (typecheck + lint).

---

## TypeScript

**Compiler config:** `tsconfig.json` with `strict: true` + `noUncheckedIndexedAccess: true`.

- `noUncheckedIndexedAccess` means every array index access returns `T | undefined`. Always guard: `arr[0]` has type `T | undefined`, not `T`. Use `arr.at(0)` or check first.
- No `any`. No `@ts-ignore`. No `as unknown as T`. Use Zod `.parse()` at boundaries.
- No `!` (non-null assertion) on data that could realistically be null. Use optional chaining + nullish coalescing.
- All server-to-client data must cross through a Zod schema in `src/contracts/`. Never pass raw JSON to the client as an implicit type.

**Naming:**
| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `warehouse-verify.ts`, `qb-excel.ts` |
| Functions | camelCase | `openWarehouse`, `runMigrations` |
| Types/Interfaces/Zod schemas | PascalCase | `PortfolioSnapshot`, `ImportBatch` |
| Constants | SCREAMING_SNAKE_CASE | `WAREHOUSE_DB`, `NOI_INCOME_CLASSES` |
| React components | PascalCase | `AlertsModule`, `IntelModule` |
| CSS classes | Tailwind utilities inline — no custom class names unless in a design token |
| Test descriptions | Plain English sentence describing behavior | `'returns 503 when warehouse unavailable'` |

---

## File Size & Responsibility

- One clear responsibility per file. If you can't describe what a file does in one sentence, split it.
- Server-side: pure computation functions (no I/O) belong in dedicated `.ts` files. Routes belong in `api.ts` files. DB access belongs in `queries.ts` / `actions.ts`.
- Client-side: each module has its own directory under `src/modules/`. Don't put logic in the module component file — extract to a separate `*.logic.ts` or hook.
- Files > 400 lines are a signal to split. Not a rule — a signal.

---

## Testing

**Framework:** vitest 2.x with jsdom environment.
**Pattern:** TDD — write the failing test first, watch it fail, then implement.

**Test file location:** `tests/unit/` for pure logic; `src/modules/**/*.test.tsx` for component tests; `tests/e2e/` for Playwright.

**Test naming:**
```typescript
describe('moduleName / function name', () => {
  it('does X when Y', () => { ... });
  it('throws when Z', () => { ... });
});
```

**What to test:**
- Pure functions: every code path, every edge case.
- Zod schemas: valid input parses, invalid input throws.
- Warehouse functions: use an in-memory SQLite (`:memory:`) — never use the production `data/warehouse/finance.sqlite` in tests.
- API routes: inject a temp-db via the `getDb` factory; test 200/400/503 paths.
- Do NOT test: React component internals, visx chart rendering, Tailwind class presence.

**In-memory SQLite pattern for warehouse tests:**
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

**Test isolation & order:**
- **Per-file isolation is mandatory.** `vitest.config.ts` MUST keep `isolate: true` (guarded by `tests/unit/test-isolation.test.ts`). With `isolate: false` every file shares one module registry in the single worker, so module-level state AND unreset `vi.mock` registrations bleed across files in order-dependent ways — flakes that pass in isolation but fail intermittently in the full suite. The threads pool isolates without a `child_process` spawn, so isolation does not reintroduce the Node 24 + Windows forks spawn fault.
- **Never import `vitest.config.ts` into a test.** Importing it pulls in Vite, which trips a `TextEncoder/Uint8Array` invariant under the jsdom environment. To assert on config, read the file as text and match the setting (see the regression guard).
- **Detect order fragility with `npm run test:shuffle`.** It randomizes both file and test order (`--sequence.shuffle.files --sequence.shuffle.tests`). `isolate: true` covers *cross-file* leakage; shuffling also surfaces *within-file* ordering bugs (a test depending on state another test set up). On failure vitest prints the seed — re-run with `--sequence.seed=<N>` to reproduce deterministically.

**Gate requirement:** `npm run gate` must stay green. Never commit with failing tests.

**Financial-decision code — mandatory adversarial pass.** A green gate proves the code matches its
fixtures; it does NOT prove correctness on data the corpus never exercises. Any change to
financial-decision logic — a new or modified `evaluateConditions` alert rule, the analytics engine
(growth / drivers / anomalies / benchmarks / scores), NOI/reconciliation math, the acquisition
scorecard, or anything feeding capital allocation — gets the `refute-financial-change` workflow
(`.claude/workflows/refute-financial-change.js`) BEFORE merge: independent reviewers told to *break*
the change across the correctness / determinism / edge-case / sweep-completeness / scope-integrity
lenses, not bless it. This is not optional and is separate from the standard code-review pass. It
exists because a green gate has shipped, among others: a collections rule that NaN-suppressed a
real delinquency on a partial overlay record, an alert-id collision that let one anomaly silently
mark another read, and an off-by-one aging-bucket tier — none of which any fixture caught. New
`evaluateConditions` rules MUST
also (a) coerce every overlay-sourced numeric defensively (overlay JSON bypasses Zod on the live
path — see `server/overlay.ts`; coerce via the shared `coerceNonNegMoney` in `src/lib/money.ts`) and
(b) emit a collision-free `Insight.id` (guarded by `tests/unit/insight-id-uniqueness.test.ts`).

This is enforced mechanically: `npm run check:refute` (CI job `refute-required`, PR-only) fails when a
commit changing financial-decision source lands without a `Refute-Reviewed: wf_<runId>` (or justified
`Refute-Skip:`) trailer. Scope is `isFinancialSourcePath` in `scripts/check-refute-required.ts`:
`server/**` and `scripts/**` are default-deny, plus `src/analytics/**` and the named contract, seed and
config files. Make it a required check via branch protection to hard-block.

_What the gate does and does not stop (threat model, PR #490, refute run wf_d3be7fbd-39e)._ `check:refute` is a
**trailer-requirement check**, and CI runs it from the **PR head's own copy** of the script and of `ci.yml`. It stops
an **accidental omission**: a financial or gate-wiring change landing with no `Refute-Reviewed:` / `Refute-Skip:`
trailer. It does **not** stop a malicious committer, who controls the code that judges the PR. The paths below are
the gate wiring an honest commit is most likely to touch by accident. They are not everything the gate step runs
through.

_Gate wiring (2026-10-18)._ `REFUTE_GATE_PATHS` and `REFUTE_GATE_PATH_PREFIXES` in
`scripts/check-refute-required.ts` are checked **before** every exemption set, so no later exemption entry can
switch them off. Every commit touching one of these needs its own trailer:

- `.claude/workflows/refute-financial-change.js` (decides what `clean` means) and
  `scripts/check-refute-required.ts` (decides which paths need a trailer).
- The **root** `package.json`, as a whole. It defines the developer `npm run check:refute` script and the install
  scripts `npm ci` runs in the gate job. The gate classifies by path only (`git show --name-only`, never diff
  content), so it cannot tell those from a dependency bump: **every root `package.json` edit, dependency bumps
  included, now needs a trailer.**
- The **root** `.npmrc`. npm exports its `node-options` key as `NODE_OPTIONS` to every `npm run` script and to the
  lifecycle scripts `npm ci` runs. A preload there could make the developer `npm run check:refute` exit 0 without
  running the check. CI no longer runs the gate through `npm run` (see below), but `npm ci` in the same job still
  reads `.npmrc`.
- The whole `.github/workflows/` directory (prefix match, anchored at the repo root): `ci.yml` runs the gate,
  and any workflow file, including a new one, could publish a check under the required check's name.
- `scripts/package.json`: the `package.json` nearest the gate script, which node and tsx read for its module format
  and `#`-subpath imports. It does not exist today; protecting it costs nothing. (`scripts/lib/package.json` is not
  protected: it would only govern `scripts/lib/**`, which the gate script does not import.)
- **Repo-root executables.** On the Windows self-hosted runner `cmd.exe` searches the current directory, which is
  the repo root, before `PATH` unless `NoDefaultCurrentDirectoryInExePath` is set. A committed root `tsx.cmd`,
  `node.cmd` or `git.exe` would run instead of the real tool. So every root file (no `/` in the path) with a `.cmd`,
  `.bat`, `.com`, `.exe` or `.ps1` extension is a gate path. So is a root `git`/`node`/`npm`/`npx`/`tsx` file with a
  Windows script-host extension (`.js`, `.jse`, `.vbs`, `.vbe`, `.wsf`, `.wsh`, `.msc`), which `cmd.exe` also tries.
  None exist today (`git ls-files` at the root, 2026-10-18), so **adding or editing any such root file now needs a
  trailer.**

**Every** classification rule matches **case-insensitively**, not just the gate wiring. That covers the default-deny
roots, the allow-lists, the exemption sets and the test/doc extensions. The path is lower-cased once at the top of
`isFinancialSourcePath`, so a case-variant path is classified exactly like its lower-case form. On the Windows
runner's NTFS checkout, `Server/warehouse/x.ts` overwrites `server/warehouse/x.ts`. As a consequence an exemption
also covers case-variants of the exempt path. That only matters on a case-sensitive checkout such as
`ubuntu-latest`, where `server/warehouse/API.ts` or `server/warehouse/calc.Test.ts` is a distinct file that is now
exempt (it was financial before). It opens nothing new, because the exempt lower-case file can already be edited
without a trailer.

CI is hardened as well. The `refute-required` job in `.github/workflows/ci.yml` sets
`NoDefaultCurrentDirectoryInExePath: '1'` job-wide, which also covers the lifecycle scripts `npm ci` runs. The gate
step runs `node node_modules/tsx/dist/cli.mjs scripts/check-refute-required.ts --strict ...` directly, so no `tsx`
command is looked up and nothing goes through `npm run`. Developers still run `npm run check:refute` locally; it
names the same script. The script resolves `git` to an absolute path **outside** the checkout and the cwd before
running anything (`resolveGitExecutable`), and **fails closed** (exit 1, strict or not) if it cannot. Under
`--strict` (CI), a **git tooling gap** also fails closed with exit 1. That covers:
- git resolves but throws;
- git exits 0 with output it cannot parse: an unrecognised `git version`, a shallow probe that is neither `true`
  nor `false`, or a base/`HEAD` `rev-parse` that is not a 40- or 64-hex commit id;
- git < 2.41;
- a shallow clone;
- the base or `HEAD` does not resolve.

Only an empty `--base` (caller configuration) still warns and exits 0 under `--strict`. In default (local) mode
every one of these still warns and exits 0. An explicit `--head` that does not resolve, a range that cannot be
listed, and an unreadable commit are *violations*: exit 1 under `--strict`, warn and exit 0 in default mode.

_Known open gaps_ (accepted; one line each):
- `package-lock.json` and `npm ci` install scripts: a dependency's install script can write `GITHUB_ENV` (e.g.
  `NODE_OPTIONS`) and reproduce the `.npmrc` preload for the later gate step. The lockfile is unprotected so that
  dependency bumps don't need a trailer.
- The self-hosted Windows runner (`CI_RUNNER=self`; not `ubuntu-latest`) persists state across jobs, so one run
  can poison the next. That state is tsx's on-disk transform cache, the setup-node tool cache, the workspace `.git`
  (`.git/info/attributes` survives `--attr-source`, so `merge=union` can silence a remerge conflict; also
  `.git/config`), and the runner user's profile and global gitconfig.
- `resolveGitExecutable` compares `PATH` entries as text, so an alias of the checkout (trailing dot, 8.3 short name,
  junction/symlink) is not recognised as inside it.
- `tsconfig.json`: tsx reads it. The gate script imports only `node:` builtins, so `paths`/`baseUrl` redirect nothing
  today.
- Nested `package.json` / `.npmrc` files other than `scripts/package.json`, and `scripts/lib/package.json`. These are
  inert for the gate **only because** the gate script imports nothing but `node:` builtins and uses no `#`-subpath
  imports. The reason is not that "CI runs from the root": node and tsx read the `package.json` nearest the *script*.
  If the gate script ever imports a local module, re-check this list.
- Root files with other extensions that only matter through a tool's own config (e.g. `eslint.config.js`): the gate
  step does not run them.

**Structural fix (tracked separately, not done in PR #490):** run the gate from the **base branch's trusted copy** of
the script and workflow on an **ephemeral runner**, so the PR under review cannot change the code or the machine that
judges it. Until then, treat a passing `refute-required` check as "no trailer was forgotten", not as tamper-proof.

_What a `Refute-Reviewed:` id may claim._ The workflow result's `clean` is true only when every lens succeeded,
none found a real defect, the worst severity is below medium, and the **default lens set** (or a superset of it,
each default lens verbatim) ran; a custom or re-worded lens set is never `clean`. A lens counts as defect-free only
when `foundRealDefect` is exactly `false` (missing, `null`, `0` or a string fails closed), and a non-array
`findings` ranks as critical. Record a bare `Refute-Reviewed: wf_<id>` only for a clean, unscoped run (the check
cannot verify this; see the grammar below); otherwise qualify it after the id: `(scoped)` when `outOfScope` was used,
`(effort=<level>)` for a reduced-effort run, and
`(base-workflow)` when the run was launched from main's copy of the workflow while the change under review modifies
the workflow itself (the attestation then comes from the rules being replaced, not the ones being merged).
`changeSet` / `greenContext` are trusted caller input: the result records their sha256 and length (UTF-16 code
units) so an auditor can match them to the cited change set.

_Qualifier grammar (enforced by `check:refute`)._ `check:refute` sees only the trailer text, so it cannot verify
that a **bare** id is clean: that stays on the author, and the workflow's `clean` field is the authority. What it does
enforce is that a qualifier, once written in a parenthetical right after the `wf_<id>`, is well-formed.

- Items, comma-separated, each at most once, in any order: `clean` (explicit synonym of bare), `scoped`,
  `base-workflow`, `effort=<low|medium|high|xhigh|max>`, `partial: <reason>` (a lens failed) and
  `accepted: <reason>` (findings the author accepted).
- `partial`/`accepted` need a real reason (no placeholder, `<blank>` or `wf_<runId>`). `clean:`, `scoped:` and
  `base-workflow:` may carry a free-text note, as in main's `(clean: nothing above LOW; ...)` form (#480).
- A note or reason runs up to the next comma segment that itself starts an item, so it may contain commas and nested
  parentheses but never hides a following item. `clean` cannot sit beside `scoped`/`partial`/`accepted`.
- A parenthetical is a qualifier only when its first word is one of those words followed by `,` `:` `=` `)` or the
  end. Anything else (`(opus 5.5 subagents)`, `(scoped to the ingest)`) is prose, and a bare id or prose trailer is
  unchanged, because main already carries both. A malformed qualifier (`effort=ultra`, `partial` with no reason, a
  duplicate item) rejects the trailer.
- Only the first id's first parenthetical is inspected, and nothing after its closing parenthesis is read. A qualifier
  separated from the id by anything but whitespace (a colon, `'s`, full-width parentheses) is prose. A wrapper
  around the id (`` `wf_x` (effort=zzz) ``) does not hide the qualifier.
- Known open gaps (refute `wf_f2435027-ad6`, accepted by Gabriel), each failing open to the pre-grammar behavior: an
  unbalanced `(` inside a note hides later items; a `partial`/`accepted` reason is tested raw, so a wrapped
  placeholder (`"TBD"`) passes; a wrapped id followed by prose hides the qualifier; items separated by anything but
  commas (semicolon, space) are prose, which reads as a bare id.
- Example: `Refute-Reviewed: wf_d10ede49-078 (scoped, effort=low, accepted: one low, fixed next commit)`. The squash
  commit's union of trailers (below) keeps each qualifier verbatim.

_Attestation is per commit, not per range (2026-09-23)._ Every commit in `base..HEAD` whose **own**
changed paths include financial source must carry the trailer in **its own** message. A trailer on
one commit never attests another, whether the other commit comes earlier or later. The gate used to
search the whole range's concatenated log, so a single `Refute-Skip:` on a plumbing commit covered an
unattested `src/analytics/conditions.ts` change in its child.

- **Merge commits:** a two-parent merge is read two ways, and the listed paths are combined:
  - `--remerge-diff` lists hand edits and conflict resolutions.
  - A combined diff (`-c`) lists every path whose merged content differs from **both** parents. This
    catches a clean merge that carries an edit across a rename **into** a financial path.

  A merge needs its own trailer when either list includes a financial path. That covers a merge
  that hand-edits financial source, resolves a conflict inside a financial file, carries changes
  across a rename into one, or combines both sides' changes to the same financial file. The last case
  is the deliberate cost. A catch-up of `main` that touches no file changed on both sides needs
  nothing. Octopus merges are diffed against their first parent. The re-merge reads attributes from
  the empty tree, so a committed `.gitattributes` such as `merge=union` cannot make a conflict
  re-merge cleanly.
- **When the gate fails open (skips):** only when the range itself cannot be verified. That means
  the base does not resolve, `--base` is empty, the repo has no commits, the clone is shallow, git is
  older than 2.41, or git is unusable. Once both ends resolve, everything fails closed. That covers
  an explicit `--head` that does not resolve, a range that cannot be listed, and a commit that cannot
  be read, which no trailer clears.
- **Valid trailers:** a trailer needs a real value. A bare `Refute-Skip:` or the pasted placeholder
  does not count.
- **Attesting an earlier commit:** do this in your **own worktree** (`git worktree add`), never in a
  shared checkout. The steps, in Git Bash, use no editor:
  1. `PRE=$(git rev-parse HEAD)`
  2. `GIT_EDITOR="git interpret-trailers --in-place --trailer 'Refute-Reviewed: wf_<runId>'" git commit --fixup=reword:<sha>`
     (bare id = clean, unscoped run only; otherwise append the qualifier, e.g. `'Refute-Reviewed: wf_<runId> (scoped)'`)
  3. `GIT_SEQUENCE_EDITOR=: git rebase -i --rebase-merges --autosquash <merge-base sha>`
  4. `git diff --exit-code "$PRE" HEAD`

  Notes on each step:
  - The gate prints the resolved merge-base, because the base ref may have moved by the time you run
    the recipe.
  - `--rebase-merges` keeps a merge commit in place, where a plain rebase would drop it and replay its
    conflicts. But it re-creates every merge after the reworded commit, and it drops their hand edits
    and conflict resolutions without warning.
  - A pure reword changes no content, so the final diff must print nothing. If it prints anything,
    restore the branch with `git reset --keep "$PRE"` and reword by hand.
  - Pin `PRE` yourself rather than relying on `ORIG_HEAD`, which is one slot per worktree. Another
    session's `git reset` overwrites it, and the check then passes on a rebase that dropped a hand edit.
  - Never recover with `reset --hard`, which also discards another session's uncommitted work.
- **Squash merges:** `main` is squash-merged, so this check runs on the PR branch. CI passes
  `--head=<PR head sha>`, not GitHub's synthetic merge. **The squash commit message must carry the
  union of the branch's trailers** (one line per distinct `Refute-Reviewed`/`Refute-Skip`), because the
  branch commits do not survive onto `main`.

**Delivery-only allowlist.** A small set of pure route-plumbing files under the default-deny roots
(e.g. `server/warehouse/capital-allocation-api.ts`, `server/sources/graph-auth.ts`) is explicitly exempted from the trailer
requirement. `DELIVERY_ONLY_PATHS` in `scripts/check-refute-required.ts` is the source of truth for
the membership; its test pins the exact set. The gate is fail-**closed** for everything else — any
warehouse file not in the allowlist still requires a trailer. Adding to or removing from the
allowlist requires architect sign-off (same as any `architecture/` change); a new file not yet listed
just keeps requiring a trailer until it is explicitly approved and added.

_Removed 2026-11-09:_ `server/warehouse/api.ts` (refute run `wf_44a3341e-b41`; architect sign-off:
"Gabriel (architect) approved 2026-11-09"). Its `POST /acquisition/score` handler resolves the
ratified config, scores and applies the governor proxy, and `/acq/intel` owns the verdict-rank
ORDER BY, so it is not plumbing. Its edge twin `functions/api/warehouse/acquisition/score.ts` is
gated, and both halves of one score contract must classify the same way. Every `api.ts` commit
now needs a trailer (a pure-routing edit may use the `Refute-Skip: route-only` escape hatch below).

_Removed 2026-11-09:_ `server/warehouse/debt-api.ts` (refute run `wf_c135181a-31a`; architect
sign-off: "Gabriel (architect) approved 2026-11-09"). It compares LTV against
`RATIFIED_GOVERNORS.ltvCeiling` to return `governor-block`, owns the write-boundary Zod bounds
(`BoundedLoanForSnapshotWrite`: `ltv` 0..1.5, non-negative balance) and the rate/LTV collision
suppression. That is governor logic, not plumbing, by the same criterion that removed `api.ts`.

_Caveat on `actions.ts`:_ it dispatches recompute (`scoreProperties`, `detectAnomalies`) but
contains no financial math of its own. It qualifies as delivery-only under the current definition;
re-evaluate this entry if it gains analytic logic.

**Escape hatch for unlisted route files.** If a PR touches a route file not yet in the allowlist
and you are confident it contains no financial math, use:

```text
Refute-Skip: route-only — <file(s)> contain no financial math
```

This trailer is acceptable for genuine plumbing PRs only. It is never acceptable for changes that
touch engine math, scoring, NOI/reconciliation, alert conditions, or the financial overlay.

---

## Imports

**Order (enforced by Prettier/ESLint):**
1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`hono`, `zod`, `better-sqlite3`)
3. Internal aliases (`@contracts`, `@analytics`, `@`)
4. Relative imports (`./`, `../`)

No default exports from utility/logic files. Named exports only.

---

## Error Handling

- Server routes: return typed JSON errors, never throw unhandled.
- Warehouse operations: use the `503 { error: 'warehouse unavailable' }` pattern when the DB is unreachable. Never crash the server on a missing SQLite file.
- Client: React error boundaries at module level. Query errors surface via TanStack Query's `error` state.
- Scripts (`gate`, `reconcile`, `warehouse-verify`): `process.exit(1)` with a clear message on failure. Never silent failures.

---

## Comments

Write no comments by default. Write a comment only when:
- The WHY is non-obvious (a hidden constraint, a workaround for a specific bug).
- A subtle invariant that would surprise a reader.

Never write:
- What the code does (well-named identifiers do that).
- TODOs in committed code (use GitHub issues).
- References to tasks, PRs, or dates (those belong in commit messages).

---

## Commits

Format: `type(scope): description`

| Type | Use for |
|------|---------|
| `feat` | New behavior |
| `fix` | Bug fix |
| `refactor` | No behavior change |
| `test` | Tests only |
| `docs` | Documentation only |
| `chore` | Config, deps, tooling |
| `perf` | Performance improvement |

Scope = affected module/subsystem (e.g., `warehouse`, `intel`, `governance`, `brief`).

Commit atomically — one logical change per commit. Always include test files in the same commit as the code they test.

---

## Git / PR Protocol

- Never push directly to `main`. All changes via PR.
- Branch naming: `feat/cc-<feature>`, `fix/cc-<bug>`, `worktree-<feature>` (worktree branches).
- Each worktree has ONE branch and ONE PR. See `architecture/agent-assignments.md`.
- Stacked PRs: list base branch in PR description. Merge order: base first, then stacked. See `CLAUDE.md §PR Protocol`.
- `npm run gate` must be green before requesting review.
- Squash merge into main (not merge commits).

---

## Security

- Never log secrets, API keys, or tenant PII.
- `data/overlay.json` is gitignored — never commit it.
- Confidential deal data stays off all external surfaces (enforced by `confidential-terms.json` hook).
- SQLite file (`data/warehouse/finance.sqlite`) is gitignored.
- CORS locked to localhost — never relax this.
- Real firm data is never tracked (ruling 2026-11-10, superseding the 2026-06-14 owner decision that let confidential deal terms live in `src/data/seed-deals.ts`). Every path in `scripts/fixtures/real-data-manifest.json` (snapshot, seed deals/counterparties, property-financials dataset and curated inputs, AR cache/queue, building specs, calibration, cost seg, account-mapping seed, annual statements) is gitignored and local-only; the committed copy is the synthetic stand-in under `fixtures/synthetic/`, generated by `npm run data:synthetic` (scripts/fixtures/build-synthetic-data.ts) and seeded into place only when absent by `scripts/ensure-local-data.ts` (postinstall + vitest globalSetup). The pre-push scan and `npm run governance` fail closed on any tracked manifest path. Tests derive expectations from the dataset in place (synthetic in CI, real locally), never from hardcoded real values. The `confidential-terms.json` egress guard still bars confidential terms from the public site, the `/dist/` mirror, Notion, and email.

### Pre-push confidentiality hook

A native git `pre-push` hook (`scripts/prepush-confidential-scan.mjs`) scans the **added** lines of every push and blocks it if any active-deal confidential term appears. This closes audit finding H1 — the repo previously had no native pre-push confidentiality gate, which let an active deal's terms get committed.

- **Fail-closed:** any matched term prints `file:line  ->  matched '<term>'` to stderr and exits non-zero, aborting the push.
- **Term source:** the machine-local roster `~/.claude/hooks/confidential-terms.json` (git-ignored, off-repo), merged with a small generic built-in denylist. If the roster is absent or unparseable, the hook still scans the denylist and prints a WARN — it does **not** block all pushes just because the roster is missing.
- **Install:** `npm run hooks:install`. It also runs automatically via the `prepare` script on `npm install`, so a fresh clone gets the hook with no extra step. Re-running is safe (idempotent).
- The scanner exposes a pure, unit-tested `scanDiffForConfidential(addedLines, terms)` used by `tests/unit/prepush-confidential-scan.test.ts`.

### Pre-push NOI cross-check reminder (OI-137 / OI-162 fix #1)

The same installed hook also runs `scripts/prepush-noi-crosscheck.mjs` after the confidentiality scanner, on every push.

- **ADVISORY ONLY — must never block a push.** `reconcile:noi-crosscheck` (Spine A workbook vs. Spine B warehouse NOI) is known to currently FAIL on `main` for 3 properties (OI-137, a structural forward-looking-vs-historical-actuals mismatch, not a data bug), and needs the live OneDrive workbook, which isn't reachable from every worktree. The wrapper in `install-git-hooks.ts` enforces this **structurally**, not just by convention: it does not `exec` the NOI script as its last statement, guards its existence with `-f`, appends `|| true`, and ends on an unconditional `exit 0` — so the hook still exits 0 even if the NOI script is missing entirely (e.g. an older worktree checkout) or throws before printing anything. **Do not "simplify" this back into a bare `exec` or a trailing bare invocation** — that reintroduces the exact bug an adversarial review caught before this landed (2026-08-16): a broken/missing NOI script would then determine the hook's own exit code and silently block every push.
- Distinguishes a real reported result (recognizable output, e.g. contains "properties checked") from the harness itself failing to run (missing dependency, timeout, wrong cwd) — the latter prints a visibly different message rather than being mistaken for the known OI-137 drift.
- A future flip to BLOCKING is a standalone decision once OI-137 is resolved or the script grows a documented tolerance/exception list — not something to do by editing this hook alone.
