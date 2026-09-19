// src/shell/tab-badges.ts
//
// R4 badge sources for destination tabs. Each is a hook over data the corresponding module and the
// TopBar AlertBell ALREADY fetch (react-query dedupes) — no new request is introduced.
import { useAlertView } from '@/data/alerts';
import type { ModuleTabDef, TabBadge } from './tab-types';

/** Worklist > Alerts: critical count in red when any critical alert is visible, else the
 *  warning count in amber, else nothing (count 0 renders no pill). Snoozed alerts are already
 *  excluded by `buildAlertView`. */
export function useAlertsTabBadge(): TabBadge | undefined {
  const { counts } = useAlertView();
  if (counts.critical > 0) return { count: counts.critical, tone: 'red' };
  if (counts.warning > 0) return { count: counts.warning, tone: 'amber' };
  return undefined;
}

/** Resolves every tab's badge in declaration order. The tab list is a module-level constant, so
 *  the hook call order is stable across renders. */
export function useTabBadges(tabs: readonly ModuleTabDef[]): Array<TabBadge | undefined> {
  return tabs.map((t) => (t.useBadge ? t.useBadge() : undefined));
}
