# ADR-0001: Master Excel workbook remains the sole source of truth for financial facts

**Status:** Accepted (already the repo's operating reality — `npm run gate`'s `reconcile` step enforces this against the warehouse; this ADR formalizes it as it extends to the new fact store).

## Context

The Intelligence Platform introduces a generalized `facts` table capable of storing any extracted claim, including financial figures already tracked in the Master Workbook. Without an explicit hierarchy, the new store risks becoming a second, competing source of financial truth — a failure mode already experienced once (Northwood/EGFLLC loan miscategorization inflating workbook LTV cells via a downstream system that disagreed with the workbook).

## Decision

The Master Workbook wins on any financial-fact conflict, unconditionally. The `facts` table may store financial figures extracted from other documents (invoices, loan docs), but any figure that also exists in the workbook is tagged `authority: secondary` and a disagreement with the workbook is surfaced as a data-quality exception, never silently resolved in the fact store's favor. The existing `reconcile`/`reconcile:noi-crosscheck` gate steps are the enforcement mechanism and must be extended, not bypassed, as the fact store grows.

## Consequences

- Every new financial-fact-producing pipeline (Extractor, Reconciler) must know which facts are workbook-shadowing and route disagreements to the same reconciliation gate, not a new one.
- This is deliberately conservative: the fact store cannot "correct" the workbook even when it might be right (e.g., a newer invoice contradicts a stale workbook cell) — it can only flag. Overriding this requires a human decision and a workbook edit, not a schema change.
- Reversing this later (letting the fact store win) would require re-verifying every financial fact currently trusted from the workbook — treat this as effectively permanent.
