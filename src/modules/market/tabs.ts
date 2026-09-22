// Market destination tab declaration (IA decongestion Phase 4c). React-free so the registry and the
// palette can index tabs without importing MarketModule's chunk. Demand absorbed the standalone
// `prospect-demand` module (legacy id aliases here: src/brain/routing.ts LEGACY_ALIASES).
import type { ModuleTabDef } from '@/shell/tab-types';

export type MarketTab = 'macro' | 'scorecards' | 'comps' | 'demand';

export const MARKET_TABS: readonly ModuleTabDef[] = [
  { id: 'macro', label: 'Macro' },
  { id: 'scorecards', label: 'Scorecards' },
  { id: 'comps', label: 'Comps' },
  { id: 'demand', label: 'Demand', aliases: ['demand signals', 'prospects', 'showings'] },
];

export const MARKET_TAB_KEYS = MARKET_TABS.map((t) => t.id) as readonly MarketTab[];
