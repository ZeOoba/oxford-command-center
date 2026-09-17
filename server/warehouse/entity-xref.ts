// server/warehouse/entity-xref.ts
//
// Canonical identity across stores. This module stores and reads links; it does NOT normalize
// addresses — that is the lease-market module's normalizer (src/analytics/lease-market/
// normalize.ts, splitAddress), imported by the seeder rather than reimplemented. A second
// implementation that agrees with it today is precisely the drift this crosswalk exists to
// prevent, and that normalizer is actively changing.
//
// A wrong auto-link is worse than an unmatched row, because every later join inherits it
// silently, so anything short of an unambiguous match is reported to a human.
import { splitAddress } from '../../src/analytics/lease-market/normalize';
import type { WarehouseDb } from './db';

export type EntityType = 'property' | 'unit' | 'tenant' | 'lease';
export type MatchMethod = 'exact_id' | 'exact_address' | 'identity_key' | 'manual' | 'ambiguous';

export interface EntityLink {
  entityType: EntityType;
  canonicalId: string;
  system: string;
  externalId: string;
  matchMethod: MatchMethod;
  confidence?: number;
}

export interface UnmatchedRow {
  canonicalId: string;
  name: string;
}

export function linkEntity(db: WarehouseDb, link: EntityLink): void {
  const existing = db
    .prepare(
      'SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?',
    )
    .get(link.system, link.entityType, link.externalId) as { canonical_id: string } | undefined;

  if (existing) {
    if (existing.canonical_id !== link.canonicalId) {
      throw new Error(
        `${link.system}:${link.entityType}:${link.externalId} is already linked to ${existing.canonical_id} — ` +
          `refusing to repoint it at ${link.canonicalId}; resolve by hand and record the change in audit_log`,
      );
    }
    return;
  }

  db.prepare(
    `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    link.entityType,
    link.canonicalId,
    link.system,
    link.externalId,
    link.matchMethod,
    link.confidence ?? 1.0,
  );
}

export function canonicalIdFor(
  db: WarehouseDb,
  system: string,
  entityType: EntityType,
  externalId: string,
): string | null {
  const row = db
    .prepare(
      'SELECT canonical_id FROM entity_xref WHERE system = ? AND entity_type = ? AND external_id = ?',
    )
    .get(system, entityType, externalId) as { canonical_id: string } | undefined;
  return row?.canonical_id ?? null;
}

export function unmatchedReport(db: WarehouseDb, entityType: EntityType): UnmatchedRow[] {
  if (entityType !== 'property') return [];
  return db
    .prepare(
      `SELECT pm.id AS canonicalId, pm.name AS name
         FROM property_master pm
        WHERE NOT EXISTS (
              SELECT 1 FROM entity_xref x
               WHERE x.entity_type = 'property' AND x.canonical_id = pm.id)
        ORDER BY pm.id`,
    )
    .all() as UnmatchedRow[];
}

// ---------------------------------------------------------------------------
// Lease-market crosswalk seeding.
//
// AUTHORITY (ratified by Gabriel 2026-09-17): config/lease-market.json's `oraProperties` is the
// authority on which listing is an ORA building. Its decision reaches us as a non-null
// `lm_property.ora_property_key`. This seeder MIRRORS that decision into entity_xref and PROPOSES
// everything else for a human to promote into the config — it never invents a link from an address
// match alone. Two auto-linkers disagreeing is the drift this crosswalk exists to eliminate.
//
// Three id spaces name the same building and none of them agree:
//   warehouse  property_master.id      e.g. '1100-rarig-ave-columbus-oh'   (canonical)
//   lease_market lm_property.id        an integer surrogate
//   workbook   Lease.propertyKey       the raw rent-roll label the config speaks
// property_master carries no rent-roll key, so every path grounds out in an address comparison —
// which is why the one-to-one-in-both-directions rule below is the whole safety story.

/** Why a row was not linked. Each is a human action, not an error. */
export type ProposalReason = 'no_config_link' | 'ambiguous_address' | 'no_address_match';

export interface XrefProposal {
  lmPropertyId: number;
  marketId: string;
  addressNorm: string;
  oraPropertyKey: string | null;
  candidateCanonicalIds: string[];
  reason: ProposalReason;
}

export interface SeedResult {
  linked: number;
  proposed: XrefProposal[];
  skipped: string[];
}

interface LmPropertyRow {
  id: number;
  market_id: string;
  address_norm: string;
  ora_property_key: string | null;
}

function tableExists(db: WarehouseDb, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

const marketKey = (market: string | null): string => (market ?? '').trim().toLowerCase();

/**
 * Mirror config-blessed lease-market links into entity_xref; report everything else.
 * Feature-detects `lm_property` so it is safe to run before migration 029 has been applied.
 */
export function seedFromLeaseMarket(db: WarehouseDb): SeedResult {
  if (!tableExists(db, 'lm_property')) {
    return { linked: 0, proposed: [], skipped: ['lm_property table absent'] };
  }

  // Index warehouse properties by market + normalized address, using the lease-market module's
  // OWN normalizer on both sides so the two can never drift apart (see the header note).
  const byAddress = new Map<string, string[]>();
  const properties = db
    .prepare('SELECT id, market, address FROM property_master WHERE address IS NOT NULL')
    .all() as Array<{ id: string; market: string | null; address: string }>;
  for (const p of properties) {
    const { addressNorm } = splitAddress(p.address, null);
    if (!addressNorm) continue;
    const key = `${marketKey(p.market)}|${addressNorm}`;
    byAddress.set(key, [...(byAddress.get(key) ?? []), p.id]);
  }

  const lmRows = db
    .prepare('SELECT id, market_id, address_norm, ora_property_key FROM lm_property')
    .all() as LmPropertyRow[];

  // The reverse direction: two listings at one address must not both claim the same property.
  const lmPerKey = new Map<string, number>();
  for (const r of lmRows) {
    const key = `${marketKey(r.market_id)}|${r.address_norm}`;
    lmPerKey.set(key, (lmPerKey.get(key) ?? 0) + 1);
  }

  let linked = 0;
  const proposed: XrefProposal[] = [];
  const skipped: string[] = [];

  for (const r of lmRows) {
    const key = `${marketKey(r.market_id)}|${r.address_norm}`;
    const candidates = byAddress.get(key) ?? [];
    const base = {
      lmPropertyId: r.id,
      marketId: r.market_id,
      addressNorm: r.address_norm,
      oraPropertyKey: r.ora_property_key,
    };

    if (candidates.length === 0) {
      proposed.push({ ...base, candidateCanonicalIds: [], reason: 'no_address_match' });
      continue;
    }
    if (candidates.length > 1 || (lmPerKey.get(key) ?? 0) > 1) {
      proposed.push({
        ...base,
        candidateCanonicalIds: [...candidates].sort(),
        reason: 'ambiguous_address',
      });
      continue;
    }

    const canonicalId = candidates[0]!;
    if (r.ora_property_key === null) {
      // Unambiguous, but no human has blessed it. Propose; do not link.
      proposed.push({ ...base, candidateCanonicalIds: [canonicalId], reason: 'no_config_link' });
      continue;
    }

    try {
      linkEntity(db, {
        entityType: 'property',
        canonicalId,
        system: 'lease_market',
        externalId: String(r.id),
        matchMethod: 'manual',
      });
      linkEntity(db, {
        entityType: 'property',
        canonicalId,
        system: 'workbook',
        externalId: r.ora_property_key,
        matchMethod: 'manual',
      });
      linked += 1;
    } catch (err) {
      // A conflicting pre-existing link is a human decision to reconcile, not a reason to abort
      // the whole seed and lose every other row's result.
      skipped.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { linked, proposed, skipped };
}
