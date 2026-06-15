import { Mail, ArrowRight } from 'lucide-react';
import { useAlertView, useAlertAction } from '../../data/alerts';
import type { AlertViewItem } from '../../brain/alerts-view';
import { useUi } from '../../brain/ui-context';
import { insightToDraft } from '../../brain/draft';

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--color-neg)',
  warning: 'var(--color-warn)',
  info: 'var(--color-info)',
};

export function AlertsModule() {
  const view = useAlertView();
  const action = useAlertAction();
  const ui = useUi();

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h2 className="mb-3 text-lg font-semibold">Alerts</h2>

      <div className="mb-4 grid grid-cols-4 gap-2">
        <Stat label="Critical" value={view.counts.critical} color={SEV_COLOR['critical']} />
        <Stat label="Warning" value={view.counts.warning} color={SEV_COLOR['warning']} />
        <Stat label="Info" value={view.counts.info} color={SEV_COLOR['info']} />
        <Stat label="Snoozed" value={view.counts.snoozed} />
      </div>

      {view.items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No active alerts.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.items.map((item) => (
            <AlertRow
              key={item.insight.id}
              item={item}
              onRead={() => action.mutate({ alertId: item.insight.id, action: item.read ? 'unread' : 'read' })}
              onSnooze={(days) =>
                action.mutate({ alertId: item.insight.id, action: 'snooze', days, severity: item.insight.severity })
              }
              onOpen={
                item.insight.entityType && item.insight.entityId
                  ? () => ui.openEntity({ type: item.insight.entityType!, id: item.insight.entityId! })
                  : null
              }
              onDraft={(() => {
                const d = insightToDraft(item.insight);
                return d ? () => ui.openDraft(d) : null;
              })()}
            />
          ))}
        </ul>
      )}
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

function AlertRow({
  item, onRead, onSnooze, onOpen, onDraft,
}: {
  item: AlertViewItem;
  onRead: () => void;
  onSnooze: (days: 7 | 30) => void;
  onOpen: (() => void) | null;
  onDraft: (() => void) | null;
}) {
  const c = SEV_COLOR[item.insight.severity] ?? '#5c9fe0';
  return (
    <li
      className="rounded-md p-3"
      style={{
        background: 'var(--surface-overlay)',
        borderLeft: `2px solid ${c}`,
        opacity: item.read ? 0.55 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">{item.insight.title}</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>{item.insight.detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onDraft && (
            <button className="flex items-center gap-1 text-2xs" style={{ color: 'var(--accent)' }} onClick={onDraft} aria-label="Draft email">
              <Mail size={11} /> Draft
            </button>
          )}
          {onOpen && (
            <button className="flex items-center gap-1 text-2xs" style={{ color: 'var(--text-secondary)' }} onClick={onOpen} aria-label="Open record">
              View <ArrowRight size={11} />
            </button>
          )}
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(7)}>Snooze 7d</button>
          <button className="text-2xs" style={{ color: 'var(--text-tertiary)' }} onClick={() => onSnooze(30)}>30d</button>
          <button className="text-2xs" style={{ color: 'var(--accent)' }} onClick={onRead}>{item.read ? 'Unread' : 'Mark read'}</button>
        </div>
      </div>
    </li>
  );
}
