import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  DEFAULT_PORTFOLIO_FILTER,
  filterProperties,
  matchesFilter,
  PortfolioFilterProvider,
  usePortfolioFilter,
  type PortfolioFilterState,
  type PortfolioRow,
} from '../../src/shell/PortfolioFilterContext';
import { PortfolioFilterBar } from '../../src/shell/PortfolioFilterBar';

const ROWS: PortfolioRow[] = [
  { market: 'Columbus OH', type: 'Flex', propertyManager: 'CRC' },
  { market: 'Columbus OH', type: 'Retail', propertyManager: 'Thomas Park' },
  { market: 'Mid-Atlantic', type: 'Flex', propertyManager: 'CRC' },
  { market: 'Mid-Atlantic', type: 'Industrial', propertyManager: 'SVN' },
  { market: 'Kansas City MO', type: 'Flex', propertyManager: null },
];

function filter(patch: Partial<PortfolioFilterState>): PortfolioFilterState {
  return { ...DEFAULT_PORTFOLIO_FILTER, ...patch };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('filterProperties / matchesFilter (pure)', () => {
  it('bypasses every dimension when the filter is all-all-all', () => {
    expect(filterProperties(ROWS, DEFAULT_PORTFOLIO_FILTER)).toEqual(ROWS);
  });

  it('filters by market alone', () => {
    const result = filterProperties(ROWS, filter({ market: 'Columbus OH' }));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.market === 'Columbus OH')).toBe(true);
  });

  it('filters by property type alone', () => {
    const result = filterProperties(ROWS, filter({ propertyType: 'Flex' }));
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.type === 'Flex')).toBe(true);
  });

  it('filters by manager alone', () => {
    const result = filterProperties(ROWS, filter({ manager: 'CRC' }));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.propertyManager === 'CRC')).toBe(true);
  });

  it('combines all three dimensions with AND semantics', () => {
    const result = filterProperties(ROWS, filter({ market: 'Mid-Atlantic', propertyType: 'Flex', manager: 'CRC' }));
    expect(result).toEqual([{ market: 'Mid-Atlantic', type: 'Flex', propertyManager: 'CRC' }]);
  });

  it('a combined filter with no matches returns an empty array', () => {
    const result = filterProperties(ROWS, filter({ market: 'Columbus OH', manager: 'SVN' }));
    expect(result).toEqual([]);
  });

  it('excludes rows with no manager attribution when a specific manager is selected', () => {
    const result = filterProperties(ROWS, filter({ manager: 'CRC' }));
    expect(result.some((r) => r.propertyManager === null)).toBe(false);
  });

  it('empty input returns empty output regardless of filter', () => {
    expect(filterProperties([], filter({ market: 'Columbus OH' }))).toEqual([]);
    expect(filterProperties([], DEFAULT_PORTFOLIO_FILTER)).toEqual([]);
  });

  it('matchesFilter matches a single row consistently with filterProperties', () => {
    const f = filter({ propertyType: 'Industrial' });
    const matched = ROWS.filter((r) => matchesFilter(r, f));
    expect(matched).toEqual(filterProperties(ROWS, f));
    expect(matched).toEqual([{ market: 'Mid-Atlantic', type: 'Industrial', propertyManager: 'SVN' }]);
  });

  it('a plain Property-shaped row without propertyManager is still filterable by market/type', () => {
    const bareProperty: PortfolioRow = { market: 'Toledo OH', type: 'Residence' };
    expect(matchesFilter(bareProperty, filter({ market: 'Toledo OH' }))).toBe(true);
    expect(matchesFilter(bareProperty, filter({ manager: 'CRC' }))).toBe(false);
    expect(matchesFilter(bareProperty, DEFAULT_PORTFOLIO_FILTER)).toBe(true);
  });
});

function FilterProbe() {
  const { filter: f, setMarket, setType, setManager, clear } = usePortfolioFilter();
  return (
    <div>
      <span data-testid="market">{f.market}</span>
      <span data-testid="type">{f.propertyType}</span>
      <span data-testid="manager">{f.manager}</span>
      <button onClick={() => setMarket('Columbus OH')}>set-market</button>
      <button onClick={() => setType('Flex')}>set-type</button>
      <button onClick={() => setManager('CRC')}>set-manager</button>
      <button onClick={clear}>clear</button>
    </div>
  );
}

