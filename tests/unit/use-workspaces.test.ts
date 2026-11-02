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

// A new default layout must reach people still on the OLD untouched default, without wiping a layout
// they arranged themselves. Only a workspace that equals the legacy default is migrated.
describe('useWorkspaces layout migration', () => {
  const NEW_IDS = ['actions', 'kpis', 'cash', 'noi', 'insights'];
  const NEW_HIDDEN = ['noi', 'insights'];
  const LEGACY = { order: ['kpis', 'noi', 'actions', 'cash', 'insights'], hidden: ['insights'] };
  const LEGACY_NO_HIDE = { order: LEGACY.order, hidden: [] as string[] }; // saved before 'insights' became default-hidden
  const MIGRATION = { steps: [{ toVersion: 2, defaults: [LEGACY, LEGACY_NO_HIDE] }] };
  const seed = (workspaces: Record<string, { order: string[]; hidden: string[] }>, extra: object = {}) =>
    localStorage.setItem(KEY, JSON.stringify({ workspaces, active: 'Default', ...extra }));

  it('moves an untouched legacy default to the new default', () => {
    seed({ Default: LEGACY });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(result.current.visibleOrder).toEqual(['actions', 'kpis', 'cash']);
    expect(result.current.hiddenIds).toEqual(['noi', 'insights']);
  });

  it('also migrates a default saved under an earlier shipped default (nothing hidden)', () => {
    seed({ Default: LEGACY_NO_HIDE }, { version: 1 });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(result.current.visibleOrder).toEqual(['actions', 'kpis', 'cash']);
  });

  it('keeps the old order when the user hid something themselves', () => {
    seed({ Default: { order: LEGACY.order, hidden: ['cash', 'insights'] } });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(result.current.visibleOrder).toEqual(['kpis', 'noi', 'actions']);
  });

  it('leaves a layout the user arranged alone', () => {
    seed({ Default: { order: ['cash', 'kpis', 'noi', 'actions', 'insights'], hidden: ['insights'] } });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(result.current.visibleOrder).toEqual(['cash', 'kpis', 'noi', 'actions']);
  });

  it('migrates only the workspaces that match, keeping a customised named view', () => {
    const custom = { order: ['cash', 'kpis', 'noi', 'actions', 'insights'], hidden: ['insights'] };
    seed({ Default: LEGACY, Mine: custom });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(result.current.visibleOrder).toEqual(['actions', 'kpis', 'cash']);
    act(() => result.current.setActive('Mine'));
    expect(result.current.visibleOrder).toEqual(['cash', 'kpis', 'noi', 'actions']);
  });

  it('runs once: a later customisation that resembles the legacy default is not reset', () => {
    seed({ Default: LEGACY });
    const first = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    act(() => first.result.current.reorder('cash', 'actions'));
    first.unmount();
    const second = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN, MIGRATION));
    expect(second.result.current.visibleOrder).toEqual(['cash', 'actions', 'kpis']);
  });

  it('does nothing without a migration argument (existing callers unchanged)', () => {
    seed({ Default: LEGACY });
    const { result } = renderHook(() => useWorkspaces(NEW_IDS, NEW_HIDDEN));
    expect(result.current.visibleOrder).toEqual(['kpis', 'noi', 'actions', 'cash']);
  });
});

describe('useWorkspaces defaultHidden (default-off-but-addable widgets)', () => {
  it('(a) fresh load: a defaultHidden id is in order but hidden, so it is addable via Edit layout', () => {
    const { result } = renderHook(() => useWorkspaces(IDS, ['alerts']));
    expect(result.current.hiddenIds).toEqual(['alerts']);
    expect(result.current.visibleOrder).toEqual(['kpis', 'leases', 'cash']);
    // still present in the underlying order — not stripped — so it can be un-hidden.
    act(() => result.current.show('alerts'));
    expect(result.current.visibleOrder).toEqual(IDS);
  });

  it('(b) a persisted layout that already has the defaultHidden id visible keeps it visible', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ workspaces: { Default: { order: IDS, hidden: [] } }, active: 'Default' }),
    );
    const { result } = renderHook(() => useWorkspaces(IDS, ['alerts']));
    expect(result.current.hiddenIds).toEqual([]);
    expect(result.current.visibleOrder).toEqual(IDS);
  });

  it('(c) a persisted layout from before the defaultHidden id existed gets it appended as hidden, not dropped', () => {
    const oldIds = ['kpis', 'leases', 'cash']; // predates 'alerts'
    localStorage.setItem(
      KEY,
      JSON.stringify({ workspaces: { Default: { order: oldIds, hidden: [] } }, active: 'Default' }),
    );
    const { result } = renderHook(() => useWorkspaces(IDS, ['alerts']));
    expect(result.current.hiddenIds).toEqual(['alerts']);
    expect(result.current.visibleOrder).toEqual(oldIds);
  });

  it('(d) a defaultHidden id appended as hidden can be unhidden and stays visible thereafter', () => {
    const oldIds = ['kpis', 'leases', 'cash'];
    localStorage.setItem(
      KEY,
      JSON.stringify({ workspaces: { Default: { order: oldIds, hidden: [] } }, active: 'Default' }),
    );
    const { result } = renderHook(() => useWorkspaces(IDS, ['alerts']));
    expect(result.current.hiddenIds).toEqual(['alerts']);
    act(() => result.current.show('alerts'));
    expect(result.current.hiddenIds).toEqual([]);
    expect(result.current.visibleOrder).toContain('alerts');
  });

  it('(e) resetActive() restores defaultHidden — not empty — when a defaultHidden list was passed', () => {
    const { result } = renderHook(() => useWorkspaces(IDS, ['alerts']));
    // Un-hide the default-hidden widget and hide/reorder something else, so the pre-reset state
    // disagrees with defaultHidden in every direction resetActive must undo.
    act(() => result.current.show('alerts'));
    act(() => result.current.hide('kpis'));
    act(() => result.current.reorder('cash', 'leases'));
    act(() => result.current.resetActive());
    expect(result.current.visibleOrder).toEqual(['kpis', 'leases', 'cash']);
    expect(result.current.hiddenIds).toEqual(['alerts']);
  });
});
