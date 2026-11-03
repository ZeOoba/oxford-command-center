import { useAlertView, useAlertAction } from '../../data/alerts';
import type { AlertViewItem } from '../../brain/alerts-view';
import { useUi, type UiState } from '../../brain/ui-context';
import { insightToDraft } from '../../brain/draft';
import type { InsightSeverity } from '../../analytics/types';
import { TierBoard, type Tier, type TierItem, type TierItemAction } from '../../primitives/TierBoard';
import { spineLabel } from '../../lib/spine-label';
import { MAX_ITEMS } from '../../lib/ranked-cap';
import { groupByCause } from '../../lib/tier-group';
import { causeAndDays, isPinnedAlert } from '../../brain/alert-cause';
import { describeAlertCause } from './cause-labels';

const SEV_COLOR: Record<InsightSeverity, string> = {
  critical: 'var(--text-neg)',
  warning: 'var(--text-warn)',
  info: 'var(--text-info)',
};

const TIER_TONE: Record<InsightSeverity, Tier['tone']> = {
  critical: 'neg',
  warning: 'warn',
  info: 'info',
};

const TIER_TITLE: Record<InsightSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

/** Insight impact is framed as "amount at stake"; critical/warning read as risk, info as neutral context. */
const IMPACT_KIND: Record<InsightSeverity, TierItem['impactKind']> = {
  critical: 'risk',
  warning: 'risk',
  info: 'info',
};

type AlertAction = ReturnType<typeof useAlertAction>;

function toTierItem(item: AlertViewItem, rank: number, action: AlertAction, ui: UiState): TierItem {
  const insight = item.insight;
  const onRead = () => action.mutate({ alertId: insight.id, action: item.read ? 'unread' : 'read' });
  const onSnooze = (days: 7 | 30) =>
    action.mutate({ alertId: insight.id, action: 'snooze', days, severity: insight.severity });
  const onOpen =
    insight.entityType && insight.entityId
      ? () => ui.openEntity({ type: insight.entityType!, id: insight.entityId! })
      : null;
  const draft = insightToDraft(insight);
  const onDraft = draft ? () => ui.openDraft(draft) : null;

  const actions: TierItemAction[] = [];
  if (onDraft) actions.push({ label: 'Draft', onPress: onDraft });
  if (onOpen) actions.push({ label: 'View', onPress: onOpen });
  actions.push({ label: 'Snooze 7d', onPress: () => onSnooze(7) });
  actions.push({ label: 'Snooze 30d', onPress: () => onSnooze(30) });
  actions.push({ label: item.read ? 'Unread' : 'Mark read', onPress: onRead });
  // Same cause/day derivation as the Overview and Insights boards (a lease ending today splits out).
  const { cause, daysToAct } = causeAndDays(insight);

  return {
    id: insight.id,
    rank,
    category: insight.category,
    impactUsd: insight.impactAnnualUsd,
    impactKind: IMPACT_KIND[insight.severity],
    title: insight.title,
    detail: insight.detail,
    actions,
    chips: [spineLabel(insight.spine)],
    muted: item.read,
    cause,
    pinned: isPinnedAlert(insight, item.read) || undefined,
    ...(daysToAct !== null ? { daysToAct } : {}),
  };
}

function buildTiers(items: AlertViewItem[], action: AlertAction, ui: UiState): Tier[] {
  const severities: InsightSeverity[] = ['critical', 'warning', 'info'];
  return severities.map((severity) => {
    const bucket = items.filter((i) => i.insight.severity === severity);
    return {
      key: severity,
      title: TIER_TITLE[severity],
      tone: TIER_TONE[severity],
      items: groupByCause(bucket.map((item, index) => toTierItem(item, index + 1, action, ui)), describeAlertCause),
    };
  });
}

export function AlertsModule() {
  const view = useAlertView();
  const action = useAlertAction();
  const ui = useUi();
  const tiers = buildTiers(view.items, action, ui);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Alerts</h2>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Critical" value={view.counts.critical} color={SEV_COLOR.critical} />
        <Stat label="Warning" value={view.counts.warning} color={SEV_COLOR.warning} />
        <Stat label="Info" value={view.counts.info} color={SEV_COLOR.info} />
        <Stat label="Snoozed" value={view.counts.snoozed} />
      </div>

      <TierBoard tiers={tiers} columns={3} budget={MAX_ITEMS} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-md p-2.5" style={{ background: 'var(--surface-overlay)' }}>
      <div className="text-lg font-bold" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
      <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
    </div>
  );
}
