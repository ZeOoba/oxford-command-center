# Standards, Testing & Quality — Oxford Intelligence Platform

This file is a **delta**, not a replacement. `architecture/coding-standards.md`, the existing `npm run gate` chain, and vitest conventions already cover folder structure, naming, error handling, logging, config, secrets, branch naming, commit messages, and code review — this initiative follows all of that unchanged. Only what's genuinely new is documented here.

## New standards this initiative introduces

- **Fact/document/edge schema conventions.** Every write to `facts`/`edges` requires `source_doc_id` (or an explicit `source_doc_id: null` + `confidence: 'inferred'|'estimated'` reason — never a silent null), `confidentiality_tier`, and `valid_from`. Supersede, never UPDATE — a changed fact is a new row with `superseded_by` pointing forward from the old one.
- **Relation-type registry.** `edges.relation` is constrained to an enum/lookup table populated as each phase needs a new relation — not a free-text string (flagged in the master roadmap's self-critique; enforce from E0.1).
- **AI prompt versioning.** Any prompt used by the Extractor/Reconciler/Outcome Tracker/Narrator agents is version-stamped in the code (not just described in a SKILL.md prose paragraph) so that a change in extraction behavior is attributable to a specific prompt version — this matters because "why did this lease extract differently in June vs. July" needs to be answerable the same way a code regression is.
- **AI output validation.** Every agent output that will be written to the store passes through a Zod schema check before write — no agent writes unvalidated JSON, full stop. This is the same discipline the warehouse already applies to Excel imports; extend it, don't invent a parallel standard.
- **ADRs.** New convention (`docs/adr/`), used only for decisions that are genuinely expensive to reverse — not for every PR. If a change doesn't touch the criteria in `docs/adr/README.md`, it doesn't need one.

## Documentation placement — decision table

| If the content is... | It goes in... |
|---|---|
| A hard-to-reverse decision and its rationale | `docs/adr/` |
| A phase's purpose, epics, near-term tasks | `docs/roadmap/intelligence-platform/00-master-roadmap.md` |
| A specific phase's detailed, JIT-generated task breakdown | `docs/superpowers/plans/<date>-<phase>.md` |
| A one-time cross-cutting design spec (like this whole roadmap started as) | `docs/superpowers/specs/` |
| Current, durable system shape (schema, contracts, ownership) | `architecture/*.md` / `architecture/*.json` |
| A dated ratification (a specific config value, a hurdle rate, a governor) | `memory/event_log.md` |
| Live claim/ownership of in-progress work | `architecture/status.json` |

If you're unsure which of these a piece of writing belongs in, that's a sign it's trying to be two things — split it.

## Testing strategy

| Test type | Applies to | Mechanism |
|---|---|---|
| Unit | Every new contract, migration, agent function | vitest, existing convention |
| Integration | Extractor→Reconciler→store path; query-guard across every read surface | vitest + a seeded test DB |
| Regression | Extraction golden-document sets, per doc type | new: `tests/golden-docs/<type>/` |
| Performance | Query-guard latency under the AI panel's live-read path (must not visibly slow the JARVIS panel) | lightweight benchmark in CI, not a full load-test harness — this system's scale doesn't warrant one |
| Security | Confidentiality query-guard's zero-false-negative bar | dedicated seeded-confidential-fact suite, run on every PR touching any read path |
| Data validation | Zod schema checks on every agent write | already-standard pattern, extended |
| AI evaluation | Extraction accuracy, Reconciler contradiction-catch rate, Adversarial Verifier refute-rate sanity | **the newest, least mature category — no existing pattern to extend.** Needs an actual golden-doc + golden-claim corpus before Phase 2 ships; treat building that corpus as its own task, not an afterthought. |
| Document parsing | Extractor against real (anonymized where needed) worst-case scans | seeded adversarial sample per the master roadmap's self-critique — do this *before* committing to no-OCR at scale |
| Failure simulation | Missing source doc, contradictory facts, backup restore | explicit test cases per failure mode, not just happy-path |

Nothing in this initiative is "done" without its test category passing in `npm run gate` or an explicitly-logged manual verification (backup restore, adversarial-scan sample) — matching the repo's existing "evidence over assertion" discipline.

## Data quality framework

Each check below is a concrete, automatable addition to the existing `warehouse:verify`/`warehouse:drift` gate pattern — not a new parallel system.

| Problem | Detection mechanism | When it runs |
|---|---|---|
| Duplicate records | Hash/fuzzy-match on entity natural keys (address, EIN, lease number) | On write (Reconciler) + nightly sweep |
| Missing metadata | Required-field check on `facts`/`documents` rows | `warehouse:verify` extension |
| Conflicting facts | Reconciler's contradiction check | On write |
| Broken relationships | Orphaned `edges` (endpoint entity doesn't exist) | `warehouse:verify` extension |
| Outdated information | `valid_to` in the past with no superseding fact and a source document type known to change periodically (leases, insurance) | nightly sweep, feeds Risk/Recommendation |
| Incomplete extraction | Extractor confidence below threshold, or required field null | Quarantine queue (Extractor's own failure path) |
| Invalid schema | Zod validation failure | On write, hard-blocks |
| Orphaned documents | `documents` row with no fact/edge referencing it after N days | nightly sweep |
| Version conflicts | Two facts for the same entity/predicate with overlapping `valid_from`/`valid_to` and no supersede relationship | `warehouse:verify` extension, hard-blocks |

## Observability

Extend the target-state "System Health module" already named in `00_system_of_record.md` rather than building a second dashboard. New metrics this initiative adds to it:

- Extraction accuracy (per doc type, against the golden set)
- Reconciler flag rate (contradiction catches / total writes)
- Confidentiality guard test-suite pass status (must always be visibly green — this is the one metric that should be impossible to miss going red)
- Queue depth (review queue for quarantined/flagged items)
- Fact/edge table growth rate
- Adversarial Verifier refute rate
- Backup last-verified-restore date (not just last-run date)
- Outcome Tracker coverage (properties with a complete Decision→Outcome pair — also the Phase 5 gate counter)

## Institutional memory — division of responsibility

- **`docs/adr/`** — why a hard-to-reverse decision was made (new).
- **`memory/event_log.md`** — dated ratifications of specific values/configs (existing, unchanged).
- **The Claude memory system** (`~/.claude/projects/.../memory/`) — cross-session operational knowledge, gotchas, project state (existing, unchanged — this initiative's memory file is `ora-intelligence-platform-master-plan.md`'s successor; update that memory file's pointer once this roadmap is ratified so future sessions land here, not on the superseded 2026-06-13 plan).
- **`docs/superpowers/plans/`** — what was actually built, phase by phase, once it's history rather than a live task list (existing, unchanged).

Nothing new is invented for "recurring bugs" / "performance improvements" / "schema history" — these already have homes (event_log.md, git history, migration files respectively). Building a parallel tracking system for information that already has a canonical location would itself be the kind of scope creep this roadmap is designed to avoid.
