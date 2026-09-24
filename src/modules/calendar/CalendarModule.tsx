import { useMemo, useState, type CSSProperties } from 'react';
import { CalendarClock } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
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
type WindowFilter = '90d' | '12mo' | '36mo';

// Events are fetched once at the WIDEST band and narrowed client-side, so switching bands costs
// no recompute. Note the top band therefore cannot exclude anything by construction — it is the
// fetch horizon restated. Keep them derived from FETCH_HORIZON_MONTHS so they cannot drift apart;
// if a future band is ever narrower than the fetch, it becomes load-bearing and needs its own case.
//
// 36 months rather than 12: measured against data/snapshots/portfolio.json at a 2026-09-18
// run-date basis (the basis this component actually uses — NOT the snapshot's precomputed
// monthsToExpiry field, which sits ~2 weeks forward and yields flattering numbers), over the 132
// leases carrying rent and an end date. A 12-month horizon shows 48 of them and 25.8% of annual
// rent; 84 tenants and $4.06M (74.2%) fall outside it, including the single largest tenant by
// rent, 469 days out. A 36-month band shows 110 tenants and 67.9% of rent. Beyond roughly three
// years the list stops being an operating calendar and becomes a planning document.
const FETCH_HORIZON_MONTHS = 36;
// critical-dates.ts converts months at 30.4375 d/mo; mirror its 12-month cut exactly.
const TWELVE_MONTH_DAYS = Math.round(12 * 30.4375);
const BAND_MAX_DAYS: Record<WindowFilter, number> = {
  '90d': 90,
  '12mo': TWELVE_MONTH_DAYS,
  '36mo': Math.round(FETCH_HORIZON_MONTHS * 30.4375),
};

export function CalendarModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const ui = useUi();
  const [type, setType] = useState<TypeFilter>('all');
  const [horizon, setHorizon] = useState<WindowFilter>('12mo');

  // Day-counts are relative to the browser's current date (run-date basis), NOT the frozen
  // workbook data date — so "in Nd" and overdue/holdover classification stay current.
  const allEvents = useMemo(
    () =>
      data
        ? portfolioCriticalDates(data.snapshot, FETCH_HORIZON_MONTHS, new Date().toISOString().slice(0, 10))
        : [],
    [data],
  );
  // The KPI strip is pinned to twelve months in EVERY band — `criticalDateKpis` reports
  // `next12mo` as simply however many events it was handed, so feeding it the full 36-month set
  // would relabel a 36-month count as "Next 12 Months". The window filter widens the list only;
  // it must never restate a portfolio metric. Enforced by tests/unit/calendar-module-horizon.test.tsx.
  const kpis = useMemo(
    () => criticalDateKpis(allEvents.filter((e) => e.daysToDate <= TWELVE_MONTH_DAYS)),
    [allEvents],
  );
  const filtered = useMemo(() => {
    let rows = allEvents.filter((e) => e.daysToDate <= BAND_MAX_DAYS[horizon]);
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

  if (gate) return gate;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiStat label="Overdue / Holdover" value={kpis.overdue} format={(n) => String(n ?? 0)} accentColor="var(--color-neg)" sublabel="date passed" />
        <KpiStat label="Critical (<60d)" value={kpis.critical} format={(n) => String(n ?? 0)} accentColor="var(--color-warn)" />
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
            <option value="36mo">Next 36 months</option>
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
