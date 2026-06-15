# Remote LIVE Command-Center access for a principal (Eric) — design

**Spec ID:** `docs/superpowers/specs/2026-06-15-eric-live-command-center-access-design.md`
**Surface:** `oxford-command-center` (React + Hono + better-sqlite3 warehouse + Cloudflare Pages mirror)
**Status:** design — Phase 1a implemented (acquisition edge Function); 1b/2/3 planned
**Constraint relaxed (2026-06-15, Gabriel):** confidentiality is **not** a constraint here — full firm data on the Access-gated surface is acceptable. The hard requirement is **LIVE** data + the three server-only modules.

---

## 0. Goal

Eric (`egoldberg@oxfordra.net`) needs remote access to the command center with **live data** AND the three modules that are offline on today's static mirror: **Acquisition scoring**, **Property Financial Intelligence (PFI)**, **Calibration Log**. Today `brain.oxfordra.net` → an Access-gated Cloudflare Pages **static mirror** (baked `snapshot.json` + `macro.json`, refreshed ~hourly); the live server only runs on Gabriel's machine.

## 1. The load-bearing fact: the three modules differ in portability (verified against code)

| Module | Data source | Nature | Portability |
|---|---|---|---|
| **Acquisition scoring** | flat-file configs (`config/acquisition-ruleset.v1.json` + `replacement-cost.v1.json`); route sits **outside** the warehouse `withDb` guard | **Pure** `scoreAcquisition(input, ruleset, {rct})` — zero DB | **Fully edge/client-portable** (~1 day). Only the `node:fs` loaders are server-only. |
| **PFI** | the better-sqlite3 warehouse (`/api/warehouse/*` behind `withDb`) | Deterministic math, but inputs **are** the SQL read (`propertyPeriodMetrics(db)`) | Portable only if you **pre-materialize** the rows and ship them as JSON. Engine modules (`scores/metrics/queries/...`) have **zero `better-sqlite3`/`node:` imports** (verified) → portable once fed materialized rows. |
| **Calibration** | warehouse, read **and write** (`calibration_verdict/outcome/inputs_version`) | Stateful append-only log | **Not portable** — needs a live read-write server. |

## 2. Error-check corrections to the multi-agent design (what it got wrong)

1. **The current mirror bakes NO warehouse data.** `bake-mirror.ts` emits only `snapshot.json` (workbook) + `macro.json`. So "fix the warehouse-freshness gap on the existing mirror" is misframed — there's nothing warehouse to keep fresh there (that's *why* PFI/Calibration are offline). Warehouse-backfill chaining only matters once Phase 1b bakes `warehouse.json`. **The workflow's P1 and P2 collapse into one phase.**
2. **Do not run `warehouse:backfill` hourly.** The P&L files update ~monthly and the backfill is RAM/IO-heavy and contends with the live server's WAL lock. **Decouple cadences:** workbook snapshot stays hourly (light); `warehouse.json` bakes daily/on-backfill (heavy, infrequent).
3. **WAL/live-server contention.** If the live server runs, reading the warehouse file to bake misses its uncommitted WAL writes (the WAL is larger than the committed DB). **Bake `warehouse.json` by querying the live server's `/api/warehouse/*` when it's up, else force a checkpoint then read.**

Confirmed true (plan stands): engine modules import-pure; acquisition route DB-free + configs present; `functions/api/` already hosts Pages Functions (`ai.ts`/`whoami.ts`); **no `serveStatic` route exists** (Phase 2 must build it); the hourly Mirror task is registered + healthy (last run result 0).

## 3. Corrected phased plan

