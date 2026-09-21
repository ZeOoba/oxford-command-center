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
export type ProposalReason =
  | 'city_unverifiable'
  | 'ora_owned_unmapped'
  | 'no_config_link'
  | 'ambiguous_address'
  | 'state_unverifiable'
  | 'no_address_match';

export interface XrefProposal {
  lmPropertyId: number;
  marketId: string;
  addressNorm: string;
  oraPropertyKey: string | null;
  ownerType: string;
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
  city_norm: string;
  state: string | null;
  ora_property_key: string | null;
  owner_type: string;
}

/** The warehouse has no city column. The canonical id is a slug that usually ENDS with the city
 *  and state (`1100-rarig-ave-columbus-oh`), so it is the only city evidence available — and it
 *  is evidence, not a parser: a slug that is not an address (`sepich-portfolio-columbus-oh-8-props`)
 *  simply fails to confirm, which is the safe direction. */
function canConfirmCity(cityNorm: string, canonicalId: string): boolean {
  const city = cityNorm.trim().toLowerCase().replace(/\s+/g, '-');
  return city !== '' && canonicalId.toLowerCase().includes(`-${city}-`);
}

function tableExists(db: WarehouseDb, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) !== undefined
  );
}

const marketKey = (market: string | null): string => (market ?? '').trim().toLowerCase();

const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
// A trailing two-letter state token set off by a space or comma: 'Columbus OH', 'Kansas City, MO'.
// Requires the separator, so a hyphenated region such as 'Mid-Atlantic' is left intact.
const TRAILING_STATE = /[,\s]+[A-Za-z]{2}$/;

const marketSlug = (label: string): string =>
  label.toLowerCase().replace(NON_ALNUM_RUN, '-').replace(EDGE_DASHES, '');

/**
 * The lease-market ids a warehouse `property_master.market` label could denote.
 *
 * The two id spaces use different vocabularies and never agreed: property_master says 'Columbus OH',
 * 'Kansas City MO', 'Mid-Atlantic' (display labels, seeded in property-master.ts) while
 * lm_property.market_id says 'columbus', 'kansas-city', 'eastern-shore-md' (config/lease-market.json
 * ids). Comparing them through a case-fold alone meant 'columbus oh' never equalled 'columbus', so in
 * production EVERY listing fell to 'no_address_match' — even a config-blessed one with an exact address
 * match — while the tests passed because their fixtures wrote the market as 'Columbus'. Two candidates
 * because the state suffix is sometimes part of the id ('eastern-shore-md') and sometimes not
 * ('columbus'); the property is indexed under both and only ever matches the listing's own market_id.
 * A region label that names several lease-market ids ('Mid-Atlantic' spans baltimore and
 * eastern-shore-md) resolves to none, which reports as unmatched — the safe direction.
 */
export function marketIdCandidates(label: string | null): string[] {
  return marketCandidates(label).map((c) => c.id);
}

interface MarketCandidate {
  id: string;
  /** Set when this id was reached by DROPPING a trailing state token ('oh' for 'Columbus OH'). */
  state: string | null;
}

function marketCandidates(label: string | null): MarketCandidate[] {
  const trimmed = (label ?? '').trim();
  if (trimmed === '') return [{ id: '', state: null }];
  const full = marketSlug(trimmed);
  const stateMatch = TRAILING_STATE.exec(trimmed);
  const stripped = marketSlug(trimmed.replace(TRAILING_STATE, ''));
  const out: MarketCandidate[] = [];
  if (full !== '') out.push({ id: full, state: null });
  if (stripped !== '' && stripped !== full) {
    out.push({ id: stripped, state: stateMatch ? marketSlug(stateMatch[0]) : null });
  }
  return out;
}

/**
 * Dropping the state makes 'Columbus OH' and 'Columbus IN' (or 'Richmond VA' / 'Richmond IN') collapse
 * onto ONE lease-market id, and the address + city guards cannot tell them apart. So a property indexed
 * under a state-stripped id is only a candidate for a listing whose own `lm_property.state` equals the
 * state that was dropped; a listing with no state cannot confirm it and stays unmatched -- the safe
 * direction ("a wrong auto-link is worse than an unmatched row").
 */
