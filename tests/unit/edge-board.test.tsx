// tests/unit/edge-board.test.tsx — market board (spec §8.3, F3, F4).
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EdgeMarketsResponse, EdgeSeriesCell } from '@contracts/edge';
import { EdgeRankingBoard } from '../../src/modules/acquisitions/EdgeRankingBoard';
import { EDGE_BOARD_DEFAULT_STATE, type EdgeBoardState } from '../../src/modules/acquisitions/edge-hooks';
import { cell, fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function Harness({ data }: { data: EdgeMarketsResponse }) {
  const [board, setBoard] = useState<EdgeBoardState>(EDGE_BOARD_DEFAULT_STATE);
  return <EdgeRankingBoard data={data} board={board} onBoardChange={setBoard} />;
}

const bodyRows = () => screen.getAllByRole('row').slice(1);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EdgeRankingBoard', () => {
  it('defaults to the buy-box set sorted by trades momentum desc, with honest set counts', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByRole('radio', { name: 'Buy-box (3)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All (4)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Auto (1)' })).toBeTruthy();
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      expect.stringContaining('Indianapolis (South Metro), IN'),
      expect.stringContaining('Columbus, OH'),
      expect.stringContaining('Richmond, VA'),
    ]);
    expect(screen.queryByText('Cedar Rapids, IA')).toBeNull();
  });

  it('All shows every market, buy-box pinned on top', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByRole('radio', { name: 'All (4)' }));
    const first = bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
    expect(first).toHaveLength(4);
    expect(first[3]).toContain('Cedar Rapids, IA');
  });

  it('has no rank column', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(headers.some((h) => /rank|#|score/i.test(h))).toBe(false);
    expect(headers).toEqual(['Market', 'Trades momentum', 'Flex vacancy', 'Flex rent growth', 'Pipeline', 'Net migration', 'Population']);
  });

  it('migration shows its year suffix because 2024–25 are unpublished', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getAllByText('+1,200 (2023)')).toHaveLength(3);
  });

  it('F3: picker labels for the three proxies are trueLabel + [PROXY], never the raw key', () => {
    const { container } = render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByLabelText('Residential building permits authorized, growth (Census BPS) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Total business establishment count growth (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Courier/messenger establishment count growth, NAICS 492 (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.queryByLabelText('hvacPermits')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/hvacPermits|eGrocery/);
    expect(within(container).queryByText(/\bbiz\b/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Residential building permits authorized, growth (Census BPS) [PROXY]'));
    const proxyHeader = screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '')
      .find((h) => h.includes('Residential building permits'));
    expect(proxyHeader).toContain('[PROXY]');
    expect(container.textContent ?? '').not.toMatch(/hvacPermits|eGrocery/);
  });

  it('F4: adding the storage column renders Pending manual pull in every row, never 0', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByLabelText('Self-storage asking rate growth'));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Self-storage asking rate growth');
    expect(screen.getAllByText('— Pending manual pull')).toHaveLength(3);
  });

  it('truck renders Not yet available where null and the real value where observed', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByLabelText('Truck AADT growth on primary corridors (state DOT)'));
    expect(screen.getAllByText('— Not yet available')).toHaveLength(2);
    expect(screen.getByText('+2.2%')).toBeTruthy();
  });

  it('row click opens the detail panel; metro-only markets say so', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByText('Columbus, OH'));
    expect(screen.getByRole('region', { name: 'Columbus detail' })).toBeTruthy();
    expect(screen.getByText('Synthetic Sub A')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Auto (1)' }));
    fireEvent.click(screen.getByText('Cedar Rapids, IA'));
    expect(screen.getByText('CoStar publishes no submarket breakdown for this metro.')).toBeTruthy();
  });

  it('Details button is a real focusable button, toggles aria-expanded and opens that market', () => {
    // @testing-library/user-event is not a dependency (package.json is architect-owned), so Enter/Space
    // activation is exercised as the click a native <button> synthesizes; the test pins that it IS a native,
    // tabbable <button type=button> (no tabindex=-1), which is what makes Enter/Space work in a browser.
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const btn = screen.getByRole('button', { name: 'Show details for Columbus, OH' }) as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.tabIndex).toBe(0);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.hasAttribute('aria-controls')).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('region', { name: 'Columbus detail' });
    expect(panel.id).not.toBe('');
    expect(btn.getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.getByText('Synthetic Sub A')).toBeTruthy();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Columbus detail' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /details for/i })).toHaveLength(3);
  });

  it('estimated and nowcast cells expose Est. / Nowcast as text, not only title (board + detail)', () => {
    const markets = fourMarkets();
    const cedar = markets.find((m) => m.id === 'cedar_rapids')!;
    cedar.series = { ...cedar.series, vac: cell([5, 4.5, 4, 3.5, 3], ['actual', 'actual', 'actual', 'actual', 'nowcast']) };
    render(<Harness data={mkMarketsResponse(markets)} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Auto (1)' }));
    const row = bodyRows()[0]!;
    expect(within(row).getByText('Est.')).toBeTruthy();
    expect(within(row).getByText('Nowcast')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Cedar Rapids, IA' }));
    const panel = screen.getByRole('region', { name: 'Cedar Rapids detail' });
    expect(within(panel).getByText('Est.')).toBeTruthy();
    expect(within(panel).getByText('Nowcast')).toBeTruthy();
  });

  it('detail grid gates on status: non-null value with guide_only/null status shows the placeholder, never the number', () => {
    const markets = fourMarkets();
    const col = markets.find((m) => m.id === 'columbus')!;
    const bad: EdgeSeriesCell = cell([7.77, 8.88, null, null, null], ['guide_only', 'null', 'null', 'null', 'null']);
    col.series = { ...col.series, pop: bad };
    render(<Harness data={mkMarketsResponse(markets)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Columbus, OH' }));
    const panel = screen.getByRole('region', { name: 'Columbus detail' });
    expect(within(panel).queryByText(/7\.8|7\.77|8\.9|8\.88/)).toBeNull();
    expect(within(panel).getAllByText('Pending manual pull').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Not published').length).toBeGreaterThan(0);
  });

  it('selection clears when the set filter hides the selected market', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Auto (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Cedar Rapids, IA' }));
    expect(screen.getByRole('region', { name: 'Cedar Rapids detail' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Buy-box (3)' }));
    expect(screen.queryByRole('region')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Auto (1)' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show details for Cedar Rapids, IA' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('Pin buy-box is disabled (with an explanatory title) unless the set is All', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const pin = screen.getByLabelText('Pin buy-box') as HTMLInputElement;
    expect(pin.disabled).toBe(true);
    expect(pin.title).toBe('Pinning applies only under the All set');
    fireEvent.click(screen.getByRole('radio', { name: 'All (4)' }));
    expect(pin.disabled).toBe(false);
    expect(pin.title).toBe('');
  });

  it('pin on keeps buy-box markets above Auto; pin off lets the sort interleave them', () => {
    // Cedar Rapids (auto) has the highest latest trades value (9.0, estimated).
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByRole('radio', { name: 'All (4)' }));
    const names = () => bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
    expect(names()[3]).toContain('Cedar Rapids, IA');
    fireEvent.click(screen.getByLabelText('Pin buy-box'));
    expect(names()[0]).toContain('Cedar Rapids, IA');
    fireEvent.click(screen.getByLabelText('Pin buy-box'));
    expect(names()[3]).toContain('Cedar Rapids, IA');
  });

  it('sort key and direction controls reorder the rows', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const names = () => bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
    fireEvent.change(screen.getByLabelText('Sort board by'), { target: { value: 'name' } });
    fireEvent.click(screen.getByRole('button', { name: /Sort direction: descending/ }));
    expect(names()).toEqual([
      expect.stringContaining('Columbus, OH'), expect.stringContaining('Indianapolis'), expect.stringContaining('Richmond, VA'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /Sort direction: ascending/ }));
    expect(names()[0]).toContain('Richmond, VA');
  });

  it('aria-controls is present only on the expanded Details button', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const buttons = () => screen.getAllByRole('button', { name: /details for/i });
    expect(buttons().every((b) => !b.hasAttribute('aria-controls'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Columbus, OH' }));
    const withControls = buttons().filter((b) => b.hasAttribute('aria-controls'));
    expect(withControls).toHaveLength(1);
    expect(withControls[0]!.getAttribute('aria-label')).toBe('Show details for Columbus, OH');
  });

  it('sort direction button exposes its current direction', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByRole('button', { name: /Sort direction: descending/ }));
    expect(screen.getByRole('button', { name: /Sort direction: ascending/ })).toBeTruthy();
  });

  it('always shows the CoStar Flex footnote', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByText(/Rent \/ vacancy \/ pipeline are CoStar Industrial Flex slice — not a ≤50K SF cut\./)).toBeTruthy();
  });
});
