# Plan — id-based seed↔Notion deal join

**Approved by Gabriel in-turn 2026-08-12** as follow-on to [PR #271](https://github.com/ZeOoba/oxford-command-center/pull/271).
Rationale, evidence, and constraints: `memory/project_deal_join_id_based_redesign_queued_2026-08-12.md`.

## The defect being retired

`dealJoinKey` strips Notion's `" — City, ST"` locality tail, lowercases, and collapses punctuation.
That tail exists *precisely because* bare street names repeat across metros, so the key deletes the
only disambiguator — and confidentiality rides on the join, because a wrong merge folds an unmatched
(fail-closed confidential) row into a public seed record.

Four adversarial passes on 2026-08-11/12 produced 9 + 7 + 5 + 6 defects; the join subsystem produced
the worst of them. Every fix bolted on **another corroboration signal** (mapped market → locality tail
→ literal equality). That is the signature of a wrong primitive: "same deal" has no ground truth in a
name, so each guard was stated over a *mechanism* rather than the *invariant*.

## The primitive

Notion's native **Unique ID** property (`Deal ID`, prefix `DEAL`) on the Acquisition Pipeline Tracker.

Chosen over a `rich_text` id because it is **read-only by construction**: Notion auto-assigns it to
every existing and future row, and no human, script, or rename can blank, duplicate, or perturb it.
The invariant is enforced by the datastore, not by a guard in this repo. It cannot be created through
the API ([property-object](https://developers.notion.com/reference/property-object)), so its creation
is a one-time manual step; that is the entire cost.

`src/data/seed-deals.ts` mirrors the assigned value as `notionDealId`. The join is an opaque-key
lookup with **no normalization anywhere in the path**.

## Facts measured against live Notion (2026-08-12, read-only probe)

- DB `46c8a5c6-8b37-4c53-a10d-0f55c97613e5` = "Acquisition Pipeline Tracker", **20 deal rows**.
- It carries **two** data sources; the second ("New data source") has only a `Name` title and yields
  no deals. The adapter already queries both and drops title-less rows.
- **No `Deal ID` / `unique_id` property exists yet.**
- `MARKET_MAP` is worse than the recorded "6 of 10 metros". Three of its six keys are strings Notion
  **cannot emit**: `Kansas City MO` (live: `Kansas City MO/KS`), `Mid-Atlantic` (live:
  `Maryland (Baltimore/DC)`), and `Toledo OH` (not a select option at all). Only 3 keys are live, so
  **12 of 20 rows** are non-corroborable (11 → `Other`, 1 → null) — not the 11 previously recorded.
- `NOTION_DEALS_NAME_ALIASES` **is** configured in `.env` (one live alias). Commit `20f12a6`'s claim
  that it "is not configured … so the alias path cannot fire on current data at all" is false as of
  today, so one live join currently depends on the alias path being retired carefully.

## Invariants preserved from PR #271 (do not rediscover)

1. **Fail closed.** An unmatched Notion row keeps defaulting `confidential` (Hard Invariant 3), via
   the existing `isDeclassified` exit only.
2. **Nothing is destroyed in either direction.** A refusal leaves the seed unenriched and lets the
   live row fall through to `extras`; it never drops a row.
3. **Flags must not carry deal names.** `snapshot.dataQuality` reaches the public
   brain.oxfordra.net payload and `redactConfidential` does not sweep it. Names go to `console.warn`
   (local) only.
4. **Error-severity flags block the reconciliation gate**; `DealsLoad.flags` stays separate from
   `degraded` (which describes the fetch).
5. Known limitation, still out of scope: `Brain.persist` keys on `deals`/`pipeline` and does not
   decline on join flags — that is catch-up finding H2.

**Improvement this redesign unlocks:** a `DEAL-7` id is opaque and non-identifying, so flags can name
the id *directly*. That retires the FNV-1a `keyDigest` indirection for every id-keyed flag and with it
the "gate-blocking diagnostic the operator cannot resolve to a deal" defect (fourth pass, MEDIUM).

## Join algorithm

```
seedById   : seeds with notionDealId != null
liveById   : live rows with notionDealId != null

REFUSE (error flag; nothing merges on that id):
  - two or more seeds share a notionDealId      -> all of them stay unenriched
  - two or more live rows share a notionDealId  -> all held out -> extras -> confidential
  - a live row has NO notionDealId              -> held out -> extras -> confidential
      (means the property is missing/unreadable: refuse, never fall back to names)

MERGE: seed.notionDealId -> liveById lookup. The id is authoritative; no corroboration.

TRIPWIRE (warn, never merges): unjoined seed x unjoined live row whose dealJoinKey(name) matches
  -> "these look like one deal; set the Deal ID". Names are EVIDENCE FOR DETECTION ONLY.
```

Corroboration machinery (`MARKET_STATES`, `isRealMarket`, `localityStateOf`, `exactNameMatch`, the
uncorroborated/refused-merge flags) is deleted: an opaque authoritative key has nothing to corroborate.

## Retired

`NOTION_DEALS_NAME_ALIASES`, `NOTION_DEALS_ACCEPTED_NEAR_DUPES`, `parseNameAliases`, `aliasedJoinKey`,
`acceptedPairKey`, `acceptedCollisionKey`, `parseAcceptedNearDupes`, `parseAcceptedCollisions`, and
`findNearDuplicateNames` together with its `reconcile-runtime.ts` gate-blocking call.

The near-duplicate detector's *role* is not lost — it is relocated and strengthened. It ran on the
merged output, where a successful wrong merge leaves only one row and is therefore invisible to it.
The tripwire runs inside `mergeDeals`, which knows exactly which rows failed to join. `dealJoinKey`
and `stripLocalitySuffix` survive as the tripwire's detector only.

## Cutover is atomic, by construction

"A missing id must REFUSE, never fall back to name matching" admits no gradual migration: until the
property exists and the seed mirrors it, every live row is idless → held out → 20 error flags → the
gate blocks. That is loud and fail-closed, but it means property + seed ids + code must land together.
Verified against live before merge.

## Tasks (TDD, test written and watched to fail first)

1. `Deal` contract: `notionDealId: z.string().nullable().default(null)`.
2. `mapNotionPage`: read the `Deal ID` unique_id property → `"<prefix>-<number>"` (bare number when
   the prefix is null).
3. `deal-name.ts`: strip to `stripLocalitySuffix` + `dealJoinKey`; rewrite the header for its new,
   detector-only role.
4. `mergeDeals`: the algorithm above.
5. `reconcile-runtime.ts`: drop the `findNearDuplicateNames` call.
6. `seed-deals.ts`: mirror the 6 real ids; rewrite the "NAMES ARE JOIN KEYS" header.
7. Live verification against the real pipeline: 6 joins, 14 extras, 0 error flags.
8. Mandatory adversarial refute pass (`.claude/workflows/refute-financial-change.js`) +
   `Refute-Reviewed` trailer; `npm run check:refute`.

## What the adversarial refute pass changed (wf_80769cd1-096, 2026-08-12)

Three lenses, worst severity HIGH, **five real defects in the first version of this change**. Two of
them refuted claims stated above, so the design as built differs from the design as planned.

**The claim "the tripwire strictly dominates `findNearDuplicateNames`" was wrong.** It was refuted by
execution. The tripwire compares only `unjoinedSeeds × extras`, so three pair classes stayed
invisible: joined-seed × extra, extra × extra, and seed × seed. The dangerous one: delete and
re-create a Notion row — Notion assigns a **fresh** Unique ID, so no id collision fires — and a seed
keeps enriching from the abandoned row, publishing stale price/stage/cap-rate as if live, gate green,
where the old code raised a blocking error. That is the 2026-08-04 Pendleton/2146 incident class.
So the backstop is **restored**, inside the joiner, over the full published set, with exact-key
matching (no prefix false positives, so no acceptance hatch) and cross-metro suppression via the
locality tail. `localityStateOf` comes back for that suppression **only** — it can silence a false
alarm, never authorize a merge.

**The "atomic cutover" had zero mechanical enforcement.** Merging before the ids were filled would
have published null economics for all six seed rows *gate-green*, because the tripwire is warn and
the error-severity backstop had just been deleted. "A human remembers" is the exact guarantee class
this subsystem has already paid for four times, so it is now `tests/unit/seed-deal-ids.test.ts` —
the branch is literally unmergeable until every seed carries a well-formed id.

**`fetchNotionDeals` keyed row existence on the name slug.** `byId.set(notion-${slug(name)})`,
last-write-wins over Notion's return order, **upstream of every guard here**. A pure permutation of
the API page order flipped which of two same-titled rows survived, and the loser appeared in neither
`merged` nor `extras` — a confidential live row destroyed, zero flags, exit clean. Pre-existing, but
the id join is what made the fix available: the map now keys on `notionDealId`.

**Two smaller ones:** a seed id that resolves to nothing was undetectable (the seed side is a
hand-copied mirror — the one place Notion's read-only guarantee does not reach), so a reverse
tripwire now flags it, at error when the seed sits at an active stage; and the migration tripwire
emitted one flag per pair and told the operator to copy an id on a name match, which for a false
match hand-creates the very wrong merge this key prevents. It is now aggregated per seed and says
CONFIRM first.

**Verified sound and left alone:** `uniqueId` on number 0 / empty prefix / malformed shapes; every
fail-closed path (colliding ids, ambiguous seeds, idless rows) reaching `extras` confidential with
nothing dropped; no name leaking into any flag; the Market enum and `MARKET_MAP` claims in the
section below, both confirmed by execution.

**Residual risk, stated rather than solved:** a seed id typo that lands on *another valid* id
wrong-merges with no corroboration — the id join deliberately has none. The published-duplicate
detector catches the common shape of this (the abandoned live row surfaces as a same-name duplicate),
but not the case where the two deals' names differ. The real fix is to stop hand-copying the mirror;
see the follow-up note in the PR.

## Separate commit — Market enum (Q3)

Add `Cincinnati OH`, `Madison WI`, `Grand Rapids MI`, `Des Moines IA`, `Louisville KY`, `Richmond VA`
to the `Market` enum; repoint the 3 dead `MARKET_MAP` keys. Fixes a live published-data defect: the
mirror reports `market: 'Other'` for 11 of 20 pipeline deals.

**Must verify before landing:** `market-benchmarks.ts` and `RCT_V03` are keyed by `Market` (both
`Partial<>`). A new member with no row must fall back to the `Other` entry, not to nothing — otherwise
this trades a wrong label for a missing benchmark. Cap-rate bands for the new metros will **not** be
invented; if no fallback exists, the consumers keep resolving those metros to `Other`.