const stateMatches = (lmState: string | null, required: string | null): boolean =>
  required === null || (lmState !== null && lmState === required);

/** A listing's own state, but only when it is a two-letter code ('OH', ' oh '). 'Ohio', a zip, or
 *  'OH-Franklin' would otherwise REFUSE a valid match while the address agreed; they count as unknown
 *  and fall back to the configured market's state instead. */
const twoLetterState = (s: string | null): string | null => {
  const t = (s ?? '').trim();
  return /^[A-Za-z]{2}$/.test(t) ? t.toLowerCase() : null;
};

/**
 * market id -> two-letter state, from config/lease-market.json `markets[].costarMarketNames`
 * ('Columbus, OH' -> columbus: 'oh'). lm_property.state is NULL for every row the shipped CoStar header
 * map produces (its `state` column is unmapped), so the listing's own state cannot be the evidence in
 * production; the configured market is. A market whose names carry more than one state, or none, is
 * left out and its state-stripped matches stay unverifiable.
 */
export function marketStatesFromConfig(
  markets: ReadonlyArray<{ id: string; costarMarketNames: readonly string[] }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of markets) {
    const states = new Set(
      m.costarMarketNames
        .map((n) => /,\s*([A-Za-z]{2})\s*$/.exec(n.trim())?.[1]?.toLowerCase())
        .filter((s): s is string => s !== undefined),
    );
    if (states.size === 1) out[m.id] = [...states][0]!;
  }
  return out;
}

export interface SeedOptions {
  /** market id -> state; consulted when a listing's own `state` is NULL (see marketStatesFromConfig). */
  marketStates?: Readonly<Record<string, string>>;
}

/** BOTH sides of every comparison go through this. Building the forward index from splitAddress
 *  output while counting the reverse direction on raw address_norm let case/whitespace variants
 *  land in different buckets, so the "two listings must not claim one property" guard silently
 *  passed. One function, both directions. `marketId` is an already-resolved lease-market id. */
const addressKey = (marketId: string, addressNorm: string): string =>
  `${marketId}|${addressNorm.trim().toUpperCase().replace(/\s+/g, ' ')}`;

/**
 * Mirror config-blessed lease-market links into entity_xref; report everything else.
 * Feature-detects `lm_property` so it is safe to run before migration 029 has been applied.
 */
