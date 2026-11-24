// src/lib/useDialogFocus.ts
//
// Modal focus behaviour for the hand-rolled dialogs (DealDrawer, EntityDrawer, DraftPanel). They set
// aria-modal but never moved focus in, trapped Tab, or returned focus on close, and each carried its
// own Escape listener (2026-11-23 review, Tier 3). This hook is that behaviour in one place, without
// restructuring their framer-motion markup.
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert'));
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  // Latest onClose without re-running the mount effect (which would re-steal focus on every render).
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first = focusables(root)[0];
      if (first) first.focus();
      else {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = focusables(ref.current);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only; ref is stable
  }, []);
}

/** For a dialog rendered conditionally inside a parent that stays mounted (e.g. inside
 *  AnimatePresence): render this inside the dialog so the behaviour mounts and unmounts with it. */
export function DialogFocus({ target, onClose }: { target: RefObject<HTMLElement | null>; onClose: () => void }): null {
  useDialogFocus(target, onClose);
  return null;
}
