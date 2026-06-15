import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWorkspaces } from '../../src/brain/useWorkspaces';

const KEY = 'ora-overview-workspaces';
const IDS = ['kpis', 'alerts', 'leases', 'cash'];

beforeEach(() => {
  localStorage.clear();
});

describe('useWorkspaces', () => {
  it('starts on a Default workspace showing every widget in order', () => {
    const { result } = renderHook(() => useWorkspaces(IDS));
    expect(result.current.active).toBe('Default');
    expect(result.current.workspaceNames).toEqual(['Default']);
    expect(result.current.visibleOrder).toEqual(IDS);
    expect(result.current.hiddenIds).toEqual([]);
  });

  it('hides and re-shows a widget', () => {
    const { result } = renderHook(() => useWorkspaces(IDS));
    act(() => result.current.hide('alerts'));
    expect(result.current.visibleOrder).toEqual(['kpis', 'leases', 'cash']);
    expect(result.current.hiddenIds).toEqual(['alerts']);
    act(() => result.current.show('alerts'));
    expect(result.current.hiddenIds).toEqual([]);
    expect(result.current.visibleOrder).toEqual(IDS);
  });

  it('reorders widgets by moving one over another', () => {
    const { result } = renderHook(() => useWorkspaces(IDS));
    act(() => result.current.reorder('cash', 'kpis'));
    expect(result.current.visibleOrder).toEqual(['cash', 'kpis', 'alerts', 'leases']);
  });

  it('saveAs snapshots the current config into a new workspace and activates it', () => {
    const { result } = renderHook(() => useWorkspaces(IDS));
    act(() => result.current.hide('cash'));
    act(() => result.current.saveAs('Trading'));
    expect(result.current.active).toBe('Trading');
    expect(result.current.workspaceNames).toContain('Trading');
    expect(result.current.hiddenIds).toEqual(['cash']);

    // Editing Trading must not bleed back into the snapshotted Default (independent copies).
    act(() => result.current.show('cash'));
    expect(result.current.hiddenIds).toEqual([]);
    act(() => result.current.setActive('Default'));
    expect(result.current.active).toBe('Default');
    expect(result.current.hiddenIds).toEqual(['cash']);
  });

  it('resetActive restores full order and clears hidden', () => {
    const { result } = renderHook(() => useWorkspaces(IDS));
    act(() => result.current.hide('alerts'));
    act(() => result.current.reorder('cash', 'kpis'));
    act(() => result.current.resetActive());
    expect(result.current.visibleOrder).toEqual(IDS);
    expect(result.current.hiddenIds).toEqual([]);
  });

  it('persists across remounts via localStorage', () => {
    const first = renderHook(() => useWorkspaces(IDS));
    act(() => first.result.current.hide('leases'));
    expect(localStorage.getItem(KEY)).toContain('leases');

    // A fresh hook instance reads the persisted config.
    const second = renderHook(() => useWorkspaces(IDS));
    expect(second.result.current.hiddenIds).toEqual(['leases']);
  });

  it('normalizes a saved config against a changed widget set (adds new, drops removed)', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ workspaces: { Default: { order: ['kpis', 'gone'], hidden: ['gone'] } }, active: 'Default' }),
    );
    const { result } = renderHook(() => useWorkspaces(['kpis', 'alerts']));
    // 'gone' dropped; 'alerts' (new) appended; stale hidden id removed.
    expect(result.current.visibleOrder).toEqual(['kpis', 'alerts']);
    expect(result.current.hiddenIds).toEqual([]);
  });

  it('falls back to Default when localStorage is corrupt', () => {
    localStorage.setItem(KEY, 'not valid json {');
    const { result } = renderHook(() => useWorkspaces(IDS));
    expect(result.current.active).toBe('Default');
    expect(result.current.visibleOrder).toEqual(IDS);
  });
});
