// Brain destination tab declaration (IA decongestion Phase 4e). JSX-free / no module-chunk imports,
// so the registry and the palette can index tabs without importing CommandBrainModule's chunk (the
// R4 badge hook below reaches only the shared data layer, the same way leasing/tabs.ts does).
// Principal Home folded in as Digest and Insights as Insights; the old Versions tab became a
// `?view=versions` SegmentedControl inside Memory (Brain is capped at 5 tabs).
import type { ModuleTabDef, TabBadge } from '@/shell/tab-types';
import { isWarehouseUnavailable, useBrainReport } from './hooks';

export type BrainTab = 'digest' | 'insights' | 'track-record' | 'feedback' | 'memory';

/**
 * R4 — Brain > Feedback: the open-question count, so the actionable feed is visible from any tab.
 * Neutral tone: the count is workload, not severity; 0 renders no pill.
 *
 * Error-FIRST predicate, identical to <ReportGate>'s: react-query v5 retains `data` when a REFETCH
 * fails, so a data-only read would put a count on the label above a panel showing the offline card
 * (Rule G corollary — a badge summarising a warehouse-backed panel shares that panel's predicate).
 * The query is the same one ReportGate uses, so react-query dedupes it; no new request.
 */
export function useBrainFeedbackTabBadge(): TabBadge | undefined {
  const report = useBrainReport();
  if (isWarehouseUnavailable(report.error)) return undefined;
  const count = report.data?.openQuestions.length ?? 0;
  return count > 0 ? { count, tone: 'neutral', noun: 'open questions' } : undefined;
}

export const BRAIN_TABS: readonly ModuleTabDef[] = [
  { id: 'digest', label: 'Digest', aliases: ['principal', 'principal home', 'attention'] },
  { id: 'insights', label: 'Insights', aliases: ['tier board'] },
  { id: 'track-record', label: 'Track record', aliases: ['accuracy', 'calibration report'] },
  { id: 'feedback', label: 'Feedback', aliases: ['open questions'], useBadge: useBrainFeedbackTabBadge },
  { id: 'memory', label: 'Memory', aliases: ['versions', 'version log'] },
];

export const BRAIN_TAB_KEYS = BRAIN_TABS.map((t) => t.id) as readonly BrainTab[];
