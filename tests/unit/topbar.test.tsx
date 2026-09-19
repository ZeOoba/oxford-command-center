import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ refresh: vi.fn(), refreshing: false }) }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ toggleAi: vi.fn() }) }));
vi.mock('../../src/shell/ScenarioSwitch', () => ({ ScenarioSwitch: () => <div data-testid="scenario" /> }));
vi.mock('../../src/shell/ViewToggle', () => ({ ViewToggle: () => <div data-testid="view" /> }));
vi.mock('../../src/shell/ThemeToggle', () => ({ ThemeToggle: () => <div data-testid="theme" /> }));
vi.mock('../../src/shell/DensityToggle', () => ({ DensityToggle: () => <div data-testid="density" /> }));
vi.mock('../../src/primitives/StatusPill', () => ({ StatusPill: () => <div data-testid="status" /> }));
vi.mock('../../src/shell/AlertBell', () => ({ AlertBell: () => <div data-testid="alert-bell" /> }));
vi.mock('../../src/shell/HealthDot', () => ({ HealthDot: () => <div data-testid="health-dot" /> }));

import { TopBar } from '../../src/shell/TopBar';

afterEach(() => cleanup());

describe('TopBar mobile controls', () => {
  it('calls onOpenNav when the hamburger is clicked', () => {
    const onOpenNav = vi.fn();
    render(<TopBar title="Overview" asOf="" onOpenNav={onOpenNav} />);
    fireEvent.click(screen.getByLabelText(/open navigation/i));
    expect(onOpenNav).toHaveBeenCalled();
  });

  it('exposes a More button for secondary controls', () => {
    render(<TopBar title="Overview" asOf="" onOpenNav={vi.fn()} />);
    expect(screen.getByLabelText(/more controls/i)).toBeTruthy();
  });

  it('closes the More popover on Escape', () => {
    render(<TopBar title="Overview" asOf="" onOpenNav={vi.fn()} />);
    const more = screen.getByLabelText(/more controls/i);
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('restores focus to the hamburger when the drawer closes', () => {
    const { rerender } = render(<TopBar title="Overview" asOf="" onOpenNav={vi.fn()} navOpen />);
    rerender(<TopBar title="Overview" asOf="" onOpenNav={vi.fn()} navOpen={false} />);
    expect(document.activeElement).toBe(screen.getByLabelText(/open navigation/i));
  });
});
