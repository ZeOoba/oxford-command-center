import { useMemo, useState, type CSSProperties } from 'react';
import { CalendarClock } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtDate } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import {
  portfolioCriticalDates,
  criticalDateKpis,
  type CalendarEventType,
  type CalendarUrgency,
  type DatedEvent,
} from '@/brain/critical-dates';

const TYPE_LABEL: Record<CalendarEventType, string> = {
  'lease-expiry': 'Lease Expiry',
  escalation: 'Escalation',
  'loan-maturity': 'Loan Maturity',
  'insurance-renewal': 'Insurance Renewal',
};
const TYPE_TONE: Record<CalendarEventType, BadgeTone> = {
  'lease-expiry': 'blue',
  escalation: 'purple',
  'loan-maturity': 'amber',
  'insurance-renewal': 'green',
};
const TYPE_COLOR: Record<CalendarEventType, string> = {
  'lease-expiry': 'var(--color-info)',
  escalation: 'var(--color-accent2)',
  'loan-maturity': 'var(--color-warn)',
  'insurance-renewal': 'var(--color-pos)',
};
const URGENCY_TONE: Record<CalendarUrgency, BadgeTone> = { critical: 'red', warning: 'amber', normal: 'neutral' };
const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (days: number) => (days < 0 ? `${Math.abs(days)}d over` : `${days}d`);

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};

type TypeFilter = CalendarEventType | 'all';
type WindowFilter = '90d' | '12mo';

export function CalendarModule() {
  const { data } = useSnapshot();
  const ui = useUi();
  const [type, setType] = useState<TypeFilter>('all');
  const [horizon, setHorizon] = useState<WindowFilter>('12mo');

  // The KPI strip always reflects the full 12-month horizon; the window filter only narrows the list.
  const allEvents = useMemo(() => (data ? portfolioCriticalDates(data.snapshot, 12) : []), [data]);
  const kpis = useMemo(() => criticalDateKpis(allEvents), [allEvents]);
  const filtered = useMemo(() => {
    let rows = horizon === '90d' ? allEvents.filter((e) => e.daysToDate <= 90) : allEvents;
    if (type !== 'all') rows = rows.filter((e) => e.type === type);
    return rows;
  }, [allEvents, horizon, type]);

  const groups = useMemo(() => {
    const m = new Map<string, DatedEvent[]>();
    for (const e of filtered) {
      const arr = m.get(e.monthKey) ?? [];
      arr.push(e);
      m.set(e.monthKey, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Critical (<60d)" value={kpis.critical} format={(n) => String(n ?? 0)} accentColor="var(--color-neg)" sublabel="incl. overdue" />
        <KpiStat label="Warning (<180d)" value={kpis.warning} format={(n) => String(n ?? 0)} accentColor="var(--color-warn)" />
        <KpiStat label="This Quarter" value={kpis.thisQuarter} format={(n) => String(n ?? 0)} accentColor="var(--color-info)" sublabel="next 90 days" />
        <KpiStat label="Next 12 Months" value={kpis.next12mo} format={(n) => String(n ?? 0)} accentColor="var(--accent)" />
      </div>

      <Card>
        <CardHeader
          title="Critical Dates"
          trailing={<Badge tone="neutral">{filtered.length} events</Badge>}
        />
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-1.5 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            <CalendarClock size={12} /> <span>Lease, loan, insurance &amp; escalation deadlines</span>
          </div>
          <span className="flex-1" />
          <select aria-label="Filter by event type" value={type} onChange={(e) => setType(e.target.value as TypeFilter)} className={fieldCls} style={fieldStyle}>
            <option value="all">All types</option>
            {(Object.keys(TYPE_LABEL) as CalendarEventType[]).map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
          <select aria-label="Filter by window" value={horizon} onChange={(e) => setHorizon(e.target.value as WindowFilter)} className={fieldCls} style={fieldStyle}>
            <option value="12mo">Next 12 months</option>
            <option value="90d">Next 90 days</option>
          </select>
        </div>

        {groups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No critical dates in this window.
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.map(([month, rows]) => (
              <div key={month}>
                <div className="num px-4 py-1.5 text-2xs font-semibold uppercase"
                  style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)' }}>
                  {monthLabel(month)} · {rows.length}
                </div>
                {rows.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => ui.openEntity({ type: e.entityType, id: e.entityId })}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                    style={{ borderBottom: '1px solid var(--border-subtle)', borderLeft: `2px solid ${TYPE_COLOR[e.type]}` }}
                  >
                    <Badge tone={URGENCY_TONE[e.urgency]}>{dayLabel(e.daysToDate)}</Badge>
                    <span className="num w-20 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{fmtDate(e.date)}</span>
                    <span className="flex-1">
                      <span className="block text-sm" style={{ fontWeight: 600 }}>{e.title}</span>
                      <span className="block text-2xs" style={{ color: 'var(--text-tertiary)' }}>{e.subtitle}</span>
                    </span>
                    <Badge tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Badge>
                    <span className="num w-20 text-right text-2xs" style={{ color: 'var(--text-secondary)' }}>
                      {e.amount !== null ? fmtUsdCompact(e.amount) : '—'}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
