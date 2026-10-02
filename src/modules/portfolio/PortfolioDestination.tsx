import { lazy, type ComponentType } from 'react';
import { Destination } from '@/shell/Destination';
import type { ModuleTabDef } from '@/shell/tab-types';
import { PORTFOLIO_TABS, type PortfolioTab } from './tabs';

const PANELS: Record<PortfolioTab, ComponentType> = {
  properties: lazy(() => import('./PortfolioModule').then((m) => ({ default: m.PortfolioModule }))),
  trends: lazy(() => import('./TrendsView').then((m) => ({ default: m.TrendsView }))),
};

const TABS: readonly ModuleTabDef[] = PORTFOLIO_TABS.map((t) => ({ ...t, Component: PANELS[t.id as PortfolioTab] }));

export function PortfolioDestination() {
  return <Destination id="portfolio" label="Portfolio" tabs={TABS} />;
}
