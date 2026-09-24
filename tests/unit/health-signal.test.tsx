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

  // Feed fold-in (2026-09-23 review, gap #2): the stale-feed monitor never reached the
  // always-visible dot before this fix — only the System Health module (off the nav rail) saw it.
  it('warn: any feed stale, even with zero data-quality flags', () => {
    const s = computeHealthSignal(fresh('live', 'Live'), [], [{ status: 'stale' }]);
    expect(s.tone).toBe('warn');
    expect(s.detail).toBe('1 feed stale');
  });
  it('missing counts as stale for the dot', () => {
    const s = computeHealthSignal(fresh('live', 'Live'), [], [{ status: 'missing' }, { status: 'fresh' }]);
    expect(s.tone).toBe('warn');
    expect(s.detail).toBe('1 feed stale');
  });
  it('fresh-only feeds never move the tone', () => {
    expect(computeHealthSignal(fresh('live', 'Live'), [], [{ status: 'fresh' }, { status: 'fresh' }]).tone).toBe('ok');
  });
  it('a stale feed never downgrades an existing error from stale/offline data', () => {
    const s = computeHealthSignal(fresh('offline', 'Offline'), [], [{ status: 'stale' }, { status: 'missing' }]);
    expect(s.tone).toBe('error');
  });
  it('a stale feed never downgrades an existing data-quality error', () => {
    const s = computeHealthSignal(fresh('live', 'Live'), [{ severity: 'error' }], [{ status: 'missing' }]);
    expect(s.tone).toBe('error');
  });

  // MINOR (review follow-up): a data-quality warning and a stale feed are independent signals —
  // one must not silently win over the other in the detail text.
  it('keeps BOTH reasons in the detail when data-quality warnings and stale feeds coexist', () => {
    const s = computeHealthSignal(fresh('live', 'Live'), [{ severity: 'warn' }, { severity: 'warn' }], [{ status: 'stale' }]);
    expect(s.tone).toBe('warn');
    expect(s.detail).toBe('2 data-quality warnings · 1 feed stale');
  });
});

const setActiveModule = vi.fn();
const brain = { state: null as unknown };
const snap = { data: undefined as unknown };
const health: { data: unknown } = { data: undefined };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => brain }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ setActiveModule }) }));
vi.mock('../../src/data/health', () => ({ useHealth: () => health }));

import { HealthDot } from '../../src/shell/HealthDot';

afterEach(() => {
  cleanup();
  health.data = undefined;
});

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

  // Feed fold-in (2026-09-23 review, gap #2).
  it('folds a stale /api/health feed into the dot even with no data-quality flags', () => {
    brain.state = { status: 'ok', source: 'workbook', lastUpdated: new Date().toISOString() };
    snap.data = { snapshot: { dataQuality: [] } };
    health.data = { feeds: [{ id: 'cashHistory', label: 'Cash history', lastAt: null, ageDays: 50, maxAgeDays: 40, status: 'stale', fix: 'x' }] };
    render(<HealthDot />);
    const btn = screen.getByRole('button', { name: /System health: Warnings — 1 feed stale/ });
    expect(btn.getAttribute('data-health-tone')).toBe('warn');
  });

  it('a missing feed also folds in as at-least-warn', () => {
    brain.state = { status: 'ok', source: 'workbook', lastUpdated: new Date().toISOString() };
    snap.data = { snapshot: { dataQuality: [] } };
    health.data = { feeds: [{ id: 'leaseMarket', label: 'Lease market', lastAt: null, ageDays: null, maxAgeDays: 14, status: 'missing', fix: 'x' }] };
    render(<HealthDot />);
    expect(screen.getByRole('button', { name: /System health: Warnings — 1 feed stale/ }).getAttribute('data-health-tone')).toBe('warn');
  });

  it('never downgrades an existing error (offline data) even when every feed is fresh', () => {
    brain.state = { status: 'error', source: 'none', lastUpdated: null };
    snap.data = { snapshot: { dataQuality: [] } };
    health.data = { feeds: [{ id: 'snapshot', label: 'Workbook snapshot', lastAt: new Date().toISOString(), ageDays: 0, maxAgeDays: 2, status: 'fresh', fix: 'x' }] };
    render(<HealthDot />);
    expect(screen.getByRole('button', { name: /System health: Attention needed/ }).getAttribute('data-health-tone')).toBe('error');
  });
});
