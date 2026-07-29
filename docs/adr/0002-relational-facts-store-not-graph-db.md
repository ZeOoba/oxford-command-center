# ADR-0002: Relational tables (SQLite) for facts/edges, not a dedicated graph database

**Status:** Accepted

## Context

The original platform vision called for a "knowledge graph" as a distinct technology (implicitly Neo4j-class). ORA's actual entity count (properties, tenants, leases, vendors, loans — a few thousand nodes over the life of the firm) and query patterns (2-3 hop joins: "which vendors worked at which properties owned by which entity") do not approach the scale or traversal complexity where a dedicated graph database earns its operational cost. The [[procurement-stance-deepen-not-migrate]] doctrine (deepen the existing stack below $150M AUM rather than adopt new institutional-grade infrastructure) applies directly.

## Decision

Facts and relationships are stored as ordinary relational tables (`facts`, `edges`) inside the existing SQLite warehouse, queried via SQL joins and recursive CTEs. No graph database is introduced.

## Consequences

- All "knowledge graph" language in planning docs means "the edges table," not a new system to operate, back up, and secure.
- Complex multi-hop queries will be written as recursive CTEs, which are less ergonomic than native graph traversal — an accepted tradeoff at this scale.
- Revisit only if ORA's portfolio and entity count grow an order of magnitude (roughly: past $150M AUM, or a query pattern emerges that SQL genuinely cannot express efficiently). Migrating a live, source-cited fact store to a different storage engine later is expensive — this decision should not be revisited casually.
