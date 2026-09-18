# 90-Day Items 1–3 — Overview, Constraints & Sequencing

> Companion plans: `2026-09-17-record-spine-foundations.md` (Track 1) · `2026-09-17-lease-obligation-intelligence-p1.md` (Track 3). Track 2 is coordination-only and has no plan file — it is owned by another session.

**Source:** `Claude_Workspace/02_Outputs/2026-09-17_AI-Agent-Portfolio_Evaluation_v01.html` (artifact `5NB6vvS1unJuxYuQaADpod`), items 1–3 of the 90-day answer.

## Objective

Within 90 days: ORA's proprietary data survives a laptop loss and can be joined across systems (Track 1), the Columbus leasing-market time series is live (Track 2), and every economically consequential lease term is a dated, page-cited obligation (Track 3).

## Constraints (hard guardrails)

1. **No writes to Oxford business OneDrive folders.** Lease PDFs under `OneDrive - Oxford Capital Partners/Business/Master Lease Database/` are **read-only** inputs. The registry stores hash + path; originals are never moved, renamed, or rewritten (Invariant 5).
2. **No governor or financial-model changes.** DSCR 1.25 / LTV 40 aggregate / 65 per-property are untouched by every task here (Invariant 4).
3. **No external sends.** No tenant, broker, vendor or PM email originates from this work (Invariant 1). Alerts route to `ggoldberg@oxfordra.net` only.
4. **No confidential or CoStar row-level data on external surfaces.** Per the lease-market session's standing request, CoStar row-level detail is ratified only for the private Access-gated mirror. Nothing from these tracks is published externally.
5. **No oxfordra.net work.** Out of scope entirely (Invariant 2).
6. **Migration numbering:** 029 belongs to `feat/lease-market-intel` and is final. This work starts at **030**.
7. **Additive schema only.** No task alters or drops an existing table or column.
8. **Single-writer discipline.** All work happens in an isolated worktree; `oxford-command-center` main is shared with other live sessions.
9. **Address normalization has one owner.** `splitAddress` in `src/analytics/lease-market/normalize.ts` is the only normalizer. Import it; never copy it. It is actively changing (a building-designator collapse — "Bldg 1" and "Bldg 2" reducing to one address — is being fixed on the lease-market branch), and inheriting that fix is the point.
10. **No script opens the live warehouse through `openWarehouse()` from an unmerged branch.** That helper runs pending migrations, so a read-only-looking script writes its branch's migration into the shared live database. Combined with constraint 12, the damage is not self-healing: the live DB records the migration as applied and never receives later edits to it. Backups open a plain read handle; ingest/compute scripts that must write use a temp `WAREHOUSE_DB` until their branch merges.
11. **Mirror redaction is taken, never re-derived.** Anything that reads `lm_*` and can reach the Cloudflare mirror takes its decision from `leaseMarketBakeMode(includeConfidential)` in `scripts/bake-warehouse.ts:285`. A whole-branch review just caught the public-safe bake shipping lease-market rows on its unattended path; a second implementation of that judgement is how it happens again. Nothing in Tracks 1 and 3 bakes to the mirror — this binds the deferred API/UI work.
12. **A migration is immutable once applied anywhere.** `runMigrations` keys off filename with no checksum, so an in-place edit never reaches a database that already ran the file. Correct an applied migration with the next number, never by editing it.

## Sequencing

```
Track 1 (Record Spine)  ├─ T1 T2 ──────────────► backup independent, start immediately
                        └─ T3 T4 T6 ─► T5 (crosswalk) ──┐
                                                        │ needs lm_property
Track 2 (lease-market)  ── owned elsewhere ── merge ────┘
                                                        │
Track 3 (Obligations)   ────────────────────────────────┴─► T1…T9 (needs 030 tables)
```

- **Track 1 T1–T2 (backup) has no dependencies.** It is the single highest-value hour in the program and starts first.
- **Track 1 T6 (crosswalk seeder) requires `feat/lease-market-intel` to be merged**, for two reasons: it reads `lm_property`, and it imports that branch's `splitAddress`. It feature-detects and skips cleanly when `lm_*` is absent, so it can be written before the merge — but its behaviour must not be pinned until the normalizer fix lands. Every other Track 1 task is independent.
- **Expect the ambiguity path to fire on real data.** `address_norm` is not unique within a market by design: two cities can share a street address, and blank-city rows may not yet be bridged to their city-bearing twins. The seeder refuses any match that is not one-to-one in both directions and reports the rest.
- **Track 3 requires Track 1 T3 (migration 030)** for `documents`, `lease_facts`, `obligations`, `audit_log`, `agent_runs`.

## Track 2 — coordination only (no code in this plan)

**Status as reported by the owning session (2026-09-17):** all 16 P1 tasks implemented and reviewed, `npm run gate` green on HEAD, branch in final verification (whole-branch review + adversarial pass). **P1 scope is frozen** — only fixes surfaced by those passes land now.

**Do not implement any lease-market feature in these tracks.** Coordination protocol:

| Item | Owner | Action |
|---|---|---|
| A17 Columbus validation gate (ontology ratification: subtype / status / rent-basis maps, rent curve, radar top 10) | Gabriel + owning session | Blocked on a human CoStar export landing in `Claude_Workspace/lease-market-intake/costar/` (currently 0 files) |
| CoStar retention & derivation rights | Gabriel | Written confirmation from CoStar. The owning session explicitly does **not** treat this as resolved. The durable asset is the `lm_observation` ledger; its licensing status is the open question. |
| Merge of `feat/lease-market-intel` | Owning session | Unblocks Track 1 T5 |
| Source-tagged purge path | **Already built** — `lm_landing.source` is NOT NULL and CHECK-constrained; every observation, event and listing joins back to it. No work needed. | — |

