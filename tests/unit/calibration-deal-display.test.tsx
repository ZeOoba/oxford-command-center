// tests/unit/calibration-deal-display.test.tsx
//
// Refute round 6 on d5aa8e83 — display of the one-blessed-outcome-per-deal rule:
//   - LogView badges a verdict covered by a sibling's resolution as "covered by #<id>", not "open".
//   - CalibrationSummaryPanel shows deal counts (distinct deals) beside the verdict count, falling
//     back to the verdict numbers when an older server omits the deal fields.
// Pure render tests on fixtures — no warehouse, no temp files.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LogView } from '../../src/modules/calibration/LogView';
import { CalibrationSummaryPanel } from '../../src/modules/acquisitions/CalibrationSummaryPanel';
import type { CalibrationLogRow } from '../../src/contracts/warehouse';

afterEach(cleanup);

const row = (o: Partial<CalibrationLogRow>): CalibrationLogRow => ({
  id: 1, subjectKind: 'deal', subjectId: 'c1', verdictKind: 'acquisition-score', verdictSubkind: '',
  verdictEngine: 'acquisition', predictedBand: 'PURSUE', predictedValue: 80, predictedUnit: 'score-0-100',
  confidence: 1, direction: 'up', asOfPeriod: '2026', horizonPeriods: 2, inputsVersion: 'iv', emittedBy: 'test',
  emittedAt: '2026-10-14', resolved: false, realizedBand: null, realizedValue: null, outcomePeriod: null,
  hit: null, resolvedBy: null, ...o,
});

describe('LogView — deal sibling covered by another verdict', () => {
  it('shows "covered by #<id>" for a sibling, the hit for the blessed verdict, "open" otherwise', () => {
    render(
      <LogView
        rows={[
          row({ id: 1, resolved: true, resolvedByVerdictId: 2 }),
          row({ id: 2, resolved: true, hit: 1, outcomePeriod: '2027', realizedBand: 'acquired' }),
          row({ id: 3, subjectId: 'c9' }),
        ]}
      />,
    );
    expect(screen.getByText('covered by #2')).toBeTruthy();
    expect(screen.getByText('hit')).toBeTruthy();
    expect(screen.getAllByText('open')).toHaveLength(1);
  });
});

describe('CalibrationSummaryPanel — deal counts', () => {
  const base = { totalVerdicts: 2, resolvedVerdicts: 1, overallHitRate: 1, wilsonLow: null, wilsonHigh: null };
  const tile = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

  it('shows distinct deals and resolved deals beside the verdict count', () => {
    render(<CalibrationSummaryPanel summary={{ ...base, totalDeals: 1, resolvedDeals: 1 }} />);
    expect(tile('Deals')).toBe('1');
    expect(tile('Resolved')).toBe('1');
    expect(tile('Verdicts')).toBe('2');
  });

  it('falls back to verdict counts when the deal fields are absent', () => {
    render(<CalibrationSummaryPanel summary={base} />);
    expect(tile('Deals')).toBe('—');
    expect(tile('Resolved')).toBe('1');
    expect(tile('Verdicts')).toBe('2');
  });
});
