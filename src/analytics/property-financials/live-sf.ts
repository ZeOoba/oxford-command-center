// src/analytics/property-financials/live-sf.ts
//
// Live square footage for the Property Financials module (plan T9b, part 2) — the one place that
// decides which SF a $/SF figure divides by.
//
// The dataset carries a static `sf` block (Master Workbook read on 2026-10-02, curated/sf.json). The
// server adds a `liveSf` block to GET /dataset (server/property-financials/live-sf.ts builds it from
// the Spine A snapshot — the live Master Workbook parse — WITHOUT touching the dataset). This module
// holds the shared shape of that block and the preference rule, applied by the client in exactly one
// place (PropertyFinancialsModule, before any view sees the dataset):
//
//   use the LIVE value for an entity only when the block is PRESENT, from Spine A, FRESH (its
//   workbook as-of date is at most LIVE_SF_STALE_DAYS behind today) and the entity's field is live;
//   otherwise keep the dataset's static value.
//
// `applyLiveSf` returns a dataset of the same contract shape (sf entries + properties[id].sf /
// leased_sf / occupancy) so every existing view and the per-SF calc (metrics.ts perSf) keep working
// unchanged; `sfProvenance` lists, per entity, where each shown SF came from for the data-health panel.
import { PF_ENTITY_IDS, type PfDataset, type PfEntityId, type PfSfEntry } from '../../contracts/property-financials';

/** Freshness canon: a source more than 7 days behind the live workbook is STALE. */
export const LIVE_SF_STALE_DAYS = 7;

export type PfSfFieldSource = 'live' | 'static' | 'none';
export type PfLiveSfSource = 'spine-a' | 'static-dataset';

export interface PfLiveSfEntry {
  readonly entity: string;
  readonly canonicalId: string | null;
  readonly mappingMethod: 'exact' | 'inferred' | 'unmatched';
  readonly sf: number | null;
  readonly leasedSf: number | null;
  readonly occupancy: number | null;
  readonly tenants: number | null;
  /** Where each field's value came from. */
  readonly fields: { readonly sf: PfSfFieldSource; readonly leasedSf: PfSfFieldSource; readonly occupancy: PfSfFieldSource };
  readonly note: string | null;
}

export interface PfLiveSfBlock {
  readonly source: PfLiveSfSource;
  /** Human label, e.g. "Master Workbook (live Spine A) as of 2026-10-05" or "static dataset (2026-10-02)". */
  readonly label: string;
  /** The source's own data date (workbook as-of, or the static read date). */
  readonly asOf: string | null;
  /** Whole days from asOf to today. */
  readonly ageDays: number | null;
  readonly staleDays: number;
  readonly stale: boolean;
  readonly staleReason: string | null;
  /** How leased SF is derived from the live source. */
  readonly leasedSfBasis: string;
  readonly entries: Readonly<Record<string, PfLiveSfEntry>>;
}

/** The live block is usable for figures only when it is Spine A and fresh. */
export function liveSfUsable(block: PfLiveSfBlock | null | undefined): block is PfLiveSfBlock {
  return !!block && block.source === 'spine-a' && !block.stale;
}

function liveSourceText(block: PfLiveSfBlock): string {
  // Shaped like the static `source` strings so explorer-model's sfSourceNote (file before ':', "as of
  // YYYY-MM-DD") reads it the same way.
  return `${block.label.split(' as of ')[0]!}: Property NOI (SF, occupancy) and Master Tenant Rent Roll (leased SF = ${block.leasedSfBasis})${block.asOf ? ` as of ${block.asOf}` : ''}`;
}

/**
 * The dataset with live SF applied where usable. Pure; never mutates the input. The result still
 * satisfies the strict contract (same keys, same types): only values change.
 */
export function applyLiveSf(dataset: PfDataset, block: PfLiveSfBlock | null | undefined): PfDataset {
  if (!liveSfUsable(block)) return dataset;
  const sf: Record<string, PfSfEntry> = { ...dataset.sf };
  const properties = { ...dataset.properties } as Record<string, PfDataset['properties'][PfEntityId]>;
  let changed = false;
  for (const id of PF_ENTITY_IDS) {
    const live = block.entries[id];
    const base = dataset.sf[id];
    if (!live || live.fields.sf !== 'live' || live.sf === null || live.sf <= 0) continue;
    // ONE basis for leased SF and occupancy: with live leased SF, occupancy is derived from it (the
    // Spine A occPct is a separate figure, surfaced by occupancyBasis when it disagrees, never mixed
    // in); without it, the dataset's own leased SF / occupancy pair stays together.
    const liveLeased = live.fields.leasedSf === 'live' && live.leasedSf !== null;
    const leased = liveLeased ? live.leasedSf! : base.leased_sf;
    const occ = liveLeased ? derivedOcc(live.leasedSf!, live.sf - (base.common_area_sf ?? 0)) : base.occ;
    const entry: PfSfEntry = {
      ...base,
      sf: live.sf,
      ...(leased !== undefined ? { leased_sf: leased } : {}),
      ...(occ !== undefined ? { occ } : {}),
      ...(live.tenants !== null ? { tenants: live.tenants } : {}),
      source: liveSourceText(block),
    };
    sf[id] = entry;
    const p = properties[id]!;
    properties[id] = {
      ...p,
      sf: live.sf,
      ...(leased !== undefined ? { leased_sf: leased } : {}),
      ...(occ !== undefined ? { occupancy: occ } : {}),
    } as typeof p;
    changed = true;
  }
  return changed ? { ...dataset, sf: sf as PfDataset['sf'], properties: properties as PfDataset['properties'] } : dataset;
}

