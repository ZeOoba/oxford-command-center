import type { PortfolioSnapshot } from '../contracts/index';

const DAY_MS = 86_400_000;
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

export type CalendarEventType = 'lease-expiry' | 'escalation' | 'loan-maturity' | 'insurance-renewal';
export type CalendarUrgency = 'critical' | 'warning' | 'normal';
export type CalendarEntityType = 'lease' | 'loan' | 'insurance';

export interface DatedEvent {
  id: string;
  type: CalendarEventType;
  entityType: CalendarEntityType;
  entityId: string;
  title: string; // primary label (tenant / loan / property)
  subtitle: string; // secondary context (property·unit / balance / coverage)
  date: string; // ISO YYYY-MM-DD
  daysToDate: number; // signed — negative is overdue
  monthKey: string; // YYYY-MM, for grouping
  urgency: CalendarUrgency;
  amount: number | null; // rent / balance / premium, for display
}

/** Critical < 60d (incl. overdue), Warning 60–180d, else normal. */
function urgencyOf(daysToDate: number): CalendarUrgency {
  if (daysToDate < 60) return 'critical';
  if (daysToDate < 180) return 'warning';
  return 'normal';
}

/**
 * The portfolio-wide actionable date calendar over a forward horizon (default 12 months).
 * Folds lease expirations + escalations, loan maturities, and insurance renewals into one
 * date-sorted stream. Overdue items (expired leases/policies — i.e. open obligations) are kept;
 * future events beyond the horizon and past-only escalations are dropped.
 */
export function portfolioCriticalDates(s: PortfolioSnapshot, horizonMonths = 12): DatedEvent[] {
  const asOf = s.meta.asOf;
  const horizonDays = Math.round(horizonMonths * 30.4375);
  const within = (days: number) => days <= horizonDays;
  const out: DatedEvent[] = [];

  for (const l of s.leases) {
    const tenant = l.company ?? l.tenantName;
    const where = `${l.propertyKey}${l.unit ? ` · ${l.unit}` : ''}`;
    if (l.leaseEnd) {
      const d = daysBetween(l.leaseEnd, asOf);
      if (within(d)) {
        out.push({
          id: `lease-expiry-${l.id}`, type: 'lease-expiry', entityType: 'lease', entityId: l.id,
          title: tenant, subtitle: where, date: l.leaseEnd, daysToDate: d,
          monthKey: l.leaseEnd.slice(0, 7), urgency: urgencyOf(d), amount: l.annualRent,
        });
      }
    }
    if (l.escalationDate) {
      const d = daysBetween(l.escalationDate, asOf);
      if (d >= 0 && within(d)) {
        out.push({
          id: `escalation-${l.id}`, type: 'escalation', entityType: 'lease', entityId: l.id,
          title: tenant, subtitle: `${where} · escalation`, date: l.escalationDate, daysToDate: d,
          monthKey: l.escalationDate.slice(0, 7), urgency: urgencyOf(d), amount: l.annualRent,
        });
      }
    }
  }

  for (const ln of s.loans) {
    if (ln.isDemand || !ln.maturity) continue;
    const d = daysBetween(ln.maturity, asOf);
    if (within(d)) {
      out.push({
        id: `loan-maturity-${ln.id}`, type: 'loan-maturity', entityType: 'loan', entityId: ln.id,
        title: ln.name, subtitle: 'loan maturity', date: ln.maturity, daysToDate: d,
        monthKey: ln.maturity.slice(0, 7), urgency: urgencyOf(d), amount: ln.absBalance,
      });
    }
  }

  for (const p of s.insurance) {
    if (!p.expires) continue;
    const d = daysBetween(p.expires, asOf);
    if (within(d)) {
      out.push({
        id: `insurance-renewal-${p.id}`, type: 'insurance-renewal', entityType: 'insurance', entityId: p.id,
        title: p.property, subtitle: p.coverage ?? 'coverage', date: p.expires, daysToDate: d,
        monthKey: p.expires.slice(0, 7), urgency: urgencyOf(d), amount: p.premium,
      });
    }
  }

  return out.sort((a, b) => a.daysToDate - b.daysToDate);
}

export interface CriticalDateKpis {
  critical: number; // < 60d, incl. overdue
  warning: number; // 60–180d
  thisQuarter: number; // < 90d, incl. overdue
  next12mo: number; // total in the horizon
}

export function criticalDateKpis(events: DatedEvent[]): CriticalDateKpis {
  let critical = 0;
  let warning = 0;
  let thisQuarter = 0;
  for (const e of events) {
    if (e.daysToDate < 60) critical += 1;
    else if (e.daysToDate < 180) warning += 1;
    if (e.daysToDate < 90) thisQuarter += 1;
  }
  return { critical, warning, thisQuarter, next12mo: events.length };
}
