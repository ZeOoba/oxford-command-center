# Eric Live Phase 2 — Tunnel + Cold-Standby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. TDD throughout (test first, watched to fail).

**Spec:** `docs/superpowers/specs/2026-06-15-eric-live-command-center-access-design.md` (Phase 2 + Phase 3)
**Status:** plan — not started. Supersedes the spec's Phase 2 sketch on one architectural point (§1).
**Goal:** Give Eric (`egoldberg@oxfordra.net`) genuinely-live command-center data plus Calibration **writes**, from any computer, without his access dying when Gabriel's laptop sleeps.

## Rulings carried in (Gabriel, 2026-08-16)

| Decision | Ruling | Consequence |
|---|---|---|
| Host | **LAPTOP-CSHSCBE6, with Phase 3 cold-standby in scope** | Sleep/reboot must degrade Eric to an honest baked view, never a spinner or an edge error page |
| DNS | **`*.cfargotunnel.com` fallback** | **No `oxfordra.net` record changes.** Invariant-2 exposure removed; NS stays on NS1 |
| Spec D3 (remote Calibration writes) | Implied **yes** by choosing Phase 2 | Write path must be authz'd, not just read |
| Spec D4 (PFI freshness) | Assumed **daily** `warehouse.json` bake | Standby payload cadence; revisit if Eric wants closer to real-time |
| Spec D5 (Zero-Trust console) | Gabriel-only manual step | Adding the tunnel hostname as an Access destination is not automatable here |

---

## 1. Architecture change: Phase 3 is not additive to Phase 2

The spec treats Phase 2 (tunnel with a Hono `serveStatic` route) and Phase 3 (cold-standby) as sequential. **They are not.** Building Phase 2 as specced and then adding Phase 3 requires tearing out the serveStatic entry point.

Why: if Eric's bookmark is the tunnel hostname and the laptop is asleep, `cloudflared` is down and **Cloudflare returns an error page before any of our code runs**. There is no client loaded, so there is nothing to fall back *from*. Client-side standby is structurally impossible when the tunnel is the entry point.

**Therefore the entry point must stay the always-up Pages mirror**, and failover must happen at the edge:

```
Eric ──> brain.oxfordra.net  (Cloudflare Pages, Access-gated, always up)
             │
             ├── SPA + baked snapshot.json / macro.json / warehouse.json   [always available]
             │
             └── /api/warehouse/*  ──> Pages Function proxy
                                          │
                                          ├─ tunnel reachable ──> https://<tunnel>.cfargotunnel.com ──> 127.0.0.1:8911  [LIVE]
                                          └─ tunnel down/timeout ──> baked warehouse.json payload    [STANDBY, honest badge]
```

This shape is strictly better than the spec's:

- **No CORS problem.** The proxy fetch is server-side at the edge; the browser only ever talks to `brain.oxfordra.net`. `server/cors-policy.ts` stays localhost-only and **unrelaxed** — same guarantee the spec's same-origin trick was buying, without the tunnel needing to serve the SPA.
- **Reuses the existing Access gate** on `brain.oxfordra.net`. No second Access app, no second hostname for Eric to learn, no bookmark change.
- **Failover is automatic and invisible**, and degrades to the honest "baked _N_h ago" badge Phase 1b already built.
- **`serveStatic` becomes optional.** Keep it out of scope; the tunnel serves `/api/*` only.

**Consequence for Phase 1b:** cold-standby *requires* a baked `warehouse.json` as the standby payload. Phase 1b is code-complete (`scripts/bake-warehouse.ts`, `src/lib/warehouse-mirror.ts`, `src/modules/intel/hooks.ts`) but **nothing ever bakes the file** — no scheduled task and no `deploy-mirror.ps1` invocation passes `--warehouse`/`BAKE_WAREHOUSE=1`. **W0 below closes that gap and is a hard prerequisite for W5.**

---

## Constraints / Guardrails (hard)

