# System of Record Matrix

**Status:** PROPOSED — awaiting ratification.
**Ratified by Gabriel:** ( pending — date and initials go here )

One system of record per entity. Every other store holding the same entity is a **mirror**: it
may be read, but a disagreement is resolved in favour of the system of record, and a mirror is
never the source for an analytic. Adding a new store for an entity that already has one requires
retiring an old one in the same change.

<!-- TABLE-CHECK:START -->
| Entity | System of record | Warehouse table | Mirrors (read-only) |
|---|---|---|---|
| Property / unit | Warehouse | `property_master`, `entity_xref` | ora-pm `properties`/`units`, Notion, live workbook, lm_property |
| Lease economic terms | Warehouse (verified facts) | `lease_facts`, `lease_terms` | ora-pm `leases`, Notion Tenant DB, TENANTS.json |
| Lease obligations & dates | Warehouse | `obligations` | M365 To-Do tasks |
| Source documents | Warehouse registry (files stay in OneDrive) | `documents` | doc-index.sqlite |
| Listings & observations | Warehouse | *pending migration 029 — see note below* | Access-gated mirror (row-level stripped) |
| Billed rent / AR | PM system export | `ledger_entries` | — |
| GL / P&L | QuickBooks Desktop CSV | `ledger_entries`, `import_batches` | live workbook |
| Deal candidates & scores | Warehouse | `acq_candidates`, `acq_scores` | Notion Sourcing Log, HubSpot |
| Deal decisions | Warehouse | `deal_decisions` | `deal-decision-ledger.md` (frozen, read-only) |
| Pipeline provenance | Warehouse | `agent_runs`, `audit_log` | — |
<!-- TABLE-CHECK:END -->

**Note on the listings row.** Its tables — `lm_listing`, `lm_observation`, `lm_property`,
`lm_landing` — land with migration 029 on `feat/lease-market-intel` and are therefore not yet in
this branch's schema. They are named here in prose rather than in the checked column on purpose:
the test below asserts that every table the matrix names actually exists, and weakening that
assertion to accommodate an unmerged branch would defeat the only mechanism keeping this document
honest. Move them into the `Warehouse table` column, backticked, when 029 merges.

## How this document is kept honest

`tests/unit/system-of-record-doc.test.ts` parses the `Warehouse table` column between the
`TABLE-CHECK` markers and fails if any table named there is absent from the migrated schema. A
system-of-record matrix that drifts from the database is worse than none, because it is trusted.

## Open decisions (Gabriel)

1. **Is ora-pm headed to production** (tenant portal, Stripe ACH) or staying pre-production? If
   production, lease economic terms move there at the Postgres migration trigger, and this matrix
   changes with it.
2. **CoStar retention and derivation rights** — until confirmed in writing, `lm_observation` rows
   are treated as license-bound; the purge path is a join on `lm_landing.source`.

## Rules

- A mirror that disagrees with its system of record is a **defect**, not a data point.
- No analytic reads a mirror. If an analytic needs a field only a mirror has, the field is missing
  from the system of record and that is the bug to fix.
- Every cross-store link is recorded in `entity_xref` with its `match_method`, never inferred at
  query time.
