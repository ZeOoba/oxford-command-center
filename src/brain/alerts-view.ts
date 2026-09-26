import type { Insight, InsightSeverity } from '../analytics/types';
import type { AlertInboxState, AlertActionInput } from '../contracts/alerts';
import { DAY_MS } from '@/lib/time-constants';
/** Higher rank = more severe. Escalation past the snoozed rank re-shows the alert. */
const RANK: Record<InsightSeverity, number> = { critical: 3, warning: 2, info: 1 };
/** Display order: critical first. */
const ORDER: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Pure state transition for a read/unread/snooze action. */
export function applyAlertAction(state: AlertInboxState, input: AlertActionInput, now: number): AlertInboxState {
  if (input.action === 'snooze') {
    const days = input.days === 30 ? 30 : 7;
    return {
      ...state,
      snoozed: {
        ...state.snoozed,
        [input.alertId]: {
          until: new Date(now + days * DAY_MS).toISOString(),
          severityAtSnooze: input.severity ?? 'info',
        },
      },
    };
  }
  const read = new Set(state.read);
  if (input.action === 'read') read.add(input.alertId);
  else read.delete(input.alertId);
  return { ...state, read: [...read] };
}

export interface AlertViewItem {
  insight: Insight;
  read: boolean;
  snoozedUntil: string | null;
}

export interface AlertView {
  items: AlertViewItem[]; // visible (snoozed-hidden removed), severity-sorted
  counts: { critical: number; warning: number; info: number; snoozed: number };
  unread: number;
}

/** An Insight.id is the read/snooze key AND the React list key — two insights sharing one corrupt
 *  each other's state (the F1 collision class). The producers are now collision-free and guarded by
 *  tests/unit/insight-id-uniqueness.test.ts, but those test fixtures cannot anticipate every real
 *  warehouse-data shape. This runtime check is the backstop: it fires ONLY when a duplicate actually
 *  reaches the inbox, so it is silent in correct operation (no env gate needed) and loud the instant
 *  a future producer regresses on real data. */
function warnOnDuplicateIds(insights: Insight[]): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const i of insights) {
    if (seen.has(i.id)) dupes.add(i.id);
    else seen.add(i.id);
  }
  if (dupes.size > 0) {
    console.warn(`buildAlertView: duplicate insight id(s) — read/snooze state will collide: ${[...dupes].join(', ')}`);
  }
}

export function buildAlertView(insights: Insight[], state: AlertInboxState, now: number): AlertView {
  warnOnDuplicateIds(insights);
  const readSet = new Set(state.read);
  const visible: AlertViewItem[] = [];
  let snoozed = 0;

  for (const insight of insights) {
    const snz = state.snoozed[insight.id];
    const expiry = snz ? Date.parse(snz.until) : NaN;
    // A snooze is "active" only while its (well-formed) window is still in the future.
    // A malformed `until` (NaN) is treated as inactive so a corrupt entry fails open (shows the alert).
    const snoozeActive = !!snz && !Number.isNaN(expiry) && now < expiry;
    const hidden = snoozeActive && RANK[insight.severity] <= RANK[snz!.severityAtSnooze]; // not escalated → stay hidden
    if (hidden) {
      snoozed += 1;
      continue;
    }
    // Only report a snooze timestamp while the snooze is still active (e.g. surfaced via escalation);
    // an expired/absent snooze reports null so callers don't render a stale "snoozed" state.
    visible.push({ insight, read: readSet.has(insight.id), snoozedUntil: snoozeActive ? snz!.until : null });
  }

  visible.sort((a, b) => ORDER[a.insight.severity] - ORDER[b.insight.severity]);

  const counts = { critical: 0, warning: 0, info: 0, snoozed };
  for (const v of visible) counts[v.insight.severity] += 1;

  return { items: visible, counts, unread: visible.filter((v) => !v.read).length };
}
