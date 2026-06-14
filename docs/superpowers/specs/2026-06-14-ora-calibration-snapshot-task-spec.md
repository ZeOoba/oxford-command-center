# ora-calibration-snapshot — scheduled task spec (AUTHORED, NOT REGISTERED)

**Spec ID:** `docs/superpowers/specs/2026-06-14-ora-calibration-snapshot-task-spec.md`
**Surface:** `C:\Users\Owner\oxford-command-center` (warehouse) + Cowork/LAMS scheduler
**Status:** authored — definition only; **registration is a separate supervised step Gabriel runs**
**Parent feature:** Score-vs-Outcome Calibration Log (`2026-06-13-calibration-log-design.md`, §2.2 trigger 2)
**Task definition:** `docs/scheduled-tasks/ora-calibration-snapshot/SKILL.md`

---

## 1. Why

The calibration log compounds over *time*, not cross-section (§6 of the design). A ~14-property firm
imports irregularly, so the on-commit emit hook alone leaves long gaps in the dated prediction stream —
and outcome scoring needs a steady stream of dated predictions to grade. A **quarterly** snapshot (plus a
fiscal year-end run) guarantees the cadence regardless of import activity. This is design-trigger #2 from
§2.2 ("On scheduled snapshot, `emitted_by = 'snapshot:<taskId>'`").

## 2. What it does (per run)

1. **Resolve** due outcomes — `resolveDueOutcomes(db)` — BEFORE logging new verdicts, so a just-due
   outcome is scored against the now-available same-grain period. Grain-disciplined; pending verdicts stay
   pending, never wrongly scored.
2. **Snapshot** — re-score the warehouse (`scoreProperties` + `detectAnomalies`) and `logVerdicts(...,
   'snapshot:ora-calibration-snapshot')` (idempotent via the `dedup_key` UNIQUE — a no-new-data quarter
   writes nothing new).
3. **Report + email** — read `GET /api/warehouse/calibration/report` (and `/pending`), compose the §4
   report as HTML, and send to **ggoldberg@oxfordra.net only** via the canonical
   `send-via-outlook.ps1` path.

## 3. Schedule

- Quarterly: **Jan/Apr/Jul/Oct 1st, 10:30 AM** (after `ora-quarterly-review` at 10:00).
- Plus a **fiscal year-end** run (Dec 31) — the annual report is the load-bearing artifact (§4.2) feeding
  the year-end review and any proposed-weight-change memo.

## 4. Hard boundaries (inherited from the feature's design invariants)

- **Observational only.** Writes the calibration tables; NEVER `intel-config.ts`, NEVER a health weight,
  NEVER the DSCR 1.25 / LTV 0.40 governors (not scores; out of scope).
- **Fail-open / fail-loud.** Empty/no-outcome data is the normal state → zeroed no-op report, still
  emailed. An email send failure retries once, then logs loudly and continues — never halts.
- **Routing canon.** Output to `ggoldberg@oxfordra.net` ONLY (no cc — this is not the ora-am-brief).

## 5. Registration (the supervised step — NOT done here)

Per the dual-fleet scheduler doctrine, this task is registered ONLY via the supervised
`create_scheduled_task` MCP on the target surface — JSON-splicing a registry file is prohibited. This PR
ships the DEFINITION (`SKILL.md` + this spec) only. To activate, Gabriel runs `create_scheduled_task` with
`TASK_ID=ora-calibration-snapshot` on his chosen fleet (LAMS/Cowork by default for a Cowork-style snapshot)
and the schedule in §3. Until then the task is inert.
