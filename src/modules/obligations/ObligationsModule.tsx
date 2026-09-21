// src/modules/obligations/ObligationsModule.tsx
//
// Obligations destination (IA decongestion Phase 4c): Insurance · Taxes — the two recurring-cost
// modules composed as tabs. Default tab: Insurance. Each tab body is the existing module, lazily
// loaded on first selection; inactive panels unmount. The insurance drawer (`/obligations/:id`)
// resolves on every tab (MODULE_PRIMARY_TYPE.obligations).
import { lazy, type ComponentType } from 'react';
import { Destination } from '@/shell/Destination';
import type { ModuleTabDef } from '@/shell/tab-types';
import { OBLIGATIONS_TABS, type ObligationsTab } from './tabs';

const PANELS: Record<ObligationsTab, ComponentType> = {
  insurance: lazy(() => import('@/modules/insurance/InsuranceModule').then((m) => ({ default: m.InsuranceModule }))),
  taxes: lazy(() => import('@/modules/taxes/TaxesModule').then((m) => ({ default: m.TaxesModule }))),
};

const TABS: readonly ModuleTabDef[] = OBLIGATIONS_TABS.map((t) => ({ ...t, Component: PANELS[t.id as ObligationsTab] }));

export function ObligationsModule() {
  return <Destination id="obligations" label="Obligations" tabs={TABS} />;
}
