# Mirror Deploy Scheduled Task Registration + First-Run Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the "ORA Command Center - Mirror Deploy" Windows scheduled task (currently missing entirely) so the `https://ora-command-center.pages.dev` mirror auto-refreshes hourly instead of sitting stale (last manual deploy before 2026-07-08 was 2 weeks old), then verify its first automated run actually succeeds end-to-end — including the coupled daily-brief email side effect, which has not fired since 2026-06-20 and will very likely fire for real on the first successful run.

**Architecture:** No new code — this is operational registration of an already-written script (`scripts/register-mirror-task.ps1`) plus verification. Zero source files change. The only "implementation" risk is sequencing: this must not run until the sibling `WORKBOOK_PATH dual-library mismatch` plan (`docs/superpowers/plans/2026-07-08-workbook-path-dual-library-and-env-loading-fix-plan.md`) has landed, or the very first automated run repeats the exact ENOENT failure that made this mirror stale in the first place.

**Tech Stack:** Windows Task Scheduler (via PowerShell `Register-ScheduledTask`), the repo's existing `scripts/deploy-mirror.ps1` / `scripts/bake-mirror.ts` / `server/brief/run.ts`.

## Global Constraints

- **Hard dependency on the sibling plan.** `register-mirror-task.ps1`'s own docstring says: "Run this ONCE ... after confirming `wrangler` is authenticated and `npm run gate` is green." `npm run gate` chains `reconcile` / `warehouse:verify` / `warehouse:drift`, which the sibling plan's Task 2 fixes (three scripts never call `loadEnvFile()`). Do not skip the pre-check in Task 1 Step 1.
- **The registered task ALWAYS includes confidential deals.** `deploy-mirror.ps1` unconditionally sets `MIRROR_INCLUDE_CONFIDENTIAL=1` (verified 2026-07-08 by reading the script) — this is intentional per its own comment ("ONLY because the deploy target is verified behind Cloudflare Access") and matches `README.md`'s documented "full operating picture" mode. This is DIFFERENT from a bare `npm run deploy:mirror` (which redacts by default) — a manual redacted-mode deploy done earlier today (2026-07-08) will be superseded by this task's first run, which is correct and expected, not a regression.
- **The registered task ALSO sends a real daily-brief email as a side effect**, via `BRIEF_ENABLED=1` + `BRIEF_SEND_SCRIPT` → the shared Outlook COM sender. Verified 2026-07-08: `data/alert-state.json` shows `"lastBriefDate": "2026-06-20"` — over two weeks dormant — and `shouldSendBrief()` fires whenever ET time-of-day is past 06:45 AND `lastBriefDate` isn't today. Since it's already past 06:45 ET most days this task will run, **the first successful automated run (or any manual run of `deploy-mirror.ps1`) will almost certainly send a real "catch-up" brief email** to `ggoldberg@oxfordra.net` (cc `egoldberg@oxfordra.net` per the Daily Brief routing exception). This is pre-authorized per the routing canon (both are internal principals, and this is the system's designed automated-send path) — but it's a real, externally-visible action, so Task 2 below treats it as an explicit flag point rather than something to trigger silently or repeatedly while testing.
- **Never manually force-trigger this task more than once.** Because of the brief side effect above, do not `Start-ScheduledTask` repeatedly "just to check it works" — one confirmed run (whether the natural hourly trigger or one deliberate manual start) is enough evidence; repeated manual runs risk repeated brief sends once `lastBriefDate` no longer gates same-day reruns... actually it does gate same-day reruns (`state.lastBriefDate !== now.date`), so a second run *today* will NOT re-send the brief — but still avoid unnecessary manual runs since the bake+deploy+Access-verify cycle is real work, not free.
- No changes to `server/warehouse/capital-allocation.ts` or any financial-calculation/governor logic — out of scope, not touched by anything in this plan.

---

### Task 1: Confirm the sibling fix has landed, then register the scheduled task

**Files:**
- No files created or modified by this task — verification + one `Register-ScheduledTask` call via the existing `scripts/register-mirror-task.ps1`.

**Interfaces:**
- Consumes: `scripts/register-mirror-task.ps1` (no parameters needed — `-TaskName` defaults to `'ORA Command Center - Mirror Deploy'`), which in turn wraps `scripts/deploy-mirror.ps1`.
- Produces: a registered Windows scheduled task with two triggers — hourly all day (`-Once -At 12:00am -RepetitionInterval 1hr -RepetitionDuration 3650 days`) and a guaranteed daily 06:45 AM trigger — both running `deploy-mirror.ps1`.

- [ ] **Step 1: Confirm the sibling `WORKBOOK_PATH` fix has actually landed — do not proceed if not**

Run:
```bash
cd "C:/Users/Owner/oxford-command-center"
grep -n "export function workbookPath" server/config.ts
```
Expected: a match. If this returns nothing, `server/config.ts` still has the old eager `export const WORKBOOK_PATH = ...` — **STOP**, the sibling plan (`docs/superpowers/plans/2026-07-08-workbook-path-dual-library-and-env-loading-fix-plan.md`, currently being executed in session `local_abdab7e0-99ba-4216-8677-f2b154d3bf91`, "WORKBOOK_PATH dual-library mismatch") has not landed yet. Coordinate with that session (or re-check later) rather than registering a task whose first run will just fail on the same bug it's meant to fix.

- [ ] **Step 2: Confirm `npm run gate` is green**

Run: `cd "C:/Users/Owner/oxford-command-center" && npm run gate`
Expected: all steps pass (governance, typecheck, lint, test, reconcile, warehouse:verify, warehouse:drift). If anything fails, stop and investigate — do not register the task against a red gate.

- [ ] **Step 3: Confirm `.env` now has the corrected paths (belt-and-suspenders — Step 1/2 should already guarantee this, but the task depends on `.env`, not on any inline env var)**

```bash
grep -E "^(WORKBOOK_PATH|DOCUMENTS_DIR|QUICKBOOKS_CSV)=" .env
```
Expected: all show the no-`(1)`-suffix OneDrive library path. Do NOT print the full `.env` file (it holds live secrets) — this targeted `grep` is fine since none of these three lines contain a secret.

- [ ] **Step 4: Confirm `wrangler` is authenticated**

Run: `npx wrangler whoami`
Expected: shows an authenticated account (not a login prompt). It was authenticated as of 2026-07-08 (used earlier today for the manual deploy) — this step just re-confirms nothing expired.

- [ ] **Step 5: Confirm no task of this name already exists (avoid a surprise overwrite)**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'ORA Command Center - Mirror Deploy' -ErrorAction SilentlyContinue | Select-Object TaskName,State"`
Expected (verified 2026-07-08): empty — no task exists yet. If one now exists, inspect it first (`Get-ScheduledTaskInfo`) before re-registering — `Register-ScheduledTask -Force` silently overwrites.

- [ ] **Step 6: Register the task**

Run: `pwsh -File scripts/register-mirror-task.ps1`
Expected output: `Registered 'ORA Command Center - Mirror Deploy': hourly bake + 06:45 ET brief trigger -> C:\Users\Owner\oxford-command-center\scripts\deploy-mirror.ps1`

- [ ] **Step 7: Verify registration**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'ORA Command Center - Mirror Deploy' | Get-ScheduledTaskInfo | Select-Object NextRunTime,LastRunTime,LastTaskResult"`
Expected: `NextRunTime` shows a timestamp within the next hour (the hourly trigger). `LastRunTime`/`LastTaskResult` will be empty/0 until it actually fires — that's expected at this point, not a failure.

- [ ] **Step 8: No commit needed** — this task creates OS-level scheduler state, not a git change. Confirm the repo is still clean:
```bash
git status --short
```
Expected: no unexpected changes (this task doesn't touch tracked files).

---

### Task 2: Verify the first automated run, with the brief-email side effect flagged explicitly

**Files:** none — verification only.

- [ ] **Step 1: Wait for the natural hourly trigger rather than force-starting it**

The task's hourly trigger means the next run happens within 60 minutes of Task 1 completing — prefer letting it fire naturally over `Start-ScheduledTask` (see Global Constraints: avoid unnecessary manual runs). Note the expected `NextRunTime` from Task 1 Step 7 and check back after that time.

If verifying sooner is genuinely necessary, `Start-ScheduledTask -TaskName 'ORA Command Center - Mirror Deploy'` is safe to run **once** — but per Global Constraints, this will very likely send a real catch-up brief email to `ggoldberg@oxfordra.net` (cc `egoldberg@oxfordra.net`) since `lastBriefDate` is `2026-06-20`. **Flag this to Gabriel before manually forcing it** — it's pre-authorized (internal recipients, designed automated-send path) but he should not be surprised by an unplanned email landing.

- [ ] **Step 2: Confirm the task actually ran and succeeded**

Run: `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'ORA Command Center - Mirror Deploy' | Get-ScheduledTaskInfo | Select-Object LastRunTime,LastTaskResult"`
Expected: `LastRunTime` is recent, `LastTaskResult` is `0` (success). A non-zero result means `deploy-mirror.ps1` threw — check `logs/` (per README's mention of gitignored logs) or re-run it manually once with output captured to diagnose (`pwsh -File scripts/deploy-mirror.ps1` directly, accepting the brief-email caveat above since it will be the same run either way).

- [ ] **Step 3: Confirm a new Cloudflare Pages deployment landed**

Run: `npx wrangler pages deployment list --project-name=ora-command-center`
Expected: the top row's timestamp is recent (within the last hour or two), superseding the 2026-07-08 manual deploy from earlier today.

- [ ] **Step 4: Confirm the Access gate is still enforcing on the new deployment**

Run:
```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" -I https://ora-command-center.pages.dev
```
Expected: `302` redirecting to a `cloudflareaccess.com` URL — never a bare `200`. `deploy-mirror.ps1` already asserts this itself and throws loudly if it fails, so a `LastTaskResult` of `0` in Step 2 is strong evidence this already passed — this step is an independent double-check, not redundant paranoia, since it's confirming the *live* current state rather than trusting the last run's exit code alone.

- [ ] **Step 5: Confirm the bake is now in FULL (confidential-included) mode, matching the registered task's intent**

The static site itself has no server-side way to check this from outside without Access credentials. Instead, confirm from the task's own log output — check `Get-ScheduledTaskInfo`'s result was `0` (already done in Step 2) and, if deeper confirmation is wanted, re-run `pwsh -File scripts/deploy-mirror.ps1` once manually and check its stdout for `Mode: FULL (confidential included — Access-gated targets only)` (accepting the Step 1 brief-email caveat, since this is the same trigger point).

- [ ] **Step 6: Confirm the brief-email side effect resolved as expected**

Run: `cat data/brief-health.json` (or `Get-Content` on Windows)
Expected: `"ranAt"` is recent, `"briefSent"` is `true` (the first run) or `false` with a subsequent run the same day (already sent, correctly gated). Cross-check with Gabriel that the email actually arrived if `briefSent: true` — this is the one step in this plan with a real external-facing effect, so don't just trust the JSON file; confirm the human-visible outcome too.

- [ ] **Step 7: No commit** — nothing in this task changes tracked files. Final confirmation:
```bash
git status --short
```
Expected: clean.
