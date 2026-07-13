import type { PortfolioSnapshot } from '../contracts/index';
import { RENEWAL_STAGES, type RenewalStage } from '../contracts/renewal';
import { DAY_MS } from '../../server/warehouse/time-constants';
const daysBetween = (isoTarget: string, isoFrom: string): number =>
  Math.round((new Date(isoTarget).getTime() - new Date(isoFrom).getTime()) / DAY_MS);

/** "Needs action now" window — leases expiring within this many days populate the board. */
export const RENEWAL_WINDOW_DAYS = 75;

export interface RenewalCard {
  leaseId: string;
  tenant: string;
  propertyKey: string;
  unit: string | null;
  annualRent: number;
  leaseEnd: string | null;
  daysToExpiry: number | null; // signed; null when no lease-end date
  stage: RenewalStage;
}

export type RenewalBoard = Record<RenewalStage, RenewalCard[]>;

/**
 * Group the "needs action now" lease set into the renewal kanban. A lease appears when it is
 * expiring within RENEWAL_WINDOW_DAYS (including overdue holdovers — still an open item) or when
 * it already carries an explicit renewal stage in the overlay. Vacant units are excluded.
 *
 * @param referenceDate Optional day-count reference (YYYY-MM-DD). Defaults to s.meta.asOf (the
 *   workbook data date) for backward compatibility — the workbook-frozen-date defect means
 *   callers should pass the real run date (see portfolioCriticalDates for the established
 *   convention).
 */
export function renewalBoard(s: PortfolioSnapshot, referenceDate?: string): RenewalBoard {
  const asOf = referenceDate ?? s.meta.asOf;
  const stages = s.renewalStages;
  const board: RenewalBoard = { Expiring: [], Outreach: [], Negotiating: [], LOI: [], Executed: [] };

  for (const l of s.leases) {
    const explicit = stages[l.id]; // RenewalStage | undefined
    const daysToExpiry = l.leaseEnd ? daysBetween(l.leaseEnd, asOf) : null;
    const inWindow = daysToExpiry !== null && daysToExpiry <= RENEWAL_WINDOW_DAYS;
    const eligible = (explicit !== undefined || inWindow) && l.status !== 'Vacant';
    if (!eligible) continue;

    const stage: RenewalStage = explicit ?? 'Expiring';
    board[stage].push({
      leaseId: l.id,
      tenant: l.company ?? l.tenantName,
      propertyKey: l.propertyKey,
      unit: l.unit,
      annualRent: l.annualRent,
      leaseEnd: l.leaseEnd,
      daysToExpiry,
      stage,
    });
  }

  const byUrgency = (a: RenewalCard, b: RenewalCard): number => {
    if (a.daysToExpiry === null) return 1;
    if (b.daysToExpiry === null) return -1;
    return a.daysToExpiry - b.daysToExpiry;
  };
  for (const k of RENEWAL_STAGES) board[k].sort(byUrgency);
  return board;
}
