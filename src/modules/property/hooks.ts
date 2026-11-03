// src/modules/property/hooks.ts
//
// Per-property series shared by the property page and the EntityDrawer (roadmap 2.2), so both read
// one derivation: the P&L-ledger months + trailing-12 NOI (entity 100%), and the lease-SF occupancy
// series (recorded months where the warehouse has them, else reconstructed from current leases).
import { useMemo } from 'react';
import type { PortfolioSnapshot, Property } from '@contracts/index';
import type { PfEntityId } from '@contracts/property-financials';
import { buildPortfolioTrend } from '@analytics/portfolio-trends';
import { usePfDataset } from '../property-financials/hooks';
import { mergeRecorded, useTrendsHistory, type SourcedMonthPoint } from '../portfolio/trends-history';
import { ledgerMonths, pfEntityFor, rollingT12, type LedgerMonth } from './property-page-model';

export interface PropertyLedger {
  entity: PfEntityId;
  months: LedgerMonth[];
  t12: { month: string; value: number }[];
  /** The dataset's SF for the entity (null when it has none, e.g. the solar entity). */
  sf: number | null;
}

/** Null while loading, when the dataset is unavailable, or when no PF entity maps to the property. */
export function usePropertyLedger(propertyId: string): PropertyLedger | null {
  const pf = usePfDataset();
  return useMemo(() => {
    const d = pf.data?.dataset;
    const entity = pfEntityFor(pf.data?.liveSf?.entries, propertyId) as PfEntityId | null;
    if (!d || !entity) return null;
    const cube = (d.monthly as Partial<Record<string, Parameters<typeof ledgerMonths>[0]>>)[entity];
    const months = ledgerMonths(cube);
    return { entity, months, t12: rollingT12(months), sf: d.sf[entity]?.sf ?? null };
  }, [pf.data, propertyId]);
}

export interface PropertyOccupancy {
  /** Past and as-of months only (forecast months dropped). */
  points: SourcedMonthPoint[];
  recordedMonths: number;
}

export function usePropertyOccupancy(snapshot: PortfolioSnapshot | undefined, property: Property | null): PropertyOccupancy | null {
  const history = useTrendsHistory();
  return useMemo(() => {
    if (!snapshot || !property) return null;
    const trend = buildPortfolioTrend(snapshot.leases, snapshot.properties, { asOf: snapshot.meta.asOf });
    const base = trend.byProperty[property.id];
    if (!base) return null;
    const recorded = history.isError ? [] : history.data?.points ?? [];
    const points = mergeRecorded(base, recorded, { propertyIds: Object.keys(trend.byProperty), propertyId: property.id }).filter(
      (p) => !p.isForecast,
    );
    return { points, recordedMonths: points.filter((p) => p.source === 'recorded').length };
  }, [snapshot, property, history.isError, history.data]);
}
