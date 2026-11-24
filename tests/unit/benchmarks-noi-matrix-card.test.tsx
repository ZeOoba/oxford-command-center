// Review round 2 tier B3 (2026-11-24): NOI by Property moved onto the shared DataTable. The
// independent review caught a TDZ crash on every non-empty matrix that no test rendered; this one does.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NoiMatrixCard } from '../../src/modules/intel/BenchmarksView';

afterEach(cleanup);

const MATRIX = [
  { propertyId: 'a', propertyName: 'Alpha Industrial', period: '2025', noi: 120_000 },
  { propertyId: 'a', propertyName: 'Alpha Industrial', period: '2026-YTD', noi: 50_000 },
  { propertyId: 'b', propertyName: 'Bravo Flex', period: '2025', noi: 300_000 },
];

describe('NoiMatrixCard', () => {
  it('renders every property and period, FY / YTD headers, and an em-dash for a missing period', () => {
    render(<NoiMatrixCard matrix={MATRIX} />);
    expect(screen.getByText('2 properties')).toBeTruthy();
    expect(screen.getByText('FY2025')).toBeTruthy();
    expect(screen.getByText('2026-YTD YTD')).toBeTruthy();
    expect(screen.getByText('$120,000')).toBeTruthy();
    expect(screen.getByText('$300,000')).toBeTruthy();
    expect(screen.getByText('$50,000')).toBeTruthy();
    const bravo = screen.getByText('Bravo Flex').closest('tr')!;
    expect(within(bravo).getByText('—')).toBeTruthy();
  });

  const order = () => screen.getAllByRole('row').slice(1).map((r) => (r.textContent ?? '').match(/^(Alpha Industrial|Bravo Flex)/)?.[1]);

  it('sorts by a period column, largest first, without dropping rows', () => {
    render(<NoiMatrixCard matrix={MATRIX} />);
    expect(order()).toEqual(['Alpha Industrial', 'Bravo Flex']); // input order by default
    fireEvent.click(screen.getByText('FY2025'));
    expect(order()).toEqual(['Bravo Flex', 'Alpha Industrial']);
  });

  it('puts a property with no figure for the sorted period last', () => {
    render(<NoiMatrixCard matrix={MATRIX} />);
    fireEvent.click(screen.getByText('2026-YTD YTD'));
    expect(order()).toEqual(['Alpha Industrial', 'Bravo Flex']);
    fireEvent.click(screen.getByText('2026-YTD YTD'));
    expect(order()).toEqual(['Alpha Industrial', 'Bravo Flex']);
  });

  it('keeps the empty-state message when there are no financials', () => {
    render(<NoiMatrixCard matrix={[]} />);
    expect(screen.getByText(/No committed financials yet/)).toBeTruthy();
  });
});
