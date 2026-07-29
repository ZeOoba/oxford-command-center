# Architecture Decision Records

New convention as of 2026-07-29 (this repo had none before — see the Oxford Intelligence Platform roadmap, `docs/roadmap/intelligence-platform/`, for why one was introduced now).

## When to write one

Only for decisions that are **expensive to reverse** — schema/storage choices thousands of downstream facts will reference, identity schemes, security/confidentiality boundaries, or a compute/AI trust boundary. Most PRs do not need one. If you're unsure, ask: "if this turns out wrong in a year, is fixing it a small patch or a system-wide migration?" Only the second kind gets an ADR.

## Format

Title, Status (`Proposed | Accepted | Superseded by ADR-000X`), Context, Decision, Consequences. Keep it short — an ADR records *why*, not a design spec (that's what `docs/superpowers/specs/` is for).

## Index

- [ADR-0001](0001-workbook-is-source-of-truth.md) — Master Excel workbook remains the sole source of truth for financial facts; the new fact store is subordinate and reconciles to it.
- [ADR-0002](0002-relational-facts-store-not-graph-db.md) — Relational tables (SQLite) for facts/edges, not a dedicated graph database.
- [ADR-0003](0003-entity-id-scheme-natural-keys.md) — Entity identity uses natural keys, not surrogate autoincrement synced across PM platforms.
- [ADR-0004](0004-confidentiality-tiering-in-schema.md) — Confidentiality tier is a required column on every fact/document/edge, enforced at write time, not bolted on later.
- [ADR-0005](0005-deterministic-compute-llm-narrate-boundary.md) — LLMs narrate deterministic output; they never compute or invent financial numbers.
