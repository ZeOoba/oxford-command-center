import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { ViewProfileProvider } from '../../src/brain/view-profile';
import { Sidebar } from '../../src/shell/Sidebar';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function setup(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onSelect = vi.fn();
  const onMobileClose = vi.fn();
  render(
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
    </ViewProfileProvider>,
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
});