describe('PortfolioFilterProvider persistence', () => {
  afterEach(() => cleanup());

  it('starts from the default filter with nothing stored', () => {
    render(<PortfolioFilterProvider><FilterProbe /></PortfolioFilterProvider>);
    expect(screen.getByTestId('market').textContent).toBe('all');
    expect(screen.getByTestId('type').textContent).toBe('all');
    expect(screen.getByTestId('manager').textContent).toBe('all');
  });

  it('persists each setter to sessionStorage under the ora-portfolio-filter key', () => {
    render(<PortfolioFilterProvider><FilterProbe /></PortfolioFilterProvider>);
    fireEvent.click(screen.getByText('set-market'));
    fireEvent.click(screen.getByText('set-type'));
    fireEvent.click(screen.getByText('set-manager'));

    expect(screen.getByTestId('market').textContent).toBe('Columbus OH');
    expect(screen.getByTestId('type').textContent).toBe('Flex');
    expect(screen.getByTestId('manager').textContent).toBe('CRC');

    const stored = JSON.parse(sessionStorage.getItem('ora-portfolio-filter') ?? '{}') as PortfolioFilterState;
    expect(stored).toEqual({ market: 'Columbus OH', propertyType: 'Flex', manager: 'CRC' });
  });

  it('rehydrates from sessionStorage on mount (survives a reload within the session)', () => {
    sessionStorage.setItem('ora-portfolio-filter', JSON.stringify({ market: 'Mid-Atlantic', propertyType: 'Industrial', manager: 'SVN' }));
    render(<PortfolioFilterProvider><FilterProbe /></PortfolioFilterProvider>);
    expect(screen.getByTestId('market').textContent).toBe('Mid-Atlantic');
    expect(screen.getByTestId('type').textContent).toBe('Industrial');
    expect(screen.getByTestId('manager').textContent).toBe('SVN');
  });

  it('ignores corrupt/invalid stored values and falls back to defaults per-field', () => {
    sessionStorage.setItem('ora-portfolio-filter', JSON.stringify({ market: 'Nowhereville', propertyType: 'Flex', manager: 42 }));
    render(<PortfolioFilterProvider><FilterProbe /></PortfolioFilterProvider>);
    expect(screen.getByTestId('market').textContent).toBe('all');
    expect(screen.getByTestId('type').textContent).toBe('Flex');
    expect(screen.getByTestId('manager').textContent).toBe('all');
  });

  it('clear() resets to the default filter and persists it', () => {
    render(<PortfolioFilterProvider><FilterProbe /></PortfolioFilterProvider>);
    fireEvent.click(screen.getByText('set-market'));
    fireEvent.click(screen.getByText('clear'));
    expect(screen.getByTestId('market').textContent).toBe('all');
    const stored = JSON.parse(sessionStorage.getItem('ora-portfolio-filter') ?? '{}') as PortfolioFilterState;
    expect(stored).toEqual(DEFAULT_PORTFOLIO_FILTER);
  });

  it('usePortfolioFilter throws when used outside the provider', () => {
    const Bare = () => { usePortfolioFilter(); return null; };
    expect(() => render(<Bare />)).toThrow(/usePortfolioFilter must be used within/);
  });
});

describe('PortfolioFilterBar', () => {
  afterEach(() => cleanup());

  it('renders Market/Type/Manager selects populated from the enums + the passed-in manager list', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={['CRC', 'SVN', 'Thomas Park']} />
      </PortfolioFilterProvider>,
    );
    const market = screen.getByLabelText(/filter by market/i) as HTMLSelectElement;
    const type = screen.getByLabelText(/filter by property type/i) as HTMLSelectElement;
    const manager = screen.getByLabelText(/filter by property manager/i) as HTMLSelectElement;

    expect(Array.from(market.options).map((o) => o.value)).toEqual([
      'all',
      'Columbus OH',
      'Mid-Atlantic',
      'Toledo OH',
      'Cleveland MSA',
      'Kansas City MO',
      'Indianapolis IN',
      'Other',
      'Unknown',
    ]);
    expect(Array.from(type.options).map((o) => o.value)).toEqual(['all', 'Flex', 'Retail', 'Industrial', 'Residence', 'Other']);
    expect(Array.from(manager.options).map((o) => o.value)).toEqual(['all', 'CRC', 'SVN', 'Thomas Park']);
  });

  it('renders only the "all" option for managers when the passed-in list is empty', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={[]} />
      </PortfolioFilterProvider>,
    );
    const manager = screen.getByLabelText(/filter by property manager/i) as HTMLSelectElement;
    expect(Array.from(manager.options).map((o) => o.value)).toEqual(['all']);
  });

  it('changing a select calls the matching setter and updates the active selection', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={['CRC']} />
      </PortfolioFilterProvider>,
    );
    const market = screen.getByLabelText(/filter by market/i) as HTMLSelectElement;
    fireEvent.change(market, { target: { value: 'Toledo OH' } });
    expect(market.value).toBe('Toledo OH');

    const manager = screen.getByLabelText(/filter by property manager/i) as HTMLSelectElement;
    fireEvent.change(manager, { target: { value: 'CRC' } });
    expect(manager.value).toBe('CRC');

    const stored = JSON.parse(sessionStorage.getItem('ora-portfolio-filter') ?? '{}') as PortfolioFilterState;
    expect(stored).toEqual({ market: 'Toledo OH', propertyType: 'all', manager: 'CRC' });
  });

  it('shows a Clear control only once a filter is active, and it resets all three selects', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={['CRC']} />
      </PortfolioFilterProvider>,
    );
    expect(screen.queryByLabelText(/clear portfolio filter/i)).toBeNull();

    const market = screen.getByLabelText(/filter by market/i) as HTMLSelectElement;
    fireEvent.change(market, { target: { value: 'Toledo OH' } });

    const clearBtn = screen.getByLabelText(/clear portfolio filter/i);
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn);
    expect(market.value).toBe('all');
    expect(screen.queryByLabelText(/clear portfolio filter/i)).toBeNull();
  });
});
