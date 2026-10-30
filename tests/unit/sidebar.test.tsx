import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewProfileProvider } from '../../src/brain/view-profile';
import { Sidebar } from '../../src/shell/Sidebar';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function setup(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onSelect = vi.fn();
  const onMobileClose = vi.fn();
  // The rail's badges read the same react-query data the tabs do, so it needs a client (the app always has one).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ViewProfileProvider>
        <Sidebar
          activeId="overview"
          onSelect={onSelect}
          collapsed={false}
          onToggle={vi.fn()}
          mobileOpen
          onMobileClose={onMobileClose}
          {...props}
        />
      </ViewProfileProvider>
    </QueryClientProvider>,
  );
  return { onSelect, onMobileClose };
}

describe('Sidebar drawer mode', () => {
  it('renders a scrim that closes the drawer when open', () => {
    const { onMobileClose } = setup();
    fireEvent.click(screen.getByLabelText(/close navigation/i));
    expect(onMobileClose).toHaveBeenCalled();
  });

  it('selecting a nav item also closes the drawer', () => {
    const { onSelect, onMobileClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: /portfolio/i }));
    expect(onSelect).toHaveBeenCalled();
    expect(onMobileClose).toHaveBeenCalled();
  });

  it('closes the drawer when Escape is pressed', () => {
    const { onMobileClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onMobileClose).toHaveBeenCalled();
  });
});
