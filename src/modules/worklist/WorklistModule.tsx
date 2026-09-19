// src/modules/worklist/WorklistModule.tsx
//
// Worklist destination (IA decongestion Phase 4a): Today · Alerts · Calendar · Renewals — the four
// "what needs me" modules composed as tabs. Default tab: Today. Each tab body is the existing module,
// lazily loaded on first selection; inactive panels unmount. The Alerts tab carries an R4 severity
// badge sourced from the same hook the AlertBell/AlertsModule use (no new fetch).
import { lazy, type ComponentType } from 'react';
import { Destination } from '@/shell/Destination';
import type { ModuleTabDef } from '@/shell/tab-types';
import { WORKLIST_TABS, type WorklistTab } from './tabs';

const PANELS: Record<WorklistTab, ComponentType> = {
  today: lazy(() => import('@/modules/tasks/TasksModule').then((m) => ({ default: m.TasksModule }))),
  alerts: lazy(() => import('@/modules/alerts/AlertsModule').then((m) => ({ default: m.AlertsModule }))),
  calendar: lazy(() => import('@/modules/calendar/CalendarModule').then((m) => ({ default: m.CalendarModule }))),
  renewals: lazy(() => import('@/modules/renewals/RenewalsModule').then((m) => ({ default: m.RenewalsModule }))),
};

const TABS: readonly ModuleTabDef[] = WORKLIST_TABS.map((t) => ({ ...t, Component: PANELS[t.id as WorklistTab] }));

export function WorklistModule() {
  return <Destination id="worklist" label="Worklist" tabs={TABS} />;
}
