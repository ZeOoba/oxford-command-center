import { Bell } from 'lucide-react';
import { useAlertView } from '@/data/alerts';
import { useUi } from '@/brain/ui-context';

export function AlertBell() {
  const view = useAlertView();
  const ui = useUi();
  const unread = view.unread;

  return (
    <button
      onClick={() => ui.setActiveModule('alerts')}
      aria-label={`Alerts${unread ? ` (${unread} unread)` : ''}`}
      className="relative flex items-center justify-center rounded-[var(--radius-sm)] p-1.5 transition-colors"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
    >
      <Bell size={14} />
      {unread > 0 && (
        <span
          className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold"
          style={{ background: 'var(--color-neg)', color: 'var(--text-on-accent)' }}
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
