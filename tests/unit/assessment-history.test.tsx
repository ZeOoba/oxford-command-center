// tests/unit/assessment-history.test.tsx
//
// Task 26 — tax assessment history chart (Taxes › Assessments & Appeals).
// Pure builder coverage: taxByYear sums annualTaxBilled per year (nulls skipped, ascending) and
// carries the distinct-property count per year (I-3); assessedSeries builds a per-property
// assessed-value series, only where >=2 years exist; taxYearBars turns taxByYear rows into
// BarChart data, marking a year "(partial)" when it has fewer contributing properties than the
// year with the most (I-3).
//
// Builders live in ./assessment-history.ts, not AssessmentHistoryCard.tsx (brief's stated import
// path) — react-refresh/only-export-components (max-warnings 0) forbids non-component exports
// from a component .tsx file; the repo's own Task-25 precedent (insurance/PremiumHistoryCard.tsx
// + leasing/rollover-chart-data.ts) keeps chart-data builders in a sibling .ts file. See
// AssessmentHistoryCard.tsx's header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { assessedSeries, taxByYear, taxYearBars } from '../../src/modules/taxes/assessment-history';
import { AssessmentHistoryCard } from '../../src/modules/taxes/AssessmentHistoryCard';
import type { TaxAssessment } from '../../src/contracts/tax';

const a = (propertyId: string, taxYear: number, assessedValue: number | null, annualTaxBilled: number | null): TaxAssessment =>
  ({ propertyId, taxYear, jurisdiction: null, assessedValue, assessmentRatio: null, millageRate: null, annualTaxBilled, source: 's', asOf: null });

describe('tax history builders', () => {
  it('sums billed tax by year, skipping nulls, and carries the distinct-property count per year', () => {
    expect(taxByYear([a('p', 2025, 1, 100), a('q', 2025, 1, 50), a('p', 2026, 1, null), a('p', 2024, 1, 90)]))
      .toEqual([{ label: '2024', value: 90, count: 1 }, { label: '2025', value: 150, count: 2 }]);
  });
  it('assessed-value series per property, only where ≥2 years exist', () => {
    expect(assessedSeries([a('p', 2025, 200, null), a('p', 2024, 180, null), a('q', 2025, 5, null)]))
      .toEqual([{ propertyId: 'p', values: [180, 200] }]);
  });

  describe('taxYearBars', () => {
    it('carries each row through with its property count appended to the label', () => {
      const rows = [{ label: '2024', value: 90, count: 2 }, { label: '2025', value: 150, count: 2 }];
      expect(taxYearBars(rows)).toEqual([
        { label: '2024 · 2', value: 90 },
        { label: '2025 · 2', value: 150 },
      ]);
    });

    it('marks a year with fewer contributing properties than the max as partial', () => {
      const rows = [{ label: '2024', value: 150, count: 1 }, { label: '2025', value: 200, count: 2 }];
      expect(taxYearBars(rows)).toEqual([
        { label: '2024* · 1', value: 150 },
        { label: '2025 · 2', value: 200 },
      ]);
    });

    it('marks no year as partial when every year has the same property count', () => {
      const rows = [{ label: '2024', value: 90, count: 3 }, { label: '2025', value: 150, count: 3 }];
      expect(taxYearBars(rows).every((b) => !b.label.includes('*'))).toBe(true);
    });

    it('returns an empty array for no rows', () => {
      expect(taxYearBars([])).toEqual([]);
    });
  });
});

// I-5: the card previously hid itself entirely (`bars.length === 0` -> null) whenever no year had
// billed tax, even when assessed-value sparklines existed to show. The convention is "no data at
// all -> render nothing"; "some data, just not this one chart" must still render.
describe('AssessmentHistoryCard', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing when there is neither a billed-tax bar nor an assessed-value sparkline', () => {
    const { container } = render(<AssessmentHistoryCard assessments={[]} nameFor={(id) => id} />);
    expect(container.firstChild).toBeNull();
  });

  it('still renders the card (with sparklines) when no year has billed tax', () => {
    const assessments: TaxAssessment[] = [
      a('p', 2025, 200, null),
      a('p', 2024, 180, null),
    ];
    render(<AssessmentHistoryCard assessments={assessments} nameFor={() => 'Prop P'} />);
    expect(screen.getByText('Property Tax History')).toBeTruthy();
    expect(screen.getByText(/Prop P/)).toBeTruthy();
  });

  it('renders when billed-tax bars exist but no property has 2+ years of assessed value', () => {
    const assessments: TaxAssessment[] = [a('p', 2025, null, 100)];
    render(<AssessmentHistoryCard assessments={assessments} nameFor={() => 'Prop P'} />);
    expect(screen.getByText('Property Tax History')).toBeTruthy();
  });
});