- **No `oxfordra.net` DNS changes.** Per ruling. Any step that would touch an NS1 record is out of scope and must stop and ask.
- **Invariant 2:** do NOT deploy the mirror. Open a PR; Gabriel deploys per-deploy.
- **Invariant 4:** governor constants (DSCR 1.25 / LTV 40 / 65) untouched.
- **Authz before exposure.** No tunnel hostname is added as an Access destination until W2 is merged and its REFUTE pass is green. Exposing `/api/warehouse/*` without app-level authz would put full firm financials behind a single Cloudflare config toggle.
- **Server stays bound to `127.0.0.1`.** `cloudflared` dials out; there is never a reason to bind `0.0.0.0`. Any diff that widens the bind is a REFUTE failure.
- **Localhost dev must not regress.** Gabriel's `npm run dev` has no Access headers. Authz is opt-in by env and fail-closed only when enabled.
- **Never label standby data "Live."** Reuse Phase 1b's badge + fail-closed schema-version stamp.
- **Financial/security-gate code ⇒ mandatory adversarial REFUTE pass** (done bar), reviewer model ≥ implementer, never below Fable.
- **Shared checkout:** all work in the `eric-live-phase2` worktree. `main` has another session's uncommitted WIP (`architecture/coding-standards.md`, `scripts/install-git-hooks.mjs`, plus 2 untracked) — do not touch it.

---

## Workstreams

### W0 — Bake `warehouse.json` into the deploy *(prerequisite for W5)*

Phase 1b's standby payload is never produced. Without it, cold-standby has nothing to fall back to.

