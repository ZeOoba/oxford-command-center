// src/analytics/governor-headroom.ts
//
// Headroom of the portfolio against its ratified governors, for the Overview KPI strip's bullet
// tiles (design review 2026-10-31 finding 9). Pure. Every figure is an aggregate of existing
// snapshot values — nothing is estimated — and a missing input yields null, never a placeholder.
//
// Breach semantics match the alert engine (conditions.ts): DSCR breaches strictly BELOW its floor,
// LTV strictly ABOVE its ceiling, cash strictly BELOW its floor. The boundary values themselves
// (GovernorSet / LIQUIDITY_POLICY) are passed in, never restated here.
import type { Property } from '@contracts/index';
import { isInvestmentProperty } from './property-basis';

export interface DscrHeadroom {
  /** Σ NOI / Σ annual debt service over levered investment properties (Oxford share, workbook). */
  portfolio: number | null;
  /** Lowest per-property workbook DSCR in the same levered set — the exact field the per-property
   *  DSCR alerts in conditions.ts read, so the tile and the alerts can never name different rows. A
   *  blank workbook DSCR is skipped here (as the alerts skip it) but still counts in `portfolio`.
   *  The set is id-sorted, so a tie resolves to the lowest id. */
  weakest: { id: string; name: string; dscr: number } | null;
  floor: number;
  leveredCount: number;
  breached: boolean;
  weakestBelowFloor: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Levered set: investment properties (residence excluded, ratified 2026-09-23) carrying positive
 * debt service. Affiliate-note properties STAY IN: the split basis ratified 2026-09-27
 * (./debt-basis header) keeps affiliate debt service in DSCR, since it is real cash out of the
 * property, and the per-property DSCR alerts in conditions.ts include them too. Only the LTV tile
 * (PortfolioKpis.ltv) excludes affiliate notes.
 */
export function dscrHeadroom(properties: readonly Property[], floor: number): DscrHeadroom {
  // Sorted by id so the float sums (and so a breach exactly at the floor) never depend on array order.
  const levered = properties
    .filter((p) => isInvestmentProperty(p) && finite(p.debtService) && p.debtService > 0 && finite(p.noi))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const noi = levered.reduce((s, p) => s + p.noi, 0);
  const ds = levered.reduce((s, p) => s + p.debtService, 0);
  const portfolio = levered.length > 0 ? noi / ds : null;
  let weakest: DscrHeadroom['weakest'] = null;
  for (const p of levered) {
    if (finite(p.dscr) && (weakest === null || p.dscr < weakest.dscr)) weakest = { id: p.id, name: p.name, dscr: p.dscr };
  }
  return {
    portfolio,
    weakest,
    floor,
    leveredCount: levered.length,
    breached: portfolio !== null && portfolio < floor,
    weakestBelowFloor: weakest !== null && weakest.dscr < floor,
  };
}

export interface LtvHeadroom {
  value: number | null;
  ceiling: number;
  breached: boolean;
}

/** Aggregate LTV (PortfolioKpis.ltv — third-party debt / Σ value) against the aggregate ceiling. */
export function ltvHeadroom(ltv: number | null, ceiling: number): LtvHeadroom {
  const value = finite(ltv) ? ltv : null;
  return { value, ceiling, breached: value !== null && value > ceiling };
}

export interface CashHeadroom {
  value: number | null;
  floor: number;
  /** value − floor; negative when below the floor. */
  cushion: number | null;
  breached: boolean;
}

/** Total cash (Cash Balances · total) against the firm cash floor. */
export function cashHeadroom(totalCash: number | null, floor: number): CashHeadroom {
  const value = finite(totalCash) ? totalCash : null;
  return { value, floor, cushion: value === null ? null : value - floor, breached: value !== null && value < floor };
}

/** The Cash Balances entity that is the firm's own account. */
export const FIRM_CASH_ENTITY = { id: 'oxford', name: 'Oxford' } as const;

/**
 * Firm cash — the balance the $1.5M floor (LIQUIDITY_POLICY.firmCashFloorUsd) governs.
 *
 * TARGET BASIS is the ratified (2026-09-18) sweepable-cash definition: JV entities pro-rata via
 * ownershipPct, excluding lender escrows / lockboxes. The snapshot cannot compute it today (Cash
 * Balances carries no escrow/lockbox split and no per-entity ownership), and no deployable-capacity
 * engine exists yet. INTERIM PROXY (Gabriel, 2026-11-02): the "Oxford" Cash Balances entity balance.
 * Replace this with the sweepable-cash figure when the deployable-capacity plan lands. Matched exactly on id or trimmed name, never a substring ("Oxford Capital", "REDACTED-665"
 * and property accounts are not firm cash). Returns null — unknown, never a breach and never OK —
 * when no entity or more than one matches, or the balance is non-finite.
 */
export function firmCashBalance(entities: readonly { readonly id: string; readonly entity: string; readonly currentBalance: number }[]): number | null {
  const hits = entities.filter((e) => e.id === FIRM_CASH_ENTITY.id || e.entity.trim() === FIRM_CASH_ENTITY.name);
  if (hits.length !== 1) return null;
  const bal = hits[0]!.currentBalance;
  return finite(bal) ? bal : null;
}
