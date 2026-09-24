import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { useBrain } from '@/data/brain-context';
import { computeFreshness } from '@/lib/freshness';
import { createTask } from '@/data/actions';
import { fmtNum, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Button } from '@/primitives/Button';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import type { TaskStatus } from '@contracts/index';

const STATUS_META: Record<TaskStatus, { tone: BadgeTone; label: string }> = {
  done: { tone: 'green', label: 'Done' },
  overdue: { tone: 'red', label: 'Overdue' },
  renewal: { tone: 'amber', label: 'Renewal' },
  pending: { tone: 'neutral', label: 'Pending' },
  na: { tone: 'neutral', label: 'N/A' },
  unknown: { tone: 'neutral', label: '—' },
};

export function TasksModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const { state } = useBrain();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const canWrite = computeFreshness(state).kind === 'live';

  const addTask = async () => {
    const v = label.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await createTask({ label: v });
      await qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
      setLabel('');
    } catch {
      /* leave the input for retry */
    } finally {
      setBusy(false);
    }
  };

  if (gate) return gate;
  if (!data) return null;
  const tasks = data.snapshot.tasks;
  const done = tasks.filter((t) => t.status === 'done').length;
  const open = tasks.filter((t) => t.status === 'pending').length;
  const overdue = tasks.filter((t) => t.status === 'overdue').length;
  const renewals = tasks.filter((t) => t.status === 'renewal').length;
  const sections = [...new Set(tasks.map((t) => t.section))];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Completed This Month" value={done} format={fmtNum} accentColor="var(--color-pos)" sublabel={`of ${tasks.length} items`} />
        <KpiStat label="Pending" value={open} format={fmtNum} accentColor="var(--color-warn)" />
        <KpiStat label="Overdue" value={overdue} format={fmtNum} accentColor="var(--color-neg)" />
        <KpiStat label="Renewals Due" value={renewals} format={fmtNum} accentColor="var(--color-info)" sublabel={`as of ${fmtDate(data.snapshot.meta.asOf)}`} />
      </div>

      {canWrite && (
        <div className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addTask(); }}
            placeholder="Add a checklist task… (saved to the local overlay)"
            className="flex-1 rounded-[var(--radius-sm)] px-3 py-2 text-xs outline-none"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
          />
          <Button size="sm" variant="primary" onPress={() => void addTask()}>
            <Plus size={13} /> Add task
          </Button>
        </div>
      )}

      {sections.map((sec) => {
        const items = tasks.filter((t) => t.section === sec);
        const d = items.filter((t) => t.status === 'done').length;
        return (
          <Card key={sec}>
            <CardHeader title={sec} trailing={<Badge tone="neutral">{d}/{items.length}</Badge>} />
            <ul className="flex flex-col">
              {items.map((t) => {
                const m = STATUS_META[t.status];
                return (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <div className="min-w-0">
                      <div className="text-sm" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{t.label}</div>
                      {t.notes && <div className="num truncate text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: '560px' }}>{t.notes}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {t.type && <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{t.type}</span>}
                      <Badge tone={m.tone}>{m.label}</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
