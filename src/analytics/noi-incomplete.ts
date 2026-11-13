// src/analytics/noi-incomplete.ts
//
// One wording for "Σ NOI is incomplete" on the headline surfaces (Overview / Portfolio / Principal
// NOI tiles, the weighted-cap tile, the Acquisition Lens). A blank workbook NOI cell (parse flag,
// ./governor-inputs) is summed as $0, so the total is INCOMPLETE. No bound direction is claimed: a
// blank NOI may be negative (vacant row with carrying costs). Follow-up to audit 2026-11-12 HIGH #2.
import type { PortfolioKpis } from './types';

/** Names of the investment rows whose blank NOI is left out of Σ NOI (id order). Empty when complete. */
export function noiGapNames(k: Pick<PortfolioKpis, 'noiIncomplete'>): string[] {
  return (k.noiIncomplete ?? []).map((r) => r.name);
}

/** "$1,234" or "$1,234 (incomplete: blank NOI on A, B)" — the extract script's NOI summary line. */
export function noiTotalSummary(total: number, blankNames: readonly string[]): string {
  const usd = `$${Math.round(total).toLocaleString('en-US')}`;
  return blankNames.length > 0 ? `${usd} (incomplete: blank NOI on ${blankNames.join(', ')})` : usd;
}

/** "incomplete — blank NOI on A, B", or null when every NOI is known. */
export function noiGapText(k: Pick<PortfolioKpis, 'noiIncomplete'>): string | null {
  const names = noiGapNames(k);
  return names.length > 0 ? `incomplete — blank NOI on ${names.join(', ')}` : null;
}
