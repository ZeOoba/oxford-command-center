import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KpiStat } from '../../src/primitives/KpiStat';

afterEach(() => cleanup());

describe('KpiStat interactive mode', () => {
  it('is not interactive (no button/link role) when onPress/href are absent', () => {
    render(<KpiStat label="Static" value={100} format={(n) => String(n)} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('calls onPress when clicked, and renders as a button', () => {
    const onPress = vi.fn();
    render(<KpiStat label="Clickable" value={100} format={(n) => String(n)} onPress={onPress} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders as a link when href is provided', () => {
    render(<KpiStat label="Linked" value={100} format={(n) => String(n)} href="/portfolio" />);
    // NB: this repo does not wire jest-dom matcher types into tsc (see
    // tests/unit/intel-ownership-smoke.test.tsx), so assert via getAttribute
    // rather than toHaveAttribute to keep the typecheck gate green.
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/portfolio');
  });
});
