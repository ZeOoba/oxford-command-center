import type { ModuleTabDef } from '@/shell/tab-types';

export type PortfolioTab = 'properties' | 'trends' | 'expenses';

export const PORTFOLIO_TABS: readonly ModuleTabDef[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'trends', label: 'Trends' },
  { id: 'expenses', label: 'Expenses' },
];
