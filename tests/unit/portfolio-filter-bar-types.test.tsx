// Tier 2 (2026-11-23 review): the residence is excluded from every surface (ruling 2026-10-30), yet
// the global Type filter still offered "Residence", a choice that can only ever match nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PortfolioFilterProvider } from '../../src/shell/PortfolioFilterContext';
import { PortfolioFilterBar } from '../../src/shell/PortfolioFilterBar';

afterEach(cleanup);

describe('PortfolioFilterBar type options', () => {
  it('offers every investment property type and never Residence', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={[]} />
      </PortfolioFilterProvider>,
    );
    const select = screen.getByLabelText('Filter by property type') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('Industrial');
    expect(values).toContain('Flex');
    expect(values).not.toContain('Residence');
  });
});
