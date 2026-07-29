# ADR-0004: Confidentiality tier is a required column, enforced at write time

**Status:** Accepted

## Context

Hard Invariant 3 (active confidential deals never surface externally until closing) currently governs *publish/send/deploy* actions via `confidentiality-guard.py`. The Intelligence Platform's entire value proposition is maximal cross-referencing across facts, documents, and narratives — which means the blast radius of one confidential fact leaking through a query, semantic search result, or narrative brief is larger than anything the existing egress-only guard was designed to catch. Retrofitting row-level confidentiality onto a system already full of cross-references is far harder than designing it in from the first migration.

## Decision

Every row in `facts`, `documents`, and `edges` carries a required, non-null `confidentiality_tier` (`public | internal | deal-confidential`) set at write time by whichever agent creates the row — never defaulted or inferred after the fact. A query-layer guard (Phase 0, E0.2) checks this tier on every read path an agent, narrative, or search index can reach, not only on external-facing writes. The guard's test suite has a zero-false-negative bar, not merely a "low" one.

## Consequences

- Every future Extractor/agent must resolve a confidentiality tier before writing, adding a small amount of friction to every ingestion pipeline permanently — accepted, because the alternative is a system that can leak by construction.
- The query-layer guard is new engineering the existing egress-only guard didn't require; scope it honestly in Phase 0 rather than assuming the existing hook covers it.
- This cannot be reversed cheaply once Phase 2 has written thousands of facts without tiering — get it into the schema at E0.1, not after.
