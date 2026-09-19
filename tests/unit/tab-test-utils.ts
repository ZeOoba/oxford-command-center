// Shared helpers for the Phase 3 (IA decongestion) per-module tab tests.
//
// The split panels use `FORCE_MOUNT_PANEL` (src/lib/forceMountPanel.ts), so an inactive panel stays
// in the DOM — react-aria-components marks it `inert` + `data-inert` and the panel carries the
// `data-[inert]:hidden` class that hides it. jsdom doesn't evaluate the Tailwind class, so
// "hidden until its tab is selected" is asserted structurally: inside an inert panel, and that
// panel carrying the hiding class.
import { fireEvent, screen } from '@testing-library/react';

export function inertPanelOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('[data-inert]');
}

/** True when `el` sits in a panel that is currently inactive (inert) — i.e. not visible/reachable. */
export function isInInactivePanel(el: Element): boolean {
  return inertPanelOf(el) !== null;
}

/** An inactive force-mounted panel must actually be hidden, not just inert. */
export function inactivePanelIsHiddenByClass(el: Element): boolean {
  const panel = inertPanelOf(el);
  return panel !== null && panel.className.includes('data-[inert]:hidden');
}

export function selectTab(name: string | RegExp): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

export function tabIsSelected(name: string | RegExp): boolean {
  return screen.getByRole('tab', { name }).getAttribute('aria-selected') === 'true';
}
