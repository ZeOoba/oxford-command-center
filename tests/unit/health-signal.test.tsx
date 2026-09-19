// IA decongestion Phase 4a — System Health left the rail; the TopBar dot carries the signal.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Freshness } from '../../src/lib/freshness';
import { computeHealthSignal } from '../../src/lib/healthSignal';

const fresh = (kind: Freshness['kind'], label: string = kind, detail: string | null = null): Freshness => ({
  kind, label, detail, bakeAgeMs: null, isStale: kind === 'stale',
});

describe('computeHealthSignal (same severity semantics as HealthModule)', () => {
  it('healthy: live/static feed and no flags', () => {
    expect(computeHealthSignal(fresh('live', 'Live'), []).tone).toBe('ok');
    expect(computeHealthSignal(fresh('static', 'Static'), []).tone).toBe('ok');
    expect(computeHealthSignal(fresh('refreshing', 'Refreshing'), []).tone).toBe('ok');
  });
  it('error: stale or offline data', () => {
    expect(computeHealthSignal(fresh('stale', 'Stale', 'baked 3d ago'), []).tone).toBe('error');
    expect(computeHealthSignal(fresh('offline', 'Offline'), []).tone).toBe('error');
  });
  it('error: any error-severity data-quality flag; warn: warn flags only; info flags are ignored', () => {
    expect(computeHealthSignal(fresh('live', 'Live'), [{ severity: 'error' }, { severity: 'warn' }]).tone).toBe('error');
    const w = computeHealthSignal(fresh('live', 'Live'), [{ severity: 'warn' }, { severity: 'warn' }]);
    expect(w.tone).toBe('warn');
    expect(w.detail).toBe('2 data-quality warnings');
    expect(computeHealthSignal(fresh('live', 'Live'), [{ severity: 'info' }]).tone).toBe('ok');
  });
  it('neutral while connecting (never a false green)', () => {
    expect(computeHealthSignal(fresh('connecting', 'Connecting'), []).tone).toBe('neutral');
  });
  it('error outranks warn outranks ok', () => {
    expect(computeHealthSignal(fresh('stale', 'Stale'), [{ severity: 'warn' }]).tone).toBe('error');
  });
});

const setActiveModule = vi.fn();
const brain = { state: null as unknown };
const snap = { data: undefined as unknown };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => brain }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ setActiveModule }) }));

import { HealthDot } from '../../src/shell/HealthDot';

afterEach(cleanup);

describe('HealthDot', () => {
  it('is a button with an accessible name carrying tone + reason, and opens /health', () => {
    brain.state = { status: 'ok', source: 'workbook', lastUpdated: new Date().toISOString() };
    snap.data = { snapshot: { dataQuality: [{ severity: 'warn' }] } };
    render(<HealthDot />);
    const btn = screen.getByRole('button', { name: /System health: Warnings — 1 data-quality warning/ });
    expect(btn.getAttribute('data-health-tone')).toBe('warn');
    fireEvent.click(btn);
    expect(setActiveModule).toHaveBeenCalledWith('health');
  });

  it('is neutral (not green) before the feed connects', () => {
    brain.state = null;
    snap.data = undefined;
    render(<HealthDot />);
    expect(screen.getByRole('button', { name: /System health: Checking/ }).getAttribute('data-health-tone')).toBe('neutral');
  });
});
