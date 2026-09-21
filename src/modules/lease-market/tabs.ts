// Lease Market destination tab declaration (registered in IA decongestion Phase 4 finalize).
// JSX-free / no module-chunk imports, so the registry and the command palette can index these tabs
// — as "Lease Market > Tab" entries — without pulling LeaseMarketModule's chunk into the entry
// bundle. Lease Market sits AT the 5-tab house cap, so the registry declaration is also what lets
// `tabCapViolation` / ia-registry.test.ts see it at all. The ids are the existing `?tab=` deep
// links; do not rename them.
import type { ModuleTabDef } from '@/shell/tab-types';

export type LeaseMarketTab = 'portfolio' | 'market-rents' | 'radar' | 'changes' | 'data-quality';

export const LEASE_MARKET_TABS: readonly ModuleTabDef[] = [
  { id: 'portfolio', label: 'Portfolio', aliases: ['positioning', 'our asking rents', 'gap to market'] },
  { id: 'market-rents', label: 'Market Rents', aliases: ['comps', 'benchmarks', 'rent curve'] },
  { id: 'radar', label: 'Acquisition Radar', aliases: ['radar', 'candidates', 'owner screen'] },
  { id: 'changes', label: 'Changes', aliases: ['listing events', 'price cuts', 'signals'] },
  { id: 'data-quality', label: 'Data Quality', aliases: ['freshness', 'hygiene', 'stale listings'] },
];

export const LEASE_MARKET_TAB_KEYS = LEASE_MARKET_TABS.map((t) => t.id) as readonly LeaseMarketTab[];