- [ ] Confirm `tsx scripts/bake-mirror.ts --warehouse` writes `public/warehouse.json` against a **fixture/tmp `WAREHOUSE_DB`** — never the live DB.
- [ ] Add a **daily** warehouse bake, decoupled from the hourly snapshot bake (the backfill is RAM/IO-heavy and contends with the live server's WAL lock — spec §2.2). Chain: `warehouse:backfill && warehouse:drift && bake --warehouse`.
- [ ] Register via `register-scheduled-task` doctrine — **not** by splicing registry JSON. Check `_state/registry-membership.log` for concurrent session activity first.
- [ ] Verify the deployed mirror actually carries `warehouse.json` (Access-gated, so verify post-deploy with an authenticated fetch, not `curl`).

### W1 — Static serving on the tunnel *(DESCOPED)*

Not needed under §1's architecture. Documented here so a future reader does not "restore" it from the spec. Revisit only if Eric is ever pointed at the tunnel hostname directly.

### W2 — App-level authz on `/api/*` *(security-critical; blocks all exposure)*

Today the local server asserts **nothing**. `Cf-Access-Authenticated-User-Email` is read only in `functions/api/whoami.ts` (a Pages Function). Loopback binding is the only thing protecting the warehouse.

- [ ] Test-first: request with no Access assertion + `REQUIRE_ACCESS=1` ⇒ **403**, and the handler never runs.
- [ ] Test-first: request with a valid assertion for an allowlisted email ⇒ passes through.
- [ ] Test-first: valid assertion, **non**-allowlisted email ⇒ 403.
- [ ] Test-first: `REQUIRE_ACCESS` unset (Gabriel's localhost dev) ⇒ unchanged behavior, no header required.
- [ ] **Verify the `Cf-Access-Jwt-Assertion` JWT signature** against the Access public keys — do **not** trust the bare `Cf-Access-Authenticated-User-Email` header. The header is trivially forgeable by anything that reaches the origin; loopback binding makes that hard today but it is defense-in-depth, and the whole point of this workstream is to stop relying on network position alone. Cache the JWKS with a TTL; **fail closed** if the keys cannot be fetched.
- [ ] Allowlist `ggoldberg@`/`egoldberg@` from config, not hardcoded.
- [ ] Mount as Hono middleware on `/api/*` **before** the route mounts at `server/index.ts:65-74`.
- [ ] **Mandatory adversarial REFUTE pass** on this diff before merge.

### W3 — Tunnel provisioning

Note: `scripts/cloudflared-config.yml`, referenced by the spec, **no longer exists** in the repo, and `cloudflared` is **not installed** on this machine. Both are greenfield.

- [ ] Install `cloudflared`; pin and record the version.
- [ ] Create the named tunnel; store credentials outside the repo (never commit; `~/.claude` backup scrubs deal terms but this is a credential — keep it out entirely).
- [ ] Config: ingress `<tunnel>.cfargotunnel.com` → `http://127.0.0.1:8911`, catch-all 404.
- [ ] Recreate a committed `scripts/cloudflared-config.yml` **template** (no credentials) so the next reader is not chasing a dead spec reference.
- [ ] **Gabriel (Zero-Trust console):** add the `*.cfargotunnel.com` hostname as a destination on the existing `ORA principals` Access app, allow `ggoldberg@`/`egoldberg@`, default-deny. Verify unauth ⇒ `302` → `spring-wood-ade4.cloudflareaccess.com`.

### W4 — Survive the laptop lifecycle

The host sleeps, reboots, and takes Windows Updates. This is the same lifecycle that already causes the AM-cluster late wakes (WU reboots killed the app ~33min pre-slot; no launch-at-logon entry).

- [ ] Run the Brain Server as a Windows service (or a boot-triggered task with restart-on-failure) — **not** dependent on the Claude Desktop app being open.
- [ ] Run `cloudflared` as a Windows service, started before/independently of the server.
- [ ] Scheduled 302 probe against the tunnel hostname; alert on transition to unreachable.
- [ ] Confirm the OneDrive client runs on the host so the workbook file-watch stays live.
- [ ] Explicitly out of scope: preventing sleep. W5 is the answer to sleep, not a power policy.

### W5 — Cold-standby edge proxy *(the Phase 3 payload, per §1)*

- [ ] New Pages Function `functions/api/warehouse/[[path]].ts` proxying to the tunnel origin.
- [ ] Test-first: tunnel 200 ⇒ live payload passthrough, `X-ORA-Source: live`.
- [ ] Test-first: tunnel timeout/5xx/DNS failure ⇒ baked `warehouse.json` payload for that exact request path, `X-ORA-Source: standby`.
- [ ] Test-first: path with no baked payload and tunnel down ⇒ **fail-closed** (offline), never a stale or partial guess.
- [ ] Short timeout (~2–3s) — a sleeping laptop must not hang Eric's page for 30s.
- [ ] Forward the Access identity to the origin so W2 can authorize the real user, not the proxy.
- [ ] **Writes (Calibration resolve) must NOT fall back.** Tunnel down ⇒ explicit "writes unavailable — workstation offline," never a silent success. Test this.
- [ ] Surface `X-ORA-Source` in the existing Phase 1b freshness badge: live vs. "baked _N_h ago."

---

## Verification (done bar)

- [ ] `npm run gate` green in the worktree.
- [ ] REFUTE pass green on W2 and on W5's write-path behavior.
- [ ] **Adversarial exposure check:** with `REQUIRE_ACCESS=1`, confirm an unauthenticated request to every `/api/warehouse/*` route mounted at `server/index.ts:65-74` returns 403 — enumerate the routes, do not spot-check.
- [ ] Confirm the client import tree still never transitively pulls `better-sqlite3`.
- [ ] End-to-end: Eric-equivalent identity loads `brain.oxfordra.net`, sees live PFI; laptop sleeps; page degrades to the honest baked badge within one timeout; laptop wakes; live returns without a reload loop.
- [ ] Evidence before claim — no "it works" without the command output.

## Open items for Gabriel

1. **D4 cadence** — daily `warehouse.json` assumed. If Eric wants PFI fresher than daily *while the laptop is asleep*, that is a bake-cadence change, not a tunnel change.
2. **Credential custody** for the tunnel — where the tunnel credentials live, given `~/.claude` backs up to a private repo.
3. **W3's Access-destination step is yours** (Zero-Trust console); everything else is buildable here.
