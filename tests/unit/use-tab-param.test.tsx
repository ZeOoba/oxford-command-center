import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { useTabParam } from '../../src/lib/useTabParam';

afterEach(() => cleanup());

const KEYS = ['positions', 'scorecard', 'maturities'] as const;

function Harness({ defaultKey = 'positions' as (typeof KEYS)[number] }) {
  const [tab, setTab] = useTabParam(KEYS, defaultKey);
  const location = useLocation();
  const navType = useNavigationType();
  return (
    <div>
      <span data-testid="current">{tab}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="nav-type">{navType}</span>
      {KEYS.map((k) => (
        <button key={k} onClick={() => setTab(k)}>
          {k}
        </button>
      ))}
    </div>
  );
}

function renderWithRoute(initialEntry: string, defaultKey?: (typeof KEYS)[number]) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Harness defaultKey={defaultKey} />
    </MemoryRouter>,
  );
}

describe('useTabParam / default and missing param', () => {
  it('falls back to the default key when no tab param is present, without writing the URL', () => {
    renderWithRoute('/debt');
    expect(screen.getByTestId('current').textContent).toBe('positions');
    expect(screen.getByTestId('search').textContent).toBe('');
  });
});

describe('useTabParam / valid param', () => {
  it('reads a valid tab param from the URL on mount', () => {
    renderWithRoute('/debt?tab=scorecard');
    expect(screen.getByTestId('current').textContent).toBe('scorecard');
  });
});

describe('useTabParam / invalid param', () => {
  it('falls back to the default key for an unknown tab value', () => {
    renderWithRoute('/debt?tab=not-a-real-tab');
    expect(screen.getByTestId('current').textContent).toBe('positions');
  });
});

describe('useTabParam / preserves other params', () => {
  it('keeps ?scenario= intact when the tab is switched', () => {
    renderWithRoute('/debt?scenario=Upside');
    fireEvent.click(screen.getByText('scorecard'));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).toContain('scenario=Upside');
    expect(search).toContain('tab=scorecard');
  });
});

describe('useTabParam / default-key removal', () => {
  it('removes the tab param entirely when switching back to the default key', () => {
    renderWithRoute('/debt?tab=scorecard');
    fireEvent.click(screen.getByText('positions'));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).not.toContain('tab=');
  });

  it('never writes ?tab= for the default key even on first switch away and back', () => {
    renderWithRoute('/debt');
    fireEvent.click(screen.getByText('scorecard'));
    expect(screen.getByTestId('search').textContent).toContain('tab=scorecard');
    fireEvent.click(screen.getByText('positions'));
    expect(screen.getByTestId('search').textContent).toBe('');
  });
});

describe('useTabParam / replace semantics', () => {
  it('navigates via REPLACE, not PUSH, on a tab switch', () => {
    renderWithRoute('/debt');
    fireEvent.click(screen.getByText('scorecard'));
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE');
    expect(screen.getByTestId('current').textContent).toBe('scorecard');
  });
});
