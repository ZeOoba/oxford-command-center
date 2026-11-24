// Tier 3 UI hygiene (2026-11-23 review): the hand-rolled drawers set aria-modal but never trapped
// focus or returned it on close, and each carried its own Escape listener.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useDialogFocus } from '../../src/lib/useDialogFocus';

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button>first</button>
      <button>last</button>
    </div>
  );
}

function Host({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && <Dialog onClose={() => { onClose(); setOpen(false); }} />}
    </>
  );
}

afterEach(cleanup);

describe('useDialogFocus', () => {
  it('moves focus into the dialog on open', () => {
    render(<Host onClose={() => {}} />);
    fireEvent.click(screen.getByText('opener'));
    expect(document.activeElement).toBe(screen.getByText('first'));
  });

  it('Escape closes and focus returns to the opener', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('Tab wraps from the last element to the first, Shift+Tab from first to last', () => {
    render(<Host onClose={() => {}} />);
    fireEvent.click(screen.getByText('opener'));
    const first = screen.getByText('first');
    const last = screen.getByText('last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
