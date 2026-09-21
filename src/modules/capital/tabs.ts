// Capital destination tab declaration (IA decongestion Phase 4b). React-free so the registry and the
// palette can index tabs without importing CapitalModule's chunk. Pipeline is today's second tab; it is
// replaced by a Capacity tab when 2026-09-18-capital-deployable-capacity.md lands (Capital stays at 5).
import type { ModuleTabDef } from '@/shell/tab-types';

export type CapitalTab = 'allocation' | 'pipeline' | 'debt' | 'cash' | 'close';

export const CAPITAL_TABS: readonly ModuleTabDef[] = [
  { id: 'allocation', label: 'Allocation' },
  { id: 'pipeline', label: 'Pipeline', aliases: ['buy pipeline'] },
  { id: 'debt', label: 'Debt', aliases: ['loans', 'maturities', 'balloon'] },
  { id: 'cash', label: 'Cash', aliases: ['treasury', 'liquidity'] },
  { id: 'close', label: 'Close', aliases: ['monthly close', 'month-end'] },
];

export const CAPITAL_TAB_KEYS = CAPITAL_TABS.map((t) => t.id) as readonly CapitalTab[];

/** The two warehouse-backed tabs (Rule G: their gates stay inside their own panels). */
export const CAPITAL_ALLOCATION_TABS: ReadonlySet<CapitalTab> = new Set<CapitalTab>(['allocation', 'pipeline']);
