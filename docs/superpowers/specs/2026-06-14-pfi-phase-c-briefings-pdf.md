# Spec — PFI Phase C: Briefings + PDF Export

**Date:** 2026-06-14 · **Lane:** L3 feature (new behavior) · **Status:** ready to build
**Scope decision (Gabriel, 2026-06-14):** per-property + per-PM briefings, ORA-styled PDF with an
extractable text layer (Microsoft Print-to-PDF is prohibited per the ORA Style Guide).
**Owner files (new):** `server/briefing/compose.ts` (data → briefing model), `server/briefing/pdf.tsx`
(briefing model → PDF doc), `server/briefing/theme.ts` (ORA tokens + embedded fonts),
`src/contracts/briefing.ts` (Zod) + route wiring in `server/warehouse/api.ts`; UI export buttons in
`src/modules/intel/` (per-property Intelligence page + Managers tab).

## Problem / goal
The Intelligence module renders on-screen analysis but cannot produce a board-ready artifact. Gabriel
needs portable briefings — one per property and one per property manager — that he can hand to Eric/IC
or a PM. They must be ORA-branded, deterministic, and carry an extractable text layer (searchable,
not a flattened image).

## Briefing types (v1)
1. **Per-property briefing** (`/briefing/property/:propertyId.pdf`): the per-property Intelligence page
   as a 1–2 page PDF — verdict + health/attention/capital scores, KPI band (NOI, margin, $/SF, since-
   acquisition), NOI trend sparkline, top ΔNOI drivers, anomalies, rollover/lease-run summary (consume
   the Phase-4b `lease-run` engine if present; degrade gracefully if absent), benchmark percentile.
2. **Per-PM briefing** (`/briefing/manager/:managerId.pdf`): a PM's portfolio roll-up — managed
   properties table (health, NOI, attention flags), aggregate attention/capital items, the PM scorecard
   from the benchmarks engine, and a ranked action list.

(Ownership-level briefing is a trivial later addition reusing the same composer — out of scope v1.)

## Architecture
- **Data:** reuse the existing warehouse analytics outputs ONLY — no new data, no new queries beyond
  what the Intelligence pages already call. `compose.ts` maps analytics → a typed `BriefingModel`
  (Zod in `src/contracts/briefing.ts`); the model is the single input to the renderer (testable without
  rendering).
- **Rendering:** **`@react-pdf/renderer`** (server-side, no headless browser → CI-safe, deterministic,
  native extractable text layer, embeddable TTFs). Rationale over HTML→PDF (Playwright/puppeteer): no
  heavy browser dep, no flaky CI, no WAL-lock/dev-server interaction; full layout control. Charts render
  as lightweight vector primitives (sparklines/bars as `<Svg><Path>` from the analytics series) — no
  ECharts/canvas dep in the PDF path.
- **Fonts:** embed EB Garamond / DM Sans / IBM Plex Mono TTFs under `server/briefing/fonts/` and
  register with `Font.register` so the text layer is the brand typeface AND extractable. (If a TTF is
  unavailable, fall back to a registered open substitute and log — never silently swap to a non-brand
  default.)
- **Routes:** `GET /api/warehouse/briefing/property/:id.pdf` and `…/manager/:id.pdf` stream
  `application/pdf` with `Content-Disposition: attachment; filename="ORA_Briefing_<Subject>_<YYYYMMDD>.pdf"`.
  A JSON sibling `…/property/:id` returns the `BriefingModel` (Zod-parsed envelope, H6 read-boundary)
  so the UI can preview and tests can assert the model without bytes.
- **UI:** an "Export briefing (PDF)" button on the per-property Intelligence page and on each PM row in
  the Managers tab; calls the route, downloads the file. No new view, just the action.

## Branding / QC (ORA Style Guide v1.0)
Navy #1B2A4A (masthead/headers), Gold #C9A96E (rules/accents), Parchment #F5F3EF (panels). Masthead
"OXFORD REALTY ADVISORS", document title, "CONFIDENTIAL — INTERNAL" + workbook-source date + generated
date in the footer of every page. Every figure unit-labeled ($, $/SF, %). Run the 16-pt QC gate before
the route is considered done (branding, units, extractable text via `pdftotext` round-trip assertion,
no Print-to-PDF, version/date stamp, confidential marking).

## Behavior contract (must hold)
1. **Extractable text:** a test renders a briefing, runs the PDF through a text extractor, and asserts
   key figures (property name, NOI value, a score) appear as TEXT — guards against an accidental
   image/flattened regression.
2. **Determinism:** same `BriefingModel` → byte-stable PDF (no embedded timestamps except the explicit
   generated-date field, which is injected, not `Date.now()` inside the renderer) so it's snapshot-testable.
3. **Confidentiality:** the existing fulton/confidential-terms guard must pass; a briefing for a property
   tied to an active confidential deal must NOT embed confidential deal terms (these briefings are
   ownership-financial, not deal artifacts — assert no confidential term leaks into the model).
4. **Graceful degradation:** missing lease-run/benchmark/anomaly data renders an explicit "—"/"n/a"
   section, never a crash or a blank page.
5. Purely additive — governor constants, analytics engine, and overlay behavior untouched.

## Test plan (TDD, red→green)
`compose.ts` unit: analytics → BriefingModel for a property and a PM (KPIs, drivers, scorecard mapping;
empty/missing sections). Renderer: snapshot of the BriefingModel→PDF for a fixture; **extractable-text
assertion** (text extractor finds the expected figures); determinism (two renders identical).
Route: both `.pdf` stream `application/pdf` with the right filename; JSON sibling Zod-parses; 503 guard
when no DB. Confidentiality: model for a confidential-deal property carries no deal terms. Full
`npm run gate` green (incl. reconcile + warehouse:verify + warehouse:drift). RAM: gate at concurrency 1.

## Adversarial pass (MANDATORY — outward-facing financial artifact)
Reviewer told to REFUTE: a figure in the PDF that disagrees with the on-screen Intelligence page (the
composer must read the SAME analytics, not recompute); a flattened/image render that breaks text
extraction; a font-fallback that silently drops the brand face; a confidential term reaching the model;
a partial-year NOI presented as full-year (honor the grain rule); per-PM roll-up summing managed
properties wrong. Opus implementer + opus reviewer.

## Dispatch / blast radius
~1 focused worktree session (`npm run worktree`, never raw). Adds `@react-pdf/renderer` + brand TTFs as
deps — note the bundle/dep addition in the PR; server-only (not in the client bundle). New files +
additive routes/UI buttons. PR only — Gabriel reviews/merges.

## Residual / out of scope (v1)
- Scheduled auto-email of briefings (routes through the email canon → ggoldberg@oxfordra.net; the
  am-brief fleet already owns scheduled sends) — defer; this PR is on-demand export only.
- Ownership-level briefing (trivial later add via the same composer).
- Interactive/linked PDF, multi-page charts beyond sparklines/bars, XLSX export (covered elsewhere).
