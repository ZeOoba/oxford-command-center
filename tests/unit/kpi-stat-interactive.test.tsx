import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, within, fireEvent, cleanup, act } from '@testing-library/react';
import type { Provenance as ProvenanceData } from '../../src/contracts/index';
import { KpiStat } from '../../src/primitives/KpiStat';

afterEach(() => cleanup());

// Every query below is scoped to the component's own render `container` (via
// `within`) rather than the global `screen`, which searches the whole
// document.body. KpiStat renders its button/link INLINE — never through a portal —
// so container scope still captures everything it produces, while keeping these
// assertions immune to stray nodes other files leave in document.body under the
// full suite's known jsdom/worker instability (see tests/unit/test-isolation.test.ts).

describe('KpiStat interactive mode', () => {
  it('is not interactive (no button/link role) when onPress/href are absent', () => {
    const { container } = render(<KpiStat label="Static" value={100} format={(n) => String(n)} />);
    const q = within(container);
    expect(q.queryByRole('button')).toBeNull();
    expect(q.queryByRole('link')).toBeNull();
  });

  it('calls onPress when the corner action button is clicked', () => {
    const onPress = vi.fn();
    const { container } = render(
      <KpiStat label="Clickable" value={100} format={(n) => String(n)} onPress={onPress} />,
    );
    // The action lives in a small, dedicated corner control — NOT the whole card —
    // and carries a meaningful accessible name.
    const action = within(container).getByRole('button', { name: 'View Clickable' });
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders the corner action as a link when href is provided', () => {
    const { container } = render(
      <KpiStat label="Linked" value={100} format={(n) => String(n)} href="/portfolio" />,
    );
    // NB: this repo does not wire jest-dom matcher types into tsc (see
    // tests/unit/intel-ownership-smoke.test.tsx), so assert via getAttribute
    // rather than toHaveAttribute to keep the typecheck gate green.
    const link = within(container).getByRole('link', { name: 'View Linked' });
    expect(link.getAttribute('href')).toBe('/portfolio');
  });

  it('renders Provenance and the action control as independent siblings (no nested interactive content)', () => {
    const onPress = vi.fn();
    const prov: ProvenanceData = { source: 'Master Workbook › N20', confidence: 'confirmed' };
    const { container } = render(
      <KpiStat label="Combo" value={100} format={(n) => String(n)} prov={prov} onPress={onPress} />,
    );
    const q = within(container);

    // Two independent interactive elements: the Provenance value trigger (a
    // role="button" span from react-aria) and the corner action button. The
    // previous whole-card-is-a-button design nested the former inside the latter,
    // which is invalid HTML and breaks keyboard/AT semantics.
    const buttons = q.getAllByRole('button');
    expect(buttons).toHaveLength(2);

    const action = q.getByRole('button', { name: 'View Combo' });
    const provTrigger = buttons.find((b) => b !== action);
    expect(provTrigger).toBeTruthy();
    if (!provTrigger) throw new Error('Provenance trigger not found');

    // Neither interactive element is an ancestor of the other — they are siblings.
    expect(action.contains(provTrigger)).toBe(false);
    expect(provTrigger.contains(action)).toBe(false);

    // Both are independently focusable (the span carries tabIndex=0; the button is
    // natively focusable), so keyboard Tab order has two distinct, unambiguous stops.
    // Focusing the Provenance trigger opens its react-aria tooltip (a state update),
    // so wrap the raw DOM focus calls in act().
    act(() => action.focus());
    expect(document.activeElement).toBe(action);
    act(() => provTrigger.focus());
    expect(document.activeElement).toBe(provTrigger);

    // Activating the action still triggers the drill-down.
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
