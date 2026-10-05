// server/property-financials/live-sf.ts
//
// Live square footage from Spine A (plan T9b, part 2). Reads the EXISTING PortfolioSnapshot — the
// Master Workbook parse the Brain Server already holds (server/brain.ts getSnapshot(); produced by
// server/workbook/parse.ts) — and never a second workbook parser, never the workbook file, never a
// write. Per dataset entity it resolves the canonical property through the ratified mapping table
// (mapping.ts ENTITY_TO_CANONICAL) and reports:
//
//   sf         Property.sf          (Property NOI sheet, total SF)
//   occupancy  Property.occPct      (Property NOI sheet)
//   tenants    Property.tenantCount
//   leasedSf   sum of Lease.sf over the property's leases with status Active or Expiring Soon
//              (Master Tenant Rent Roll). Spine A has no "Occupied" class: the rent roll's status
//              column yields Active / Expiring Soon / Expired / Vacant / Unknown, so notice-given
//              space still counts as leased here until the roll re-statuses it (the static dataset
//              excluded it by hand — Red Branch's 5,000 SF). Said plainly in `leasedSfBasis`.
//
// Freshness canon: the block is STALE when the workbook's own as-of date (snapshot.meta.asOf) is
// more than LIVE_SF_STALE_DAYS (7) behind today. When no snapshot is available the block falls back
// to the dataset's static sf block and says so ("static dataset (2026-10-02)"). The client applies
// the preference (src/analytics/property-financials/live-sf.ts applyLiveSf): live only when present,
// Spine A and fresh — so a stale live read is shown for information but never divides a figure.
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { PF_ENTITY_IDS, type PfDataset } from '../../src/contracts/property-financials';
import { LIVE_SF_STALE_DAYS, staticSfDate, type PfLiveSfBlock, type PfLiveSfEntry, type PfSfFieldSource } from '../../src/analytics/property-financials/live-sf';
import { ageDaysFrom } from './loader';
import { ENTITY_TO_CANONICAL } from './mapping';

/** Rent-roll statuses that mean the suite is leased today. */
export const LEASED_STATUSES: ReadonlySet<string> = new Set(['Active', 'Expiring Soon']);

export const LEASED_SF_BASIS = 'Spine A leases with status Active or Expiring Soon (the rent roll has no "Occupied" class; notice-given space counts as leased until re-statused)';

/** Snapshot slice this module reads — kept narrow so tests build it by hand. */
export type LiveSfSnapshot = Pick<PortfolioSnapshot, 'meta' | 'properties' | 'leases'>;

const isoDay = (s: string): string | null => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function staticEntry(entity: string, dataset: PfDataset | null, canonicalId: string | null, method: PfLiveSfEntry['mappingMethod'], note: string | null): PfLiveSfEntry {
  const s = dataset?.sf[entity as (typeof PF_ENTITY_IDS)[number]];
  const has = !!s && s.sf !== null;
  const src: PfSfFieldSource = has ? 'static' : 'none';
  return {
    entity,
    canonicalId,
    mappingMethod: method,
    sf: has ? s.sf : null,
    leasedSf: has && s.leased_sf !== undefined ? s.leased_sf : null,
    occupancy: has && s.occ !== undefined ? s.occ : null,
    tenants: has && s.tenants !== undefined ? s.tenants : null,
    fields: { sf: src, leasedSf: has && s.leased_sf !== undefined ? 'static' : 'none', occupancy: has && s.occ !== undefined ? 'static' : 'none' },
    note,
  };
}

/** Build the live-SF block from the snapshot (or the static fallback when there is none). Pure. */
export function buildLiveSf(snapshot: LiveSfSnapshot | null, dataset: PfDataset | null, now: Date): PfLiveSfBlock {
  const staticDate = dataset ? staticSfDate(dataset) : null;
  const staticLabel = `static dataset (${staticDate ?? dataset?.meta.generated ?? 'unknown date'})`;

  if (!snapshot) {
    const ageDays = staticDate ? ageDaysFrom(staticDate, now) : null;
    const entries: Record<string, PfLiveSfEntry> = {};
    for (const entity of PF_ENTITY_IDS) {
      const m = ENTITY_TO_CANONICAL[entity];
      entries[entity] = staticEntry(entity, dataset, m?.id ?? null, m?.method ?? 'unmatched', null);
    }
    return {
      source: 'static-dataset',
      label: staticLabel,
      asOf: staticDate,
      ageDays,
      staleDays: LIVE_SF_STALE_DAYS,
      stale: ageDays !== null && ageDays > LIVE_SF_STALE_DAYS,
      staleReason: 'live Master Workbook unavailable: the Brain Server holds no snapshot (not parsed yet, or running off the mirror)',
      leasedSfBasis: 'static dataset: rent-roll rows classed "Occupied" on the read date',
      entries,
    };
  }

  const asOf = isoDay(snapshot.meta.asOf);
  const ageDays = asOf ? ageDaysFrom(asOf, now) : null;
  const stale = ageDays === null || ageDays > LIVE_SF_STALE_DAYS;
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  const leasedByProperty = new Map<string, { sf: number; n: number }>();
  for (const l of snapshot.leases) {
    if (l.propertyId === null || !LEASED_STATUSES.has(l.status)) continue;
    const cur = leasedByProperty.get(l.propertyId) ?? { sf: 0, n: 0 };
    cur.sf += l.sf;
    cur.n++;
    leasedByProperty.set(l.propertyId, cur);
  }

  const entries: Record<string, PfLiveSfEntry> = {};
  for (const entity of PF_ENTITY_IDS) {
    const m = ENTITY_TO_CANONICAL[entity];
    const property = m ? byId.get(m.id) : undefined;
    if (!m || !property) {
      entries[entity] = staticEntry(entity, dataset, m?.id ?? null, m?.method ?? 'unmatched', m ? `canonical id ${m.id} is not in the live snapshot; static value shown` : 'no ratified canonical mapping; static value shown');
      continue;
    }
    if (!(property.sf > 0)) {
      entries[entity] = staticEntry(entity, dataset, m.id, m.method, 'live property has no building SF (not applicable)');
      continue;
    }
    const leased = leasedByProperty.get(m.id) ?? null;
    const notes: string[] = [];
    if (m.method === 'inferred') notes.push('entity -> canonical mapping is inferred (FVC = Sepich portfolio); confirm');
    if (leased === null) notes.push('no Active / Expiring Soon leases resolved to this property in the live rent roll; leased SF falls back to the static dataset');
    const fallback = staticEntry(entity, dataset, m.id, m.method, null);
    entries[entity] = {
      entity,
      canonicalId: m.id,
      mappingMethod: m.method,
      sf: property.sf,
      leasedSf: leased ? Math.round(leased.sf) : fallback.leasedSf,
      occupancy: property.occPct,
      tenants: leased ? leased.n : property.tenantCount,
      fields: { sf: 'live', leasedSf: leased ? 'live' : fallback.fields.leasedSf, occupancy: 'live' },
      note: notes.length ? notes.join('; ') : null,
    };
  }
  return {
    source: 'spine-a',
    label: `Master Workbook (live Spine A)${asOf ? ` as of ${asOf}` : ''}`,
    asOf,
    ageDays,
    staleDays: LIVE_SF_STALE_DAYS,
    stale,
    staleReason: stale
      ? asOf === null
        ? 'the live snapshot carries no readable as-of date'
        : `the live workbook's as-of date ${asOf} is ${ageDays} day(s) old (> ${LIVE_SF_STALE_DAYS}); figures use the static dataset`
      : null,
    leasedSfBasis: LEASED_SF_BASIS,
    entries,
  };
}
