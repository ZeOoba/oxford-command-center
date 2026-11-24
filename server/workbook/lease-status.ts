// server/workbook/lease-status.ts
//
// Rent-roll status classification, extracted from parse.ts unchanged (2026-11-24, Tier 1 follow-up)
// so it can be tested. It matches substrings, in this order: "expiring", "expired", "active",
// "vacant". A raw "Inactive" therefore reads as Active. That reading is KEPT (changing it would move
// live rent and occupancy figures, which needs a ruling); `inactiveSubstring` tells the caller to
// raise a data-quality flag so the row is visible instead of silently counted as live.
import type { LeaseStatus } from '../../src/contracts/index';

export function classifyLeaseStatus(raw: string): { status: LeaseStatus; inactiveSubstring: boolean } {
  const s = raw.toLowerCase();
  let status: LeaseStatus = 'Unknown';
  if (s.includes('expiring')) status = 'Expiring Soon';
  else if (s.includes('expired')) status = 'Expired';
  else if (s.includes('active')) status = 'Active';
  else if (s.includes('vacant')) status = 'Vacant';
  return { status, inactiveSubstring: status === 'Active' && s.includes('inactive') };
}