export function seedFromLeaseMarket(db: WarehouseDb, opts: SeedOptions = {}): SeedResult {
  const marketStates = opts.marketStates ?? {};
  if (!tableExists(db, 'lm_property')) {
    return { linked: 0, proposed: [], skipped: ['lm_property table absent'] };
  }

  // Index warehouse properties by market + normalized address, using the lease-market module's
  // OWN normalizer on both sides so the two can never drift apart (see the header note).
  const skipped: string[] = [];
  const byAddress = new Map<string, Array<{ id: string; state: string | null }>>();
  const properties = db
    .prepare('SELECT id, market, address FROM property_master WHERE address IS NOT NULL')
    .all() as Array<{ id: string; market: string | null; address: string }>;
  for (const p of properties) {
    const { addressNorm } = splitAddress(p.address, null);
    if (!addressNorm) continue;
    for (const { id: marketId, state } of marketCandidates(p.market)) {
      const key = addressKey(marketId, addressNorm);
      byAddress.set(key, [...(byAddress.get(key) ?? []), { id: p.id, state }]);
    }
  }

  // A market like 'Columbus OH' spans dozens of municipalities, so market+address alone is NOT a
  // building-unique key. property_master carries no city column at all (001_initial.sql), which
  // is why this is reported rather than silently matched on the coarse key.
  if (byAddress.size === 0) {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM property_master').get() as { n: number })
      .n;
    skipped.push(
      `property_master has no usable address data (${total} rows, ${properties.length} with a ` +
        `non-empty address) — the crosswalk cannot match anything until addresses are populated`,
    );
  }

  const lmRows = db
    .prepare(
      'SELECT id, market_id, address_norm, city_norm, state, ora_property_key, owner_type FROM lm_property',
    )
    .all() as LmPropertyRow[];

  // The reverse direction: two listings at one address must not both claim the same property.
  const lmPerKey = new Map<string, number>();
  for (const r of lmRows) {
    const key = addressKey(marketKey(r.market_id), r.address_norm);
    lmPerKey.set(key, (lmPerKey.get(key) ?? 0) + 1);
  }

  let linked = 0;
  const proposed: XrefProposal[] = [];

  for (const r of lmRows) {
    const key = addressKey(marketKey(r.market_id), r.address_norm);
    const base = {
      lmPropertyId: r.id,
      marketId: r.market_id,
      addressNorm: r.address_norm,
      oraPropertyKey: r.ora_property_key,
      ownerType: r.owner_type,
    };
    const entries = byAddress.get(key) ?? [];
    // The listing's own state, else the configured market's. Unknown while some candidate was reached by
    // dropping a state is NOT "no match": surface it with the candidates listed for a human.
    const lmState = twoLetterState(r.state) ?? marketStates[marketKey(r.market_id)] ?? null;
    if (entries.length > 0 && lmState === null && entries.some((e) => e.state !== null)) {
      proposed.push({
        ...base,
        candidateCanonicalIds: [...new Set(entries.map((e) => e.id))].sort(),
        reason: 'state_unverifiable',
      });
      continue;
    }
    const candidates = [
      ...new Set(entries.filter((e) => stateMatches(lmState, e.state)).map((e) => e.id)),
    ];
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
    // Not `=== null`: the column is plain TEXT with no non-empty CHECK, and an empty or
    // whitespace key would write a junk crosswalk row that then poisons the namespace for every
    // later row through the repoint guard.
    // The lm row knows its municipality; the warehouse side does not. Rather than fuse two
    // different buildings that share a street address in one metro, refuse and report.
    if (r.city_norm.trim() !== '' && !canConfirmCity(r.city_norm, canonicalId)) {
      proposed.push({ ...base, candidateCanonicalIds: [canonicalId], reason: 'city_unverifiable' });
      continue;
    }

    const blessedKey = r.ora_property_key?.trim();
    if (!blessedKey) {
      // A null ora_property_key does NOT mean "not ORA". The key is stamped only where a listing's
      // address matches an addressNorms entry, so the config always lags reality —
      // lm_property.owner_type = 'affiliated' is the independent owner-name verdict, and the
      // lease-market compute treats it as ORA-owned everywhere the key gates. Reporting these as
      // ordinary unmatched listings would hide ORA buildings in a pile of third-party comps.
      proposed.push({
        ...base,
        candidateCanonicalIds: [canonicalId],
        reason: r.owner_type === 'affiliated' ? 'ora_owned_unmapped' : 'no_config_link',
      });
      continue;
    }

    try {
      // Atomic as a PAIR. Writing lease_market first and then failing on workbook left an orphan
      // half committed while the run reported the row as skipped — so the two directions
      // disagreed and the operator's report said nothing was written.
      db.transaction(() => {
        linkEntity(db, {
          entityType: 'property',
          canonicalId,
          system: 'lease_market',
          externalId: String(r.id),
          // Not 'manual': no human performed THIS link. The config blessing is human, the address
          // resolution is not, and an auditor asking "which links did a person make" must not get
          // auto-generated rows back.
          matchMethod: 'exact_address',
        });
        linkEntity(db, {
          entityType: 'property',
          canonicalId,
          system: 'workbook',
          externalId: blessedKey,
          matchMethod: 'exact_address',
        });
      })();
      linked += 1;
    } catch (err) {
      // A conflicting pre-existing link is a human decision to reconcile, not a reason to abort
      // the whole seed and lose every other row's result.
      skipped.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { linked, proposed, skipped };
}
