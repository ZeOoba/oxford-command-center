# Track A — Insurance Premium History Import (Design)

**Status:** Approved by Gabriel 2026-08-22. **Lane:** L3 (feature, additive). **Claim:** `oxford-command-center-data` (this session).

## 1. Problem

`property_insurance_policies` (migration 008/022) has 34 rows but none carry more than the current term — there is no multi-year premium history, and 0 rows have `deductible`/`coverage_limit` populated. Gabriel's Cowork session produced `ora-insurance-premium-dashboard` (a published Artifact under `Documents\Claude\Artifacts\`), which has clean 3-year premium history for 7 properties plus a deductible-ladder analysis for 11 entities. This design specifies how that data lands in the warehouse.

## 2. Sources

- **`ora-insurance-premium-dashboard/index.html`** — embedded `PROPS` JS array (7 properties × up to 3 policy years: package premium `p`, umbrella/GL premium `u`, building/TIV `t`), plus a deductible-ladder table (11 entities × $10K/$25K/$50K/$100K quoted savings) and the 9620 State 350 carrier-switch narrative (3 terms, deductible $5K→$5K→$50K).
- **`2026-08-17_InsurancePremiumHistory_Analysis_v03.xlsx`, "Source Index" tab** — per-document filename, page count, and a "what it provided" summary. Has **no policy numbers**; used here only to supply a stable filename surrogate where a real number isn't otherwise known.

## 3. Non-goals (this track)

