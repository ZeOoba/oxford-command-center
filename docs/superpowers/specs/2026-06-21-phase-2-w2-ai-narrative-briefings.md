# Phase 2 · Workstream 2 — AI Narrative Briefings (Steps 7–11)

**Status:** in progress (worktree `compassionate-golick-b55abd`, branch `claude/compassionate-golick-b55abd`)
**Authored:** 2026-06-21 · **Lane:** L3 (/build) · Opus plans/reviews · Sonnet implements · Opus refutes
**Recovers:** the never-committed `2026-06-20-phase-2-debt-refi-scoring-ai-narrative-briefings.md` (W2 portion only). Requirements taken from the Phase 2 handoff §3.2 + the live Phase C code.

## Ratified decisions
- **D4 — model + cost:** Gabriel authorized $0.01–0.05/briefing. Model = `claude-haiku-4-5-20251001` (the codebase's existing Haiku constant in `server/warehouse/om-extract.ts`; the spec's `claude-haiku-3-5` is superseded — global rule: latest model).
- **D5 — button placement:** extend the existing `src/modules/intel/ExportBriefingButton.tsx` with a `narrative?` prop; reused in `PropertyIntelView` (property) and `ManagersView` (manager). No new placement.
- **"Three narrative routes" → two JSON routes + a PDF query param.** There are exactly two briefing subjects (property, manager) and two UI surfaces. The PDF-with-narrative is delivered via `?narrative=1` on the existing `.pdf` routes — this guarantees the byte-identical non-regression when narrative is null. (Documented deviation from the missing spec's literal "three"; Gabriel is the merge gate and can redirect.)

## Invariants (hard)
- **Never modify the base `BriefingModel`** (`PropertyBriefingModel` / `ManagerBriefingModel`). Only ADD new schemas.
- **Byte-identical PDF** when `narrative` is null/absent vs the Phase C PDF (non-regression test required).
- **Double confidentiality guard:** `assertNoConfidential(subset)` BEFORE sending to the model; `scanForConfidential(text)` AFTER receiving — on a post-receive hit, discard the narrative (return null + degraded), never render it.
- **Routes never block, always 200.** On any failure (no key, timeout, AI error, confidential hit, parse failure) → `{ narrative: null, degraded: true }`.
- **Restate only present figures.** The model receives ONLY a JSON subset of the *already-validated* BriefingModel (display strings + bands + names). It must not invent or compute figures. temp 0.
- Financial-adjacent (`server/warehouse/*`) → mandatory adversarial refute pass (`.claude/workflows/refute-financial-change.js`) + `Refute-Reviewed:` trailer before done.

## Steps

### Step 7 — `src/contracts/briefing.ts` (architect-owned → flagged)
ADD (base models untouched):
- `NarrativeBlock = z.object({ headline: string, summary: string, bullets: string[], model: string })`
- `NarrativeEnvelope = z.object({ narrative: NarrativeBlock.nullable(), degraded: z.boolean() })`
- `NarrativePropertyBriefingModel = PropertyBriefingModel.merge(NarrativeEnvelope)`
- `NarrativeManagerBriefingModel = ManagerBriefingModel.merge(NarrativeEnvelope)`

### Step 8 — `server/ai/narrative.ts` (Intelligence Agent area; new file)
`composeNarrative(model: BriefingModel, opts: { apiKey?, model?, fetchImpl? }): Promise<{ narrative: NarrativeBlock | null; degraded: boolean }>`
- Mirror `om-extract.ts`: raw `fetch` to `https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `AbortController` with a **15s** timeout, injectable `fetchImpl`.
- Build a compact JSON subset from the validated model (display strings, bands, names, verdict line — NO raw recompute). `assertNoConfidential(subset)` first.
- System prompt: restate ONLY the figures present; no new numbers; institutional ORA register; temp 0; output strict JSON `{ headline, summary, bullets }`.
- Parse → validate `NarrativeBlock` (inject `model`); `scanForConfidential` the assembled text → on hit, return `{ narrative: null, degraded: true }`.
- No key / timeout / non-200 / malformed → `{ narrative: null, degraded: true }`. **Never throws** for normal failure.

### Step 9 — `server/warehouse/api.ts` (architect-owned → flagged)
ADD (no existing route altered):
- `GET /briefing/property/:slug/narrative` → compose property model (404 if absent) → `composeNarrative` → `c.json(NarrativePropertyBriefingModel.parse({ ...model, narrative, degraded }))`. Wrapped so it always 200s on compose/AI failure with `{ narrative: null, degraded: true }` (still 404 only when the subject doesn't exist).
- `GET /briefing/manager/:slug/narrative` → same for manager.
- `?narrative=1` branch on the existing `.pdf` routes → compose narrative, pass to `renderBriefingPdf(model, narrative)`. Absent param or null narrative → unchanged call (byte-identical).
- API key sourced from env at the route boundary (same as om-extract: `process.env.ANTHROPIC_API_KEY`).

### Step 10 — `server/briefing/pdf.tsx` (extend, do not rewrite)
- `renderBriefingPdf(model, narrative?: NarrativeBlock | null)` — optional second param.
- Thread `narrative` into `BriefingDocument` → the Doc components render an extra narrative `<View>` ONLY when `narrative != null`. When null/absent the element tree is unchanged ⇒ byte-identical.
- Non-regression test: render with no narrative, assert bytes equal a Phase C render of the same model.

### Step 11 — `src/modules/intel/ExportBriefingButton.tsx` + the two views
- Add `narrative?: boolean` prop → when true, href gains `?narrative=1` and the label defaults to "Export with narrative (PDF)".
- Surface a second button (or a variant) in `PropertyIntelView` and `ManagersView` next to the existing export. Client-only, dep-light (no PDF/font deps in the client bundle).

## Test plan (TDD, written first each step)
- contract: parse/round-trip `NarrativeBlock`, both envelopes; base models still parse unchanged.
- narrative.ts: happy path (mock fetch → JSON), timeout → degraded, non-200 → degraded, no key → degraded, malformed JSON → degraded, **post-receive confidential hit → narrative null + degraded**, assert-no-confidential pre-send.
- routes: 200 + `{narrative,degraded}` shape; AI failure still 200 degraded; 404 for unknown subject; `?narrative=1` PDF returns application/pdf.
- pdf: byte-identical when narrative null (golden); narrative section present when non-null.
- button: href carries `?narrative=1` when `narrative` set.

## Gate + done
`npm run gate` green (governance + typecheck 0 + lint 0 + vitest + reconcile + warehouse:verify) → adversarial refute pass on `narrative.ts` + `api.ts` → `Refute-Reviewed:`/`Refute-Skip:` trailer → PR for Gabriel (architect-owned `briefing.ts` + `api.ts` flagged in status.json).
