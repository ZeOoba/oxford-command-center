// src/shell/tab-badges.ts
//
// R4 badge sources for destination tabs. Each is a hook over data the corresponding module and the
// TopBar AlertBell ALREADY fetch (react-query dedupes) — no new request is introduced.
import { useAlertView } from '@/data/alerts';
import { useAnalytics } from '@/data/queries';
// Type-only — erased at build time, so the entry chunk (which reaches this file through the
// registry's `tabs.ts` imports) never pulls in react-aria's Tabs.
import type { TabSpec } from '@/primitives/Tabs';
import type { ModuleTabDef, TabBadge } from './tab-types';

/** Worklist > Alerts: critical count in red when any critical alert is visible, else the
 *  warning count in amber, else nothing (count 0 renders no pill). Snoozed alerts are already
 *  excluded by `buildAlertView`. */
export function useAlertsTabBadge(): TabBadge | undefined {
  const { counts } = useAlertView();
  if (counts.critical > 0) return { count: counts.critical, tone: 'red', noun: 'critical alerts' };
  if (counts.warning > 0) return { count: counts.warning, tone: 'amber', noun: 'warning alerts' };
  return undefined;
}

/** Leasing > Rent roll: red count of overdue critical dates (`daysToDate < 0`) — the same definition and
 *  Spine-A analytics source LeasesModule uses for its in-view "N overdue" badge (react-query dedupes the
 *  snapshot). Nothing overdue renders no pill. */
export function useCriticalDatesTabBadge(): TabBadge | undefined {
  const { analytics } = useAnalytics();
  const count = analytics ? analytics.criticalDates.filter((c) => c.daysToDate < 0).length : 0;
  return count > 0 ? { count, tone: 'red', noun: 'overdue critical dates' } : undefined;
}

const TONE_SEVERITY: Partial<Record<TabBadge['tone'], number>> = { red: 2, amber: 1 };

/**
 * The rail badge for a destination: its single worst tab badge — most severe tone, then larger count.
 * Never a sum: two tabs can count the same underlying item (an overdue lease is both a critical date
 * and an alert), so adding them would overstate the work. Zero-count badges are ignored.
 */
export function pickRailBadge(badges: ReadonlyArray<TabBadge | undefined>): TabBadge | undefined {
  let best: TabBadge | undefined;
  for (const b of badges) {
    if (!b || b.count <= 0) continue;
    if (!best) {
      best = b;
      continue;
    }
    const sev = TONE_SEVERITY[b.tone] ?? 0;
    const bestSev = TONE_SEVERITY[best.tone] ?? 0;
    if (sev > bestSev || (sev === bestSev && b.count > best.count)) best = b;
  }
  return best;
}

/** Resolves every tab's badge in declaration order. The tab list is a module-level constant, so
 *  the hook call order is stable across renders. */
export function useTabBadges(tabs: readonly ModuleTabDef[]): Array<TabBadge | undefined> {
  return tabs.map((t) => (t.useBadge ? t.useBadge() : undefined));
}

/**
 * The ONE mapping from a registry tab declaration to the `<Tabs>` spec — id + label, plus `badge`
 * only when the tab declares a `useBadge` that returns one. Every destination that renders a strip
 * must use this: a hand-rolled `tabs.map(({ id, label }) => ({ id, label }))` silently drops any
 * declared badge, which is exactly how Capital/Market/Data/Financials lost theirs.
 *
 * Same constraint as `useTabBadges`: `tabs` must be a module-level constant so the hook call order
 * inside it stays stable across renders.
 */
export function useTabSpecs(tabs: readonly ModuleTabDef[]): TabSpec[] {
  const badges = useTabBadges(tabs);
  return tabs.map((t, i) => {
    const badge = badges[i];
    return badge ? { id: t.id, label: t.label, badge } : { id: t.id, label: t.label };
  });
}
