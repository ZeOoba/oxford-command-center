// Acquisitions destination tab declaration (IA decongestion Phase 3 split, registered in Phase 4
// finalize). JSX-free / no module-chunk imports, so the registry and the command palette can index
// these tabs — as "Acquisitions > Tab" entries — without pulling AcquisitionsModule's chunk into the
// entry bundle. The ids are the existing `?tab=` deep links; do not rename them.
import type { ModuleTabDef } from '@/shell/tab-types';

export type AcqTab = 'pipeline' | 'workbench' | 'sourcing' | 'grader' | 'edge';

export const ACQUISITIONS_TABS: readonly ModuleTabDef[] = [
  { id: 'pipeline', label: 'Pipeline', aliases: ['deals', 'deal pipeline', 'stages'] },
  { id: 'workbench', label: 'Workbench', aliases: ['underwrite', 'scoring', 'acquisition workbench'] },
  { id: 'sourcing', label: 'Sourcing', aliases: ['off-market', 'deal sourcing', 'acquisitions intel'] },
  { id: 'grader', label: 'Grader', aliases: ['deal grader', 'grade a deal', 'score a deal'] },
  // Oxford Edge (2026-10-02 spec §8.1). This brings Acquisitions to exactly MAX_TABS_PER_DESTINATION
  // (5, src/shell/tab-types.ts) — any later tab needs an IA decision. No useBadge: a STALE badge would
  // add an eager query on every Acquisitions load; staleness is shown inside the tab.
  { id: 'edge', label: 'Edge', aliases: ['oxford edge', 'market board', 'markets', 'pull queue', 'data health'] },
];

export const ACQUISITIONS_TAB_KEYS = ACQUISITIONS_TABS.map((t) => t.id) as readonly AcqTab[];