- **Phase 0 (trivial):** dead-man heartbeat on the existing hourly Mirror task — it's healthy, but make silent failure visible (the surface goes stale unnoticed if a bake fails). *Not in this PR — touches the scheduler; needs supervision.*
- **Phase 1a (THIS PR): Acquisition scoring on the mirror.** A Pages Function at `functions/api/warehouse/acquisition/score.ts` that bundles the ratified config JSON, asserts the fail-closed gate at module init, and calls `scoreAcquisition` **verbatim** (no engine change). Gives Eric a working Acquisition Workbench on the mirror (prefill from baked `snapshot.json`, score via the Function). **Deploy step (Gabriel): enable `nodejs_compat`** on the Pages project (dashboard → Settings → Functions → Compatibility flags) — `acquisition.ts` imports `node:crypto`/`node:fs` at module top; verify with `wrangler pages dev` before relying on it.
- **Phase 1b (this week): Fat Mirror for PFI + Calibration-read.** Extend `bake-mirror.ts` to emit `public/warehouse.json` (materialized `PeriodMetrics[]`, `property_master`, `lease_terms`, calibration read tables), querying the live server when up else a checkpointed read. Refactor the pure engines to take materialized rows (e.g. a `nameById` Map instead of a `db` handle) + a client engine entrypoint; wire `analytics-hooks` to fall back to `/warehouse.json` when `/api/warehouse/*` 404s (mirrors the existing snapshot fallback). **Honest freshness:** per-spine "Computed from snapshot baked _N_h ago" badge + a schema-version stamp on `warehouse.json` that **fail-closes** the client engine on mismatch — never label a bake "Live". Guardrails: a deterministic client==server deep-equal test on fixtures, the **mandatory adversarial REFUTE review** on any scoring-math touch, and verify the client import tree never transitively pulls `better-sqlite3`. **Calibration-resolve + lease-run-assumption WRITES stay workstation-only** (say so in the UI).
- **Phase 2 (gated on the NEW machine): tunnel-to-local-server = genuinely live + Calibration writes.** Build a Hono `serveStatic` route so the live server hosts SPA + `/api/*` on one origin (same-origin trick — sidesteps `cors-policy.ts` without relaxing it; does not exist today). Land **app-level authz on `/api/warehouse/*`** (assert `Cf-Access-Authenticated-User-Email`) before exposure. DNS migration to Cloudflare (or `cfargotunnel` fallback). Windows-service-ify node + cloudflared; scheduled 302 probe. Host on the new machine (resolves the 5.7 GB RAM ceiling + runs the OneDrive client for the file-watch).
- **Phase 3 (steady state):** demote the mirror to automatic **cold-standby** (so if the new machine sleeps, Eric degrades to an honest "baked _N_h ago" instead of a spinner). Keep `warehouse:drift` in every backfill. **Reject the D1/Turso port** unless the data origin leaves local OneDrive (it's a ~10x liveness regression + permanent dual-DB tax, and even after the port the OneDrive workbook is unreachable from the edge → still a snapshot).

## 4. Open decisions (gate Phases 1b–2; for Gabriel)

1. **DNS migration:** willing to move `brain.oxfordra.net` (or the apex) onto **Cloudflare DNS**? Hard prereq for the Phase-2 tunnel; touches `oxfordra.net` records (MX/mail risk, invariant-2-adjacent). Fallback: gate a raw `*.cfargotunnel.com` hostname.
2. **New machine:** when does it land, and is it a permanently-on **desktop** (ideal) or a laptop (sleep kills Eric's access)?
3. Does Eric actually need **Calibration *resolve* (the write)** remotely, or is read/recompute-only fine? If read-only is fine, the Fat Mirror suffices and Phase 2 becomes optional.
4. **PFI freshness** Eric needs — hourly, daily, or post-month-close? (Sets the Phase-1b `warehouse.json` cadence.)
5. Confirm **Cloudflare Zero-Trust + DNS console access** — the Access-destination + DNS edits + the `nodejs_compat` flag are manual steps only Gabriel can perform.

## 5. Rejected: full D1/edge port of the warehouse

Verified feasible (~2 weeks) but the wrong default — even after the port, the canonical OneDrive workbook + P&Ls are unreachable from `workerd` and `chokidar` can't watch on the edge, so the result is a snapshot, not live; and the calibration read-then-write transaction port to D1 `batch()` is a financial-correctness hazard. Take only the DB-free acquisition slice (Phase 1a); serve the warehouse via the Phase-2 tunnel.