/** Occupancy figures more than half a point apart are two different stories, not rounding. */
export const OCC_BASIS_TOLERANCE = 0.005;

function derivedOcc(leased: number, leasable: number): number | undefined {
  return leasable > 0 ? Math.min(1, Math.max(0, leased / leasable)) : undefined;
}

export interface OccupancyBasis {
  readonly leased: number;
  /** Total SF less common area. */
  readonly leasable: number;
  /** leased / leasable, clamped to 0-1: the ONE occupancy the module prints. */
  readonly occ: number;
  readonly unleased: number;
  /** A second occupancy figure that disagrees beyond OCC_BASIS_TOLERANCE (shown as a disagreement, never as the figure). */
  readonly conflict: { readonly otherOcc: number; readonly source: string } | null;
}

/**
 * Occupancy on ONE basis: leased SF over leasable SF (total less common area). Flags a conflict when
 * the entry's stored occupancy, or (live leased SF) the Spine A Property NOI occupancy, differs by
 * more than OCC_BASIS_TOLERANCE. Null when the entity has no SF or no leased SF on file.
 */
export function occupancyBasis(entry: PfSfEntry, live?: PfLiveSfEntry | null): OccupancyBasis | null {
  if (entry.sf === null || entry.leased_sf === undefined) return null;
  const leasable = entry.sf - (entry.common_area_sf ?? 0);
  const occ = derivedOcc(entry.leased_sf, leasable);
  if (occ === undefined) return null;
  const far = (x: number) => Math.abs(x - occ) > OCC_BASIS_TOLERANCE;
  let conflict: OccupancyBasis['conflict'] = null;
  if (entry.occ !== undefined && far(entry.occ)) conflict = { otherOcc: entry.occ, source: 'occupancy on file' };
  else if (live && live.fields.leasedSf === 'live' && live.fields.occupancy === 'live' && live.occupancy !== null && far(live.occupancy))
    conflict = { otherOcc: live.occupancy, source: 'Property NOI occupancy (Spine A)' };
  return { leased: entry.leased_sf, leasable, occ, unleased: Math.max(0, leasable - entry.leased_sf), conflict };
}

export interface PfSfProvenanceRow {
  readonly entity: PfEntityId;
  /** The SF the module is using right now (after the preference rule). */
  readonly sf: number | null;
  readonly leasedSf: number | null;
  readonly occupancy: number | null;
  /** 'live' when the shown figures come from Spine A; 'static' when from the dataset; 'none' when the entity has no SF. */
  readonly using: PfSfFieldSource;
  readonly fields: PfLiveSfEntry['fields'] | null;
  readonly source: string;
  readonly asOf: string | null;
  readonly stale: boolean;
  readonly note: string | null;
  /** A second occupancy figure that disagrees with leased SF / leasable SF (occupancyBasis), or null. */
  readonly occupancyConflict: OccupancyBasis['conflict'];
}

/** Per entity: which SF the module shows and where it came from — for the data-health panel. */
export function sfProvenance(dataset: PfDataset, block: PfLiveSfBlock | null | undefined): PfSfProvenanceRow[] {
  const usable = liveSfUsable(block);
  const staticDate = staticSfDate(dataset);
  const effective = applyLiveSf(dataset, block);
  return PF_ENTITY_IDS.map((entity) => {
    const live = block?.entries[entity] ?? null;
    const eff = effective.sf[entity];
    const liveUsed = usable && live !== null && live.fields.sf === 'live' && live.sf !== null && live.sf > 0;
    const using: PfSfFieldSource = eff.sf === null ? 'none' : liveUsed ? 'live' : 'static';
    return {
      entity,
      sf: eff.sf,
      leasedSf: eff.leased_sf ?? null,
      occupancy: eff.occ ?? null,
      using,
      fields: liveUsed ? live.fields : null,
      source: liveUsed ? block.label : eff.sf === null ? 'not applicable' : `static dataset (${staticDate ?? dataset.meta.generated})`,
      asOf: liveUsed ? block.asOf : eff.sf === null ? null : staticDate,
      stale: liveUsed ? block.stale : !!block && block.source === 'spine-a' && block.stale,
      note: live?.note ?? (block && block.source === 'spine-a' && block.stale ? block.staleReason : null),
      occupancyConflict: occupancyBasis(eff, usable ? live : null)?.conflict ?? null,
    };
  });
}

/** The static block's read date, from its `source` strings ("... as of 2026-10-02"). */
export function staticSfDate(dataset: PfDataset): string | null {
  for (const id of PF_ENTITY_IDS) {
    const m = /as of (\d{4}-\d{2}-\d{2})/.exec(dataset.sf[id].source ?? '');
    if (m) return m[1]!;
  }
  return null;
}
