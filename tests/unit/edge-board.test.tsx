// tests/unit/edge-board.test.tsx — market board (spec §8.3, F3, F4).
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EdgeMarketsResponse } from '@contracts/edge';
import { EdgeRankingBoard } from '../../src/modules/acquisitions/EdgeRankingBoard';
import { EDGE_BOARD_DEFAULT_STATE, type EdgeBoardState } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

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
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByLabelText('Residential building permits authorized, growth (Census BPS) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Total business establishment count growth (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Courier/messenger establishment count growth, NAICS 492 (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.queryByLabelText('hvacPermits')).toBeNull();
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

  it('always shows the CoStar Flex footnote', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByText(/Rent \/ vacancy \/ pipeline are CoStar Industrial Flex slice — not a ≤50K SF cut\./)).toBeTruthy();
  });
});
