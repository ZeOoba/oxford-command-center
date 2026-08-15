# Implementation Plan — OI-049 / OI-050 / OI-051 (appsec fixes)

**Branch:** `plan/appsec-fixes-oi049-051` (based on `main` @ `d705a3f`)
**Scope:** the 3 oxford-command-center findings from the 2026-07-31 `ora-appsec-sweep` (security-auditor dispatch). Planning only — no code changed in this worktree.
**Model:** claude-fable-5 (financial-decision + security-gate code floor per CLAUDE.md)

**Worktree examined:** `C:/Users/Owner/occ-wt-appsec-fixes` @ `d705a3f` (main). Sweep ran at `3692385`; commits since then: `044312d` + merge `8c4a6a9` (PR #248, deploy timeout), `8274d0d` (#249, deploy beacon), `d35931a` (#250), `d705a3f` (#251). **Only `scripts/deploy-mirror.ps1` among the findings' files changed since the sweep.**

**Headline sequencing facts (verified, not assumed):**
- **PR #248 IS MERGED** — the open-items-tracker/event_log note calling it "NOT yet merged" is stale. `git log 3692385..HEAD -- scripts/deploy-mirror.ps1` shows both #248 (`044312d`, merged via `8c4a6a9`) and #249 (`8274d0d`) in main. `Invoke-AccessGateProbe` now exists in the script at lines 91–138. OI-051 should **build on it now**, not wait.
- **The in-flight checkSnapshot branch (`fix/wire-checksnapshot-into-cli-writers`) touches exactly 3 files** (verified via `git diff --name-only main...fix/wire-checksnapshot-into-cli-writers`): `scripts/extract-workbook.ts`, `scripts/lease-snapshot-drift-check.ts`, `tests/unit/lease-snapshot-drift-check.test.ts`. **None of the 3 findings touch any of those files. Zero overlap; all three fixes are independent of that work.**
- Recommend **three separate PRs** (one per finding) so each REFUTE pass has a clean blast radius.

---

## OI-049 — No mechanical change-gate on ratified financial config

### 1. Current-code verification
Confirmed on `d705a3f`, all four gate absences still hold:
- `.claude/hooks/architect-owned.json` globs (lines 3–17): no `config/**` entry. CLAUDE.md §4's Architect-only list likewise omits `config/` (the two must move together — the JSON's `_source` comment mandates same-PR sync with CLAUDE.md §4).
- `scripts/check-refute-required.ts:68` — `isFinancialSourcePath` **hard-excludes every `.json` path** before any other check: `if (... || path.endsWith('.json')) return false;`. The ratified configs can never trigger the refute gate as written.
- `scripts/governance-check.ts` (481 lines) — `grep` for `ruleset|replacement-cost|config/` returns nothing.
- History confirmed: `a83ce68` (#210, 2026-07-14) changed both config files with no version bump; `d28d8bf` (#216) did the 1.0.0→1.1.0 ceremony 2 days later. Current file carries `rulesetVersion: "1.1.0"`, `ratifiedDate: "2026-07-14"` — **no active drift**, matching the finding. Only the `_comment` prose protects the files.
- Note the RCT v1→v3 transition was a **file rename** (`replacement-cost.v1.json` deleted, `v3.json` created in #210) — the gate must survive filename-version bumps, so enumerated exact paths alone are insufficient.

### 2. Root cause
The ratified financial configs sit outside every mechanical gate because all three gates enumerate paths and none enumerates `config/`; `check-refute-required.ts` additionally has a categorical `.json` exclusion that predates ratified-JSON config existing. Prose in `_comment` is the only control.

### 3. Proposed fix (three layers, one PR)
**Layer 1 — write-time (architect-owned):** add `config/*.json` (top-level only; `config/archive/**` intentionally excluded — archives are append-only history, and `file-guard.mjs`'s minimal glob matcher supports `*` within a segment) to `.claude/hooks/architect-owned.json`, and add the same line to CLAUDE.md §4's Architect-only list in the same PR.

**Layer 2 — CI diff gate (`scripts/check-refute-required.ts`):**
- Add `export const RATIFIED_CONFIG_GLOB` matching `config/*.json` (not `config/archive/`), checked in `isFinancialSourcePath` **before** the line-68 `.json` exclusion (order is load-bearing — a REFUTE lens should attack exactly this ordering).
- Add a new pure function `checkRatifiedConfigVersionBump(baseBlob: string | null, headBlob: string | null): { ok: boolean; reason?: string }` that parses both blobs and requires the version field (`rulesetVersion` / `rctVersion` — detect whichever is present) to **differ** whenever any other content differs. In `main()`, for each changed `config/*.json` in the diff range, fetch `git show ${base}:${path}` and `git show HEAD:${path}` and run it; added/deleted/renamed config files (the v1→v3 shape) pass `null` for the missing side and always require the refute trailer. In `--strict`, a content change without a version bump fails even **with** a trailer — the version bump is the ceremony, not a substitute for it. Keep the existing fail-open posture only for git tooling failures, per the file's doctrine.
- Requiring the `Refute-Reviewed:`/`Refute-Skip:` trailer for these paths comes free once they're financial-source paths.

**Layer 3 — gate integrity (`scripts/governance-check.ts`):** add `export function checkRatifiedConfigIntegrity(root: string): GovernanceResult` following the existing exported-pure-function pattern (`checkAcqGovernorCoupling` is the closest template): for each of the two files — exists, parses, `ratification === 'ratified'`, non-empty version field, `ratifiedBy`, `ratifiedDate`. Blocking errors. Wire into the runner. This makes a de-ratified or structurally mangled config fail `npm run gate` even locally.

### 4. Test plan (TDD)
Existing test files to extend: `tests/unit/check-refute-required.test.ts`, `tests/unit/governance-check.test.ts`.
- **RED:** (a) `isFinancialSourcePath('config/acquisition-ruleset.v1.json')` and `('config/replacement-cost.v3.json')` expect `true` — currently return `false` via line 68; (b) `isFinancialSourcePath('config/archive/acquisition-ruleset.v1.proposed.json')` expects `false`; (c) `checkRatifiedConfigVersionBump` cases — content change + same version ⇒ not ok; content change + bumped version ⇒ ok; version-only change ⇒ ok; null base (new file) ⇒ ok-with-trailer semantics; unparseable JSON ⇒ not ok (fail closed on the check itself, this is not a git tooling gap); (d) `checkRatifiedConfigIntegrity` — passing repo fixture, then fixtures with `ratification: "proposed"`, missing version field, missing file.
- **GREEN:** implement; full suite, typecheck-0, lint-0, `npm run gate` green.
- **REFUTE (MANDATORY — this is financial-decision gate code):** adversarial lenses to brief: check-ordering bypass (`.json` exclusion vs. new glob), rename/`config/archive/` smuggling, `--base` ref manipulation, version bump with no ratifiedDate change, whitespace-only diffs, the fail-open path being reachable for non-tooling failures.

### 5. Risk / rollback
Pure gate code — zero runtime blast radius (no server, no engine math touched). Main risk is **false blocking**: legitimate non-ratified config additions to `config/` would now need trailers; acceptable, and `Refute-Skip:` exists for that. Rollback = revert the single PR; no data or schema involved.

### 6. Overlap & sequencing
No overlap with checkSnapshot files or deploy-mirror. `scripts/governance-check.ts` is Architect-owned (both in CLAUDE.md §4 and architect-owned.json) — follow the STATUS.json review protocol. **Independent — can go anytime.**

---

## OI-050 — Brain server: no Host-header validation (DNS-rebinding + CSRF exposure)

### 1. Current-code verification
Confirmed exactly as reported, line references still accurate:
- `server/index.ts:531` — `serve({ fetch: app.fetch, port: serverPort(), hostname: '127.0.0.1' }, ...)` (default port 8911 per `server/config.ts:60-61`).
- `server/index.ts:52` — the **only** access control: `app.use('/api/*', cors({ origin: isAllowedOrigin }))`; `server/cors-policy.ts:9-17` is a localhost-origin allowlist. No Host check anywhere; no CSRF token; no auth on any route.
- State-changing unauthenticated routes confirmed present: `POST /api/refresh` (:253), the full `/api/actions/*` family (:262–:439 — deal-stage, task, alert, renewal-stage, tenant-note, deal-comps, noi-budget, market-rent, acquisition-input, tenant-arrears, om-extract, lease-run-assumptions), `POST /api/warehouse/properties/onboard` (:77).
- `GET /api/snapshot` (:247) returns the full portfolio. Additionally, `/sse` (:496) sits **outside** even the `/api/*` CORS middleware.
- The finding's analysis is correct: under DNS rebinding the attacker page's requests are same-origin (no `Origin` header divergence), so `cors-policy.ts` never engages. Separately, classic cross-site form POSTs (`enctype=text/plain`) carry the *real* `Host` but a foreign `Origin` — so **two** complementary checks are needed.

### 2. Root cause
The only network-boundary control is a CORS origin allowlist, which is a browser *read* control, not a request *authentication* control — it constrains neither same-origin-after-rebinding requests (wrong `Host`) nor cross-site simple POSTs (right `Host`, wrong `Origin`).

### 3. Proposed fix
New file `server/host-policy.ts` (pure, mirroring `cors-policy.ts`'s extracted-for-testability pattern):
- `LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/i` and `export function isAllowedHost(host: string | undefined): boolean` (missing/empty Host ⇒ false; strip nothing — anchoring kills `localhost.evil.com`).
- `export function isSafeCrossSiteRequest(method: string, origin: string | undefined): boolean` — for non-GET/HEAD/OPTIONS, an *absent* Origin is allowed (curl, scripts, same-origin older browsers), but a *present* Origin must pass `isAllowedOrigin` from `cors-policy.ts` (reuse, don't duplicate).
- A Hono middleware factory `export function localOnlyGuard()` composing both: 403 with a terse JSON body on failure.

`server/index.ts` change (small, surgical): `app.use('*', localOnlyGuard())` registered **before** the CORS middleware at line 52, so it covers `/api/*` **and** `/sse`. Nothing else in index.ts moves.

Explicitly out of scope (document in the PR): auth tokens for the localhost API — "unauthenticated by design" stands; the fix restores the intended trust boundary (same machine, same site) rather than adding identity.

### 4. Test plan (TDD)
- **RED:** new `tests/unit/server-host-policy.test.ts` cloning the structure of `tests/unit/server-cors.test.ts` (its look-alike table — `localhost.evil.com`, `127.0.0.1.evil.com` etc. — transfers directly): `isAllowedHost` accepts `localhost`, `127.0.0.1`, `localhost:8911`, `127.0.0.1:5173`, case-insensitive; rejects `evil.com`, `localhost.evil.com`, `127.0.0.1.evil.com`, `192.168.x.x`, `[::1]:8911` (server never binds ::1), empty/undefined, `127.0.0.1:8911.evil.com`. Middleware-level tests on a scratch `new Hono()` app via `app.request(path, { headers })` — no live server needed: rebinding shape (Host `attacker.test`, no Origin) ⇒ 403; CSRF shape (Host `127.0.0.1:8911`, Origin `http://evil.com`, POST) ⇒ 403; legit direct fetch (Host + localhost Origin) ⇒ pass; curl shape (Host only, no Origin, POST) ⇒ pass; SSE path covered.
- **GREEN:** implement; verify the real UI + scripts still work (vite dev client fetches `127.0.0.1:8911` directly, `register-brain-server-task.ps1`/health probes curl `127.0.0.1` — all carry passing Hosts).
- **REFUTE (recommended-mandatory):** not literally the two doctrine categories, but this is the security gate in front of the same confidential data the confidential-bake gate protects — hold it to the same bar. Lenses: Host-header parse edge cases (trailing dot, whitespace, absolute-URI request line, duplicate Host headers — verify Hono/node's normalization), middleware ordering vs. route registration, `Sec-Fetch-Site` as a considered-and-rejected alternative, and whether any legitimate consumer sends a non-localhost Host (search scripts/ for API callers).

### 5. Risk / rollback
One middleware, additive, fail-closed. Worst regression: a legitimate local client with an unexpected Host string gets 403 — loud, immediately visible in the dashboard, and diagnosable from the 403 body. Rollback = remove one `app.use` line + delete the module. **Note:** `server/index.ts` is Architect-owned (CLAUDE.md §4 + architect-owned.json line 10) — STATUS.json protocol applies; keeping the logic in the new non-owned `host-policy.ts` minimizes the owned-file diff to ~2 lines.

### 6. Overlap & sequencing
No overlap with checkSnapshot files or PR #248's script. **Independent — can go anytime; recommend soonest, it is the only finding with live, continuous exposure while the server runs.**

---

## OI-051 — Confidential-bake deploy publishes before gate check, no rollback, single-destination probe

### 1. Current-code verification
The script changed materially since the sweep (PRs #248 + #249, both **merged**); the finding's line numbers have drifted but **both substantive gaps remain**:
- Ordering unchanged: `MIRROR_INCLUDE_CONFIDENTIAL='1'` now at **:203** (was :112), the bounded wrangler deploy at **:220–223** (was :120), gate probe still only **after** deploy — normal path at **:249**, plus a new timeout-path probe at :230 (that part of the finding's exposure math improved: PR #248's `Invoke-AccessGateProbe`, :91–138, now also runs when the deploy times out).
- **No pre-deploy probe** and **no rollback**: on `GATE CHECK FAILED` the catch block (:279–305) stamps the beacon, sends the CRITICAL alert, and rethrows — the confidential deployment remains live.
- **Single destination**: `$VerifyUrl = 'https://ora-command-center.pages.dev/'` (:37) is the only probed URL; `brain.oxfordra.net` (confirmed as the second Access destination in `README.md` and `docs/superpowers/specs/2026-06-15-eric-live-command-center-access-design.md`) is never probed.
- Registration detail (verified): `register-mirror-task.ps1:32` invokes the script **with no arguments** — parameter defaults can change without task re-registration.

### 2. Root cause
The gate check was designed as a post-hoc *verification* of a deploy already made, not as a *precondition* for publishing confidential data — so a pre-existing Access misconfiguration is discovered only after exposure begins, and the failure path was built to alert, never to remediate.

### 3. Proposed fix (build directly on merged PR #248 structure)
1. **Extract to `scripts/lib/access-gate.ps1`**: move `Invoke-AccessGateProbe` out of the main script into the lib (the same drift-prevention rationale PR #248 recorded at :84–90), add `Invoke-AccessGateProbeAll` (loop over a URL list; `Verified` only if **every** destination 302s to `$AccessHost`; return per-URL results), and new `Invoke-MirrorLockdown` (below). Give the probe/lockdown functions injectable invoker scriptblock parameters (the `fake-mailer.smoke-test.ps1` seam pattern) so smoke tests never hit the network.
2. **Multi-destination**: replace `$VerifyUrl` with `[string[]]$VerifyUrls = @('https://ora-command-center.pages.dev/', 'https://brain.oxfordra.net/')`. Safe — the scheduled task passes no args.
3. **Pre-deploy gate check (new step, before :203)**: probe **all** `$VerifyUrls` against the *currently live* deployment **before** `MIRROR_INCLUDE_CONFIDENTIAL` is set or anything builds. Fail **closed**: any 2xx ⇒ throw `GATE CHECK FAILED (PRE-DEPLOY)` (CRITICAL, matches the existing `^GATE CHECK FAILED` severity regex at :298); inconclusive ⇒ throw a non-critical `GATE CHECK INCONCLUSIVE (PRE-DEPLOY)` and skip the run — a stale mirror is always preferable to publishing behind an unverified gate. This collapses the "Access already broken" exposure window from ~35s+forever to zero.
4. **Rollback on post-deploy failure**: `Invoke-MirrorLockdown` — generate a two-file placeholder in `$env:TEMP` (`index.html` "mirror disabled pending security review" + `_redirects` `/* /index.html 200` so every path serves the placeholder), deploy it with the same bounded `Invoke-NativeCommandWithTimeout` wrangler call. Invoke it from **both** post-deploy 2xx branches (normal :251, timeout :231). The thrown `GATE CHECK FAILED` message must append the lockdown outcome (`lockdown deployed` / `LOCKDOWN ALSO FAILED: <reason>`); a lockdown failure must never mask the original gate failure. Document the residual: edge-cached hashed assets may survive the rollback briefly — note an optional Cloudflare cache-purge API call as a follow-up if the wrangler token has zone-purge scope (do not block this fix on it).
5. Timeout-path parity: the :224–235 branch uses the same multi-URL probe and the same lockdown-on-2xx.

### 4. Test plan (this repo's PowerShell testing convention is standalone smoke tests, not Pester — reuse it)
- **RED:** new `scripts/access-gate.smoke-test.ps1` modeled on `deploy-mirror.smoke-test.ps1` / `native-command-timeout.smoke-test.ps1` (dot-source the lib, `Assert-True` helpers, exit 0/1). Scenarios written first, failing against the not-yet-written lib: (a) pre-deploy 2xx ⇒ probe result triggers abort *before* any deploy invoker call is logged; (b) first URL 302-to-Access + second URL 200 ⇒ NOT verified (the custom-domain-scoped-policy case from the finding); (c) post-deploy 2xx ⇒ lockdown invoker called exactly once with the placeholder dir; (d) lockdown throw ⇒ composite failure message contains both the original `GATE CHECK FAILED` text and the lockdown failure; (e) inconclusive (curl exit ≠ 0) ⇒ non-critical wording, no lockdown; (f) all-302 ⇒ verified, zero lockdown calls.
- **GREEN:** implement lib + rewire `deploy-mirror.ps1`; run the full existing smoke-test family (`deploy-mirror`, `deploy-beacon`, `native-command-timeout`, `git-fetch-capture`, `cmd-arg-guard`) to prove no regression, plus one supervised manual live run.
- **REFUTE (MANDATORY — this is the confidential-bake Access-gate check, named explicitly in the doctrine):** lenses: TOCTOU between pre-check and deploy (accepted residual — post-check+rollback covers it; make the refuter say so explicitly); lockdown deploying to the wrong project/branch; `_redirects` not actually shadowing hashed asset paths; probe following an unexpected redirect chain (`--max-redirs 0` already guards this — verify preserved); severity-regex drift (`^GATE CHECK FAILED` must still match the new pre-deploy wording); PT30M time budget (added probes ≈ 95s × 2 checkpoints × 2 URLs worst case — still well inside; make the refuter do the arithmetic against `$DeployTimeoutSeconds` max 1200).

### 5. Risk / rollback
Main risk: pre-deploy fail-closed means a Cloudflare edge blip now skips a deploy (stale mirror + non-critical alert) — deliberate trade, and `Test-OfflineSignature` suppression already handles alert fatigue for transient shapes. Lockdown wipes the mirror until the next clean run — intended behavior for a suspected exposure. Code rollback = revert the PR; the deploy pipeline returns to today's (merged #248/#249) behavior, no data migration involved.

### 6. Overlap & sequencing
- **PR #248: already merged** — the tracker's "NOT yet merged" is stale. Build on its `Invoke-AccessGateProbe` now; the extraction to `lib/access-gate.ps1` is the natural continuation of its own stated drift-prevention rationale. The `occ-wt-deploy-timeout` worktree / `fix/deploy-mirror-deploy-timeout` branch are now stale post-merge (branch still present locally, checked out in that worktree) — flag for cleanup, out of scope here.
- **No overlap** with the checkSnapshot worktree (different files entirely).
- **Sequencing: fix now, independent.** Suggested overall order: OI-050 and OI-051 first (both reduce live exposure), OI-049 anytime; three separate PRs, each with its own REFUTE record.

---

## Critical files for implementation
- `scripts/check-refute-required.ts` (OI-049: line-68 `.json` exclusion, new glob + version-bump check)
- `scripts/governance-check.ts` (OI-049: new `checkRatifiedConfigIntegrity`; Architect-owned)
- `server/index.ts` (OI-050: mount `localOnlyGuard()` before line 52; Architect-owned)
- `server/cors-policy.ts` (OI-050: pattern template + `isAllowedOrigin` reuse for the new `server/host-policy.ts`)
- `scripts/deploy-mirror.ps1` (OI-051: pre-deploy probe, multi-URL, lockdown; probe extraction to `scripts/lib/access-gate.ps1`)
