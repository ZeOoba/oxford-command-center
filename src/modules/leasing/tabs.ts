// Leasing destination tab declaration (IA decongestion Phase 4d). React-free so the registry and the
// palette can index tabs without importing LeaseForecastModule's chunk. Leases (as "Rent roll") and
// Tenants are absorbed here; Rollover · Forecast · Market rents are the original Leasing Intelligence
// tabs. Rollover is the default (first) tab — a 140-row rent roll is not a landing view.
import { useCriticalDatesTabBadge } from '@/shell/tab-badges';
import type { ModuleTabDef } from '@/shell/tab-types';

export type LeasingTab = 'rollover' | 'rent-roll' | 'forecast' | 'market-rents' | 'tenants';

export const LEASING_TABS: readonly ModuleTabDef[] = [
  { id: 'rollover', label: 'Rollover', aliases: ['expiries', 'expirations', 'velocity'] },
  { id: 'rent-roll', label: 'Rent roll', aliases: ['leases', 'critical dates'], useBadge: useCriticalDatesTabBadge },
  { id: 'forecast', label: 'Forecast', aliases: ['rent forecast'] },
  { id: 'market-rents', label: 'Market rents' },
  { id: 'tenants', label: 'Tenants', aliases: ['tenant risk'] },
];

export const LEASING_TAB_KEYS = LEASING_TABS.map((t) => t.id) as readonly LeasingTab[];

/** Tabs backed by the lease-forecast warehouse route (Rule G: the offline gate and the expiry-bucket
 *  cards are scoped to these — Rent roll and Tenants read the snapshot and work on the static mirror). */
export const LEASING_FORECAST_TABS: ReadonlySet<LeasingTab> = new Set<LeasingTab>(['rollover', 'forecast', 'market-rents']);
