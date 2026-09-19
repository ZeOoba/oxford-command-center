// Worklist destination tab declaration (IA decongestion Phase 4a). Metadata only — the panel
// components are attached in WorklistModule.tsx so the registry / palette can index these tabs
// without importing the four modules' chunks. Legacy ids tasks/alerts/calendar/renewals alias here
// (src/brain/routing.ts LEGACY_ALIASES).
import { useAlertsTabBadge } from '@/shell/tab-badges';
import type { ModuleTabDef } from '@/shell/tab-types';

export type WorklistTab = 'today' | 'alerts' | 'calendar' | 'renewals';

export const WORKLIST_TABS: readonly ModuleTabDef[] = [
  { id: 'today', label: 'Today', aliases: ['tasks', 'checklist'] },
  { id: 'alerts', label: 'Alerts', useBadge: useAlertsTabBadge },
  { id: 'calendar', label: 'Calendar' },
  { id: 'renewals', label: 'Renewals' },
];