- The 4 deductible-ladder entities with no `PROPS` entry (`2203 Northwood`, `29000 Information Ln`, `Muirkirk Properties`, `1100 Rarig Ave`) — a different carrier track, not covered by this dashboard. Deferred, not guessed at.
- Applying `--dec-pages` updates — sequenced as a follow-on once the policy rows this track creates actually exist (dec-pages updates by row `id`, which doesn't exist until insert).
- Any schema migration. Confirmed unsafe: `(property_id, effective_date, policy_type)` collides on real data today — `GROUP BY property_id, effective_date, policy_type HAVING COUNT(*)>1` returns **4 rows across 2 groups** for the 2025-10-18 9620 State 350 carrier switch (both the GL pair *and* the Property pair, XPT Specialty vs. Westchester/Illinois Union in each, differing only by `policy_number`/`insurer`). The existing `UNIQUE(property_id, policy_number, effective_date)` stays as-is.

## 4. Identity design

### 4.1 `property_id` convention

Existing rows use `ins-<property-slug>-<line-code>` (one row-family per **policy line**, not per property) — e.g. `ins-9620state350-gl`, `ins-1900broadway-ufx`. The column has no FK to `property_master` (unlike `property_tax_assessments`/`insurance_loss_events`), so a typo creates a silent orphan, not a rejected row — handled in §6.

Resolved per-property line mapping (the non-obvious cases, confirmed against the live table's distinct `(property_id, policy_type)` pairs):

| `PROPS` key | Property | Package-equivalent line | Second line | Note |
|---|---|---|---|---|
| `1900` | 1900 N Broadway | `ins-1900broadway-ufx` | `ins-1900broadway-bcl` | Package line is **UFX** ("Unoccupied/Flex Package"), not `pckg`. Dashboard's generic "umbrella" (`u`) maps to the existing **BCL** line — Source Index confirms the "Umbrella Insurance.pdf" documents are filed under BCL for this property. |
| `WEST` | 3034 Westerville Rd | `ins-3034westerville-pckg` | — | No excess/umbrella layer exists or is added — dashboard explicitly notes "no excess layer at all." |
| `3540` | 3540 E 5th Ave | `ins-3540fifth-pckg` | `ins-3540fifth-bcl` | |
| `3883` | 3875-3883 Livingston | `ins-3883livingston-pckg` | `ins-3883livingston-bcl` | |
| `FVC` | Fairground Village Ctr | `ins-fvc-pckg` | `ins-fvc-bcl` | |
| `9620` | 9620 State 350 | `ins-9620state350-prop` | `ins-9620state350-gl` | **Plus a new line**: `ins-9620state350-umb` (umbrella $1M/$1M added 05/28/2026) — no prior row exists for it; this is the one genuinely new id minted by this track. |
| `EGF` | 55 New Plant Ct | `ins-55newplant-pckg` | `ins-55newplant-bcl` | |

### 4.2 `policy_number`

Real number where the Source Index or dashboard tooltip cites one; otherwise the **source document filename** (e.g. `35402526` from `35402526.pdf`) as a stable, idempotent, traceable surrogate — never an invented human-readable code. This keeps the existing `UNIQUE(property_id, policy_number, effective_date)` constraint idempotent across re-runs without a migration.

## 5. Import mechanism

Add a third mode to `scripts/import-insurance-data.ts`: `--policies <payload.json>`.

**Payload shape** (mirrors the existing `{ events: [...] }` / bare-array conventions):

```json
{ "policies": [
  { "propertyId": "ins-3540fifth-pckg", "insurer": "Carrier 01", "policyNumber": "26-27-commercial-package-renewal",
    "effectiveDate": "2026-01-20", "expirationDate": null, "premiumAnnual": 1234, "coverageTiv": 1000000,
    "policyType": "Package (PCKG)", "source": "ora-insurance-premium-dashboard (Cowork artifact)", "sourceDate": "2026-08-17" }
] }
```

**Upsert semantics — the one real design decision here.** `import-assessments.ts` uses `INSERT OR REPLACE`, which is wrong for this table: `property_insurance_policies.id` is an `AUTOINCREMENT` surrogate that `import-insurance-data.ts --dec-pages` already keys on (`UPDATE ... WHERE id = ?`). A blunt `REPLACE` deletes-and-reinserts on conflict, minting a **new** `id` and silently discarding any `deductible`/`coverage_limit` already applied to that row by a prior dec-pages run. Instead:

```
SELECT id FROM property_insurance_policies WHERE property_id=? AND policy_number=? AND effective_date=?
  → found: UPDATE the non-key columns (insurer, expiration_date, premium_annual, coverage_tiv, policy_type,
    source, source_date, ingested_by, ingested_at) by that id — deductible/coverage_limit untouched.
  → not found: INSERT a new row.
```

Each row's read-then-write is wrapped in its own try/catch inside the enclosing `db.transaction()`, matching the per-row isolation already used by both other modes.

## 6. Validation & data-quality reporting

Parse-time rejects (never persisted, printed in the summary — matches existing convention):
- missing (or whitespace-only) `propertyId`, `insurer`, `policyNumber`, `effectiveDate`, `premiumAnnual`, `policyType`, or `sourceDate`
- **Correction (post-PR-review):** `source` is *not* in the reject list above — it has the same per-row-then-payload-then-CLI-default fallback chain as the existing `loss-events` mode (§`parseLossEventsPayload`'s `fallbackSource`), which is what actually shipped and is tested. An earlier draft of this section listed `source` as required; that was a spec/implementation mismatch, not a code defect — corrected here rather than in the code, since the fallback behavior is the intended, precedented one.
- `effectiveDate`/`expirationDate` (when present) not strict ISO `YYYY-MM-DD`, and `sourceDate` likewise (added post-PR-review — the original draft only regex-checked the first two, but `sourceDate` feeds `source_date`, which `insurance-analysis.ts` ranks by string comparison) — same defect class as the existing `loss_date` check (a US `MM/DD/YYYY` or Excel-serial date must be rejected, not silently miscoerced)
- `premiumAnnual` not a nonnegative finite number; `coverageTiv` (when present) not a nonnegative finite number

**New check specific to this mode** (there is no FK to lean on): if `propertyId` does not already exist in `property_insurance_policies` **and** is not present in a small in-payload `newLines: ["ins-9620state350-umb"]` allowlist, record a `data_quality_issues` row (`kind='insurance-policy-unrecognized-line'`, severity `warn`) instead of silently inserting an orphaned line — mirrors the discipline the other two modes get for free from a real FK.

## 7. Testing

Extend `tests/unit/import-insurance-data.test.ts` (vitest, `openWarehouse` against a `mkdtempSync` scratch DB — existing pattern) with:
- `parsePoliciesPayload` — required-field rejects, ISO-date rejects, negative-number rejects (mirror the three existing `describe` blocks' style).
- `importPolicyRows` — insert-new case, update-existing-preserves-deductible case (the core design decision in §5 — this is the one test that would have caught the `REPLACE` bug), unrecognized-`propertyId` → `data_quality_issues` case, re-run idempotency (same file twice → second run all "updated", zero duplicate rows).
- CLI `parseArgs` — `--policies <path>` alongside the existing `--dec-pages`/default modes.

## 8. Rollout

1. Land the importer + tests, `npm run gate`.
2. Build the actual payload (7 properties × up to 3 years + the 1 new 9620 umbrella line — ~19-20 rows) from `PROPS` + Source Index, per the mapping in §4.1.
3. Run against `data/warehouse/finance.sqlite`, verify inserted/updated/rejected counts against the expected row count by hand before treating it as done.
4. Isolated commit; no push without Gabriel's confirmation (single-writer repo — other sessions hold unrelated dirty files in this checkout right now; this claim covers only this spec and `scripts/import-insurance-data.ts`).

## 9. Explicitly out of scope / deferred

- Track B (county tax reconciliation) and Track C (entity tax/basis schema) — separate design cycles.
- `--dec-pages` run against the new rows — needs the rows to exist first; sequenced as this track's immediate follow-on, not bundled in.
- The 4 non-`PROPS` deductible-ladder entities (§3).