**Correction to the evaluation artifact:** the artifact states that an export outage "silently produces both series gaps and false removed events." The owning session corrected this, and the correction is right: removal requires two consecutive *complete* landings, and a complete landing must postdate every prior landing, so an outage produces **no** landings and therefore **no** false strikes. The real failure mode is **resumption** — the first complete export after a dark period strikes everything that left during the gap, all on one date, producing a synthetic mass-removal event.

**Track 2 P2 backlog (assigned to this plan's owner, not to be built during P1):**

- **P2-a:** promote "days since last complete landing" per market into the module KPI row. `marketFreshness(db, config, asOf)` already computes staleness and ships in the summary response + Data Quality tab; this is a surfacing change only.
- **P2-b:** annotate or suppress removal events when the gap since the previous complete landing exceeds a multiple of the expected cadence, so a resumption after a dark period does not read as a real mass move-out.

Both are scheduled after the merge, as a separate plan.

## Risk assessment

| Dimension | Assessment |
|---|---|
| **Reversible?** | Yes, all of it. Migration 030 is additive (new tables only) — rollback is `DROP TABLE`. The backup script opens the live DB through better-sqlite3's own backup API and writes only to the snapshot directory. The crosswalk seeder writes only `entity_xref`. Extraction writes only `documents` / `lease_facts` / `obligations`. |
| **Blast radius if a step fails** | Confined to `data/warehouse/finance.sqlite` and new tables. No existing engine reads the new tables until Track 3 T8 wires alerts, so a half-finished track is inert rather than harmful. |
| **Worst case** | A buggy seeder writes wrong crosswalk rows → wrong joins later. Mitigated: T5 emits an unmatched/ambiguous report and refuses to auto-link anything below the exact-match bar; every link records `match_method`. |
| **Confirmation required** | **Gabriel ratifies two artifacts before they bind anything:** the system-of-record matrix (Track 1 T4) and the acquisition reason-code taxonomy (separate, not in these tracks). No step sends anything externally or moves money. |
| **Financial-model exposure** | None. No task reads or writes governor constants or model workbooks. `npm run check:refute` applies if any task later touches financial-decision code; none here does. |

## File inventory

**Create (Track 1):**
- `server/warehouse/migrations/030_record_spine.sql`
- `server/warehouse/backup.ts`, `server/warehouse/entity-xref.ts`, `server/warehouse/audit.ts`, `server/warehouse/agent-runs.ts`
- `scripts/warehouse-backup.ts`, `scripts/warehouse-restore-verify.ts`, `scripts/seed-entity-xref.ts`
- `architecture/system-of-record.md`
- `tests/unit/warehouse-backup.test.ts`, `tests/unit/migration-030-record-spine.test.ts`, `tests/unit/entity-xref.test.ts`, `tests/unit/audit-log.test.ts`, `tests/unit/system-of-record-doc.test.ts`

**Create (Track 3):**
- `server/warehouse/lease-documents.ts`, `lease-fact-fields.ts`, `lease-page-text.ts`, `lease-extract-structured.ts`, `lease-extract-quotes.ts`, `lease-quote-verify.ts`, `lease-facts-persist.ts`, `lease-obligation-dates.ts`, `lease-obligations-api.ts`
- `scripts/scan-lease-documents.ts`, `scripts/extract-lease-facts.ts`, `scripts/lease-extract-eval.ts`
- `tests/unit/lease-*.test.ts` (one per module), `tests/fixtures/leases/` (redacted fixtures only)

**Modify:**
- `package.json` (scripts: `backup`, `backup:verify`, `xref:seed`, `leases:scan`, `leases:extract`, `leases:eval`)
- `server/warehouse/sub-routers.ts` (one entry — **expect a trivial conflict**, the lease-market branch adds `/api/warehouse/lease-market` here)
- `src/shell/modules.tsx` (one entry — same trivial-conflict note)

**Must not be touched:**
- `server/warehouse/migrations/001–029*.sql` — history, and 029 belongs to another session
- Anything under `.claude/worktrees/lease-market-intel/` — another session's worktree
- `src/analytics/lease-market/normalize.ts` — imported, never edited or copied (constraint 9)
- `scripts/bake-warehouse.ts` — `leaseMarketBakeMode` is the mirror-redaction authority (constraint 10)
- `server/warehouse/governors.ts`, `config/acquisition-ruleset.v1.json`, `config/replacement-cost.v3.json` — governor constants (Invariant 4)
- `OneDrive - Oxford Capital Partners/Business/**` — read-only (Invariant 5)
- `src/contracts/lease-forecast.ts` — the lease-market branch adds a provenance enum value here

## Definition of done (all three tracks)

1. `npm run gate` green.
2. A timed restore drill logged, with row counts matching the source.
3. Gabriel-ratified system-of-record matrix committed.
4. Columbus leases: 12 critical fields extracted, each with a quote whose page is **verified against our own page text**, ≥95% verified by a human.
5. The billed-vs-lease escalation discrepancy count reported — the number that makes the ROI real rather than asserted.
