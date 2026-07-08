import { describe, it, expect } from 'vitest';
import { fmtDate } from '../../src/analytics/format';

describe('fmtDate()', () => {
  it('renders a bare YYYY-MM-DD date on its own calendar day, regardless of the runtime timezone', () => {
    // '2026-07-01' parses as UTC midnight (ECMAScript date-only string semantics). Formatting
    // without an explicit UTC timeZone shifts it to the LOCAL timezone — on any UTC-negative
    // machine (e.g. America/New_York) that rolls back to Jun 30. This must always read Jul 1.
    expect(fmtDate('2026-07-01')).toBe('Jul 1, 2026');
  });

  it('renders a sliced (date-only) sourcedAt timestamp correctly', () => {
    // Matches the CompsView.tsx / DealDrawer.tsx call pattern: `sourcedAt.slice(0, 10)`.
    expect(fmtDate('2026-06-15T09:00:00.000Z'.slice(0, 10))).toBe('Jun 15, 2026');
  });

  it('returns the em dash for null/undefined/empty/invalid input', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
    expect(fmtDate('')).toBe('—');
    expect(fmtDate('not-a-date')).toBe('—');
  });
});
