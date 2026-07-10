import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaceholderBanner } from '../../src/primitives/PlaceholderBanner';

afterEach(cleanup);

describe('PlaceholderBanner', () => {
  it('renders label, detail, and role=status', () => {
    render(<PlaceholderBanner detail="Synthetic loss runs pending broker data." />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('PLACEHOLDER DATA');
    expect(banner.textContent).toContain('Synthetic loss runs pending broker data.');
  });

  it('accepts a custom label', () => {
    render(<PlaceholderBanner label="PLACEHOLDER BASIS" detail="x" />);
    expect(screen.getByRole('status').textContent).toContain('PLACEHOLDER BASIS');
  });
});
