# Record Spine orphan tables: wire, do not drop

**Date:** 2026-11-23 · **Source:** command-center review Tier 1 #2 · **Decision owner:** Gabriel

## Finding

Migration 030 (`030_record_spine.sql`, PR #332, 2026-09-17) created seven tables. Three now have
writers and readers (`entity_xref`: `server/warehouse/entity-xref.ts` plus `scripts/seed-entity-xref.ts`;
`agent_runs`: `agent-runs.ts`; `audit_log`: `audit.ts`). Four have neither:

| Table | Writers | Readers | Built for |
|---|---|---|---|
| `documents` | none | none | Track 3 lease-document registry (hash, type, amendment chain, executed flag) |
| `lease_facts` | none | none | Track 3 page-cited lease terms (page, verbatim quote, `quote_on_page`) |
| `obligations` | none | none | Track 3 dated obligations (option notices, escalations) computed from facts |
| `deal_decisions` | none | none | acquisition pass/pursue decisions with reason codes, `price_at_decision` |

Evidence: `grep -rnE "(FROM|INTO|UPDATE|JOIN)\s+<table>\b" server scripts src` returns nothing for
each of the four outside the migration file. The only references are the migration's own schema
test and `architecture/system-of-record.md`, which names them as systems of record.

## Recommendation: keep all four, no migration

1. **`documents`, `lease_facts`, `obligations`: keep. Wire by executing Track 3**
   (`docs/superpowers/plans/2026-09-17-lease-obligation-intelligence-p1.md`). That plan is written
   task by task against exactly these schemas and was never started; the tables are unbuilt, not
   abandoned. They are the only design in the repo that makes a lease term checkable (page plus
   verbatim quote verified against our own extracted text), which answers a failure this portfolio
   has already had (a hand-altered term and an unexecuted lease missed by abstraction). Before
   starting, refresh the plan's model ids (it names `claude-sonnet-5` / `claude-opus-5`; current are
   `claude-sonnet-5-5` / `claude-opus-5-5`).
2. **`deal_decisions`: keep. Wire as the acquisition outcome log** once the acquisition reason-code
   taxonomy is ratified (`2026-09-17-90day-tracks-overview.md`: "Gabriel ratifies ... the acquisition
   reason-code taxonomy"). It is the missing label for the calibration loop: the 2026-11-05 review
   found 68 verdicts and 0 outcomes, and the acquisition engine has never been scored against a live
   decision. `system-of-record.md` already names it the home of deal decisions, replacing the frozen
   `deal-decision-ledger.md`.

## Why not drop

- An empty table costs nothing at runtime: no reader means no wrong number anywhere.
- Dropping needs an architect-owned migration now and another to re-create the tables when Track 3
  or the outcome log is built. Two migrations against a live warehouse for zero runtime gain.
- `architecture/system-of-record.md` ratifies these tables as systems of record. Dropping them
  re-opens that ratification.

## What would change the answer

If Gabriel decides Track 3 will not be built (for example, lease abstraction stays in Cowork and
Notion), drop `documents`, `lease_facts` and `obligations` in one migration and remove their rows
from `system-of-record.md` in the same PR. If the outcome log moves to Notion's pipeline instead,
drop `deal_decisions` the same way. Either drop is architect-owned and needs Gabriel's approval before
the migration is written.

## Open decisions for Gabriel

Tracked in the ORA open-items tracker (`open-items-tracker.md`, filed 2026-11-23):

1. **OI-412**: go / no-go on Track 3 (lease and obligation intelligence, Columbus leases first),
   which decides whether `documents`, `lease_facts` and `obligations` are wired or dropped.
2. **OI-413**: ratify the acquisition reason-code taxonomy so `deal_decisions` can be wired.
