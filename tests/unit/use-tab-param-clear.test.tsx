import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useTabParam, CLEAR_VIEW } from '../../src/lib/useTabParam';

const KEYS = ['a', 'b', 'c'] as const;
function Probe({ clear }: { clear?: readonly string[] }) {
  const [tab, setTab] = useTabParam<(typeof KEYS)[number]>(KEYS, 'a', 'tab', clear);
  const loc = useLocation();
  return (
    <>
      <output data-testid="tab">{tab}</output>
      <output data-testid="loc">{loc.search}</output>
      <button onClick={() => setTab('b')}>to-b</button>
      <button onClick={() => setTab('a')}>to-a</button>
    </>
  );
}
const go = (clear?: readonly string[]) =>
  render(<MemoryRouter initialEntries={['/x?tab=c&view=pending&scenario=Upside']}><Probe clear={clear} /></MemoryRouter>);
afterEach(cleanup);

describe('useTabParam clearOnChange', () => {
  it('clears the named params on a tab change, keeping the rest', () => {
    go(CLEAR_VIEW);
    fireEvent.click(screen.getByText('to-b'));
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!);
    expect(q.get('tab')).toBe('b');
    expect(q.has('view')).toBe(false);
    expect(q.get('scenario')).toBe('Upside');
  });
  it('also clears when switching back to the default (tab param removed)', () => {
    go(CLEAR_VIEW);
    fireEvent.click(screen.getByText('to-a'));
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!);
    expect(q.has('tab')).toBe(false);
    expect(q.has('view')).toBe(false);
  });
  it('never deletes the param it just set, even when clearOnChange names it', () => {
    // A caller passing a list that happens to include its own paramName (e.g. a shared
    // CLEAR_* constant reused on a `view` strip) would otherwise silently reset to the default.
    go(['view', 'tab']);
    fireEvent.click(screen.getByText('to-b'));
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!);
    expect(q.get('tab')).toBe('b');
    expect(screen.getByTestId('tab').textContent).toBe('b');
    expect(q.has('view')).toBe(false);
  });

  it('is a no-op when no clear list is given (existing behaviour)', () => {
    go();
    fireEvent.click(screen.getByText('to-b'));
    expect(new URLSearchParams(screen.getByTestId('loc').textContent!).get('view')).toBe('pending');
  });
});
