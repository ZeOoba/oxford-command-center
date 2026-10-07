// Signal discipline for Today: each checklist section shows its next few open items; completed work
// is folded away and an external feed (the M365 To-Do import) collapses until asked for.
import type { Task, TaskStatus } from '@contracts/index';

/** Open items a section shows before the rest is held back. */
export const OPEN_PER_SECTION = 3;

/** Lower = more urgent. Statuses not listed (unknown) sort after pending. */
const URGENCY: Partial<Record<TaskStatus, number>> = { overdue: 0, renewal: 1, pending: 2 };

export interface SectionView {
  section: string;
  total: number;
  doneCount: number;
  /** All items still needing action, most urgent first. */
  open: Task[];
  /** The first OPEN_PER_SECTION of `open`. */
  shown: Task[];
  heldBack: number;
  /** Done and not-applicable items, folded by default. */
  folded: Task[];
  /** Every item came from the M365 To-Do import — noise-prone, collapsed by default. */
  external: boolean;
}

export function buildSectionViews(tasks: readonly Task[]): SectionView[] {
  const order: string[] = [];
  const bySection = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!bySection.has(task.section)) {
      bySection.set(task.section, []);
      order.push(task.section);
    }
    bySection.get(task.section)!.push(task);
  }

  const views = order.map((section) => {
    const items = bySection.get(section)!;
    const open = items
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status !== 'done' && task.status !== 'na')
      .sort((a, b) => (URGENCY[a.task.status] ?? 3) - (URGENCY[b.task.status] ?? 3) || a.index - b.index)
      .map(({ task }) => task);
    return {
      section,
      total: items.length,
      doneCount: items.filter((x) => x.status === 'done').length,
      open,
      shown: open.slice(0, OPEN_PER_SECTION),
      heldBack: Math.max(0, open.length - OPEN_PER_SECTION),
      folded: items.filter((x) => x.status === 'done' || x.status === 'na'),
      external: items.length > 0 && items.every((x) => x.type === 'M365 To-Do'),
    };
  });
  // Sections with work to do come first; fully-complete ones sink (stable within each group).
  return views
    .map((view, index) => ({ view, index }))
    .sort((a, b) => Number(a.view.open.length === 0) - Number(b.view.open.length === 0) || a.index - b.index)
    .map(({ view }) => view);
}
