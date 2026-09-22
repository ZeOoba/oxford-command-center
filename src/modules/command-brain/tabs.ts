// Brain destination tab declaration (IA decongestion Phase 4e). React-free so the registry and the
// palette can index tabs without importing CommandBrainModule's chunk. Principal Home folded in as
// Digest and Insights as Insights; the old Versions tab became a `?view=versions` SegmentedControl
// inside Memory (Brain is capped at 5 tabs).
import type { ModuleTabDef } from '@/shell/tab-types';

export type BrainTab = 'digest' | 'insights' | 'track-record' | 'feedback' | 'memory';

export const BRAIN_TABS: readonly ModuleTabDef[] = [
  { id: 'digest', label: 'Digest', aliases: ['principal', 'principal home', 'attention'] },
  { id: 'insights', label: 'Insights', aliases: ['tier board'] },
  { id: 'track-record', label: 'Track record', aliases: ['accuracy', 'calibration report'] },
  { id: 'feedback', label: 'Feedback', aliases: ['open questions'] },
  { id: 'memory', label: 'Memory', aliases: ['versions', 'version log'] },
];

export const BRAIN_TAB_KEYS = BRAIN_TABS.map((t) => t.id) as readonly BrainTab[];
