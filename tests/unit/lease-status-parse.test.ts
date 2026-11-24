// @vitest-environment node
// Tier 1 follow-up (2026-11-24): the rent-roll status reader matched substrings, so "Inactive"
// (which contains "active") read as Active. Behaviour is unchanged (no live figure moves without a
// ruling); the row now carries a data-quality flag so the mismatch is visible.
import { describe, expect, it } from 'vitest';
import { classifyLeaseStatus } from '../../server/workbook/lease-status';

describe('classifyLeaseStatus', () => {
  it.each([
    ['Active', 'Active'],
    ['Expiring soon', 'Expiring Soon'],
    ['EXPIRED', 'Expired'],
    ['Vacant', 'Vacant'],
    ['', 'Unknown'],
    ['month to month', 'Unknown'],
  ])('%s reads as %s with no flag', (raw, status) => {
    expect(classifyLeaseStatus(raw)).toEqual({ status, inactiveSubstring: false });
  });

  it('"Inactive" keeps its old reading (Active) but is marked for a data-quality flag', () => {
    expect(classifyLeaseStatus('Inactive')).toEqual({ status: 'Active', inactiveSubstring: true });
    expect(classifyLeaseStatus('inactive - moved out')).toEqual({ status: 'Active', inactiveSubstring: true });
  });
});
