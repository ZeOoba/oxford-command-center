import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSnapshotGate } from '../../src/shell/SnapshotGate';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Probe() {
  const gate = useSnapshotGate();
  return gate ?? <div>ready</div>;
}
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('useSnapshotGate', () => {
  it('renders the Brain Server error with Retry when the snapshot fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    wrap(<Probe />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Retry/)).toBeTruthy();
  });

  it.each([
    'portfolio/PortfolioModule', 'leases/LeasesModule', 'renewals/RenewalsModule', 'tenants/TenantsModule',
    'close/CloseModule', 'cash/CashModule', 'tasks/TasksModule', 'calendar/CalendarModule',
  ])('%s uses the gate (no silent blank screen)', (m) => {
    expect(readFileSync(`src/modules/${m}.tsx`, 'utf8')).toContain('useSnapshotGate()');
  });
});
