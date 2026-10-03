// IA decongestion Phase 4a — the command palette indexes "Destination > Tab" so every module
// absorbed into a destination stays findable, and selecting one navigates to /<dest>?tab=<id>.
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const openTab = vi.fn();
const closePalette = vi.fn();
vi.mock('../../src/brain/ui-context', () => ({
  useUi: () => ({ paletteOpen: true, closePalette, setActiveModule: vi.fn(), openEntity: vi.fn(), openTab }),
}));
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => ({ data: undefined }) }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ refresh: vi.fn() }) }));
vi.mock('../../src/shell/tab-badges', () => ({
  useAlertsTabBadge: () => undefined,
  useCriticalDatesTabBadge: () => undefined,
  useTabBadges: (tabs: ReadonlyArray<unknown>) => tabs.map(() => undefined),
  useTabSpecs: (tabs: ReadonlyArray<{ id: string; label: string }>) => tabs.map((t) => ({ id: t.id, label: t.label })),
}));

import { CommandPalette } from '../../src/brain/CommandPalette';

beforeAll(() => {
  // cmdk needs these in jsdom.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CommandPalette — tab entries', () => {
  it('lists Destination > Tab entries for the absorbed modules', () => {
    render(<CommandPalette />);
    for (const label of ['Worklist › Today', 'Worklist › Alerts', 'Worklist › Calendar', 'Worklist › Renewals',
      'Data › Imports', 'Data › Quality', 'Data › Mappings', 'Data › Calibration', 'Data › Documents',
      'Financials › Ownership', 'Financials › Lease Run']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('indexes the two in-module strips registered last (Acquisitions, Lease Market)', () => {
    render(<CommandPalette />);
    for (const label of ['Acquisitions › Workbench', 'Acquisitions › Sourcing', 'Acquisitions › Grader', 'Acquisitions › Edge',
      'Lease Market › Acquisition Radar', 'Lease Market › Data Quality']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('selecting an Acquisitions tab entry navigates to /pipeline?tab=<id>', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('Acquisitions › Grader'));
    expect(openTab).toHaveBeenCalledWith('pipeline', 'grader');
  });

  it('selecting an entry navigates to the destination tab and closes the palette', () => {
    render(<CommandPalette />);
    fireEvent.click(screen.getByText('Data › Calibration'));
    expect(openTab).toHaveBeenCalledWith('data', 'calibration');
    expect(closePalette).toHaveBeenCalled();
  });

  it('System Health stays findable although it left the rail', () => {
    render(<CommandPalette />);
    expect(screen.getByText('Go to System Health')).toBeTruthy();
  });
});
