import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TabPanel } from 'react-aria-components';
import { Tabs, type TabSpec } from '../../src/primitives/Tabs';

afterEach(() => cleanup());

const THREE_TABS: TabSpec[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

// A tiny controlled wrapper (mirrors how a real module pairs Tabs with useState/useTabParam).
function Harness({
  tabs = THREE_TABS,
  initial = 'a',
  keyboardActivation,
  onChange,
}: {
  tabs?: TabSpec[];
  initial?: string;
  keyboardActivation?: 'automatic' | 'manual';
  onChange?: (key: string) => void;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <Tabs
      tabs={tabs}
      selectedKey={selected}
      onSelectionChange={(k: string) => {
        setSelected(k);
        onChange?.(k);
      }}
      keyboardActivation={keyboardActivation}
      aria-label="Test tabs"
    >
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id}>
          Panel {t.label}
        </TabPanel>
      ))}
    </Tabs>
  );
}

describe('Tabs / roles and aria', () => {
  it('renders a tablist, tabs, and the selected tabpanel with aria-selected wired up', () => {
    render(<Harness initial="b" />);
    expect(screen.getByRole('tablist', { name: 'Test tabs' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    const betaTab = screen.getByRole('tab', { name: 'Beta' });
    expect(betaTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    expect(screen.getByText('Panel Beta')).toBeTruthy();
  });
});

describe('Tabs / automatic keyboard activation', () => {
  it('moves and selects on ArrowRight without requiring Enter/Space', () => {
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Tabs / manual keyboard activation', () => {
  it('moves focus on ArrowRight without selecting until Enter/Space', () => {
    const onChange = vi.fn();
    render(<Harness initial="a" keyboardActivation="manual" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    // Focus moved but selection (and therefore onChange) must not have fired yet.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Alpha' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Tabs / badge', () => {
  it('caps a badge count display at 99+', () => {
    render(
      <Harness
        tabs={[
          { id: 'a', label: 'Alpha', badge: { count: 140, tone: 'red' } },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('renders nothing for a badge count of 0', () => {
    render(
      <Harness
        tabs={[
          { id: 'a', label: 'Alpha', badge: { count: 0, tone: 'red' } },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders the exact count under 99', () => {
    render(
      <Harness
        tabs={[
          { id: 'a', label: 'Alpha', badge: { count: 3, tone: 'amber' } },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    expect(screen.getByText('3')).toBeTruthy();
  });
});

describe('Tabs / group divider', () => {
  it('renders a divider (left border) only on the tab where the group changes', () => {
    render(
      <Harness
        tabs={[
          { id: 'a', label: 'Alpha', group: 'intelligence' },
          { id: 'b', label: 'Beta', group: 'intelligence' },
          { id: 'c', label: 'Gamma', group: 'data-ops' },
        ]}
      />,
    );
    // One divider before the first data-ops tab; none between the two intelligence tabs,
    // none on the very first tab (nothing precedes it to diverge from).
    expect(screen.getByRole('tab', { name: 'Alpha' }).style.borderLeft).toBe('');
    expect(screen.getByRole('tab', { name: 'Beta' }).style.borderLeft).toBe('');
    expect(screen.getByRole('tab', { name: 'Gamma' }).style.borderLeft).not.toBe('');
  });

  it('renders no divider when no tab declares a group', () => {
    render(<Harness />);
    for (const t of THREE_TABS) {
      expect(screen.getByRole('tab', { name: t.label }).style.borderLeft).toBe('');
    }
  });
});
