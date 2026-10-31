// tests/unit/overview-layout-migration.test.ts
//
// OVERVIEW_LAYOUT_MIGRATION must list EVERY default layout that ever shipped, in its normalized form
// (useWorkspaces compares a saved layout AFTER normalize() reconciles it against the current widget
// set). #514 missed the June 3 – July 6 default, so a workspace still on that untouched default kept
// the old order (KPIs, NOI by Market, Top Tenants first) and never got Priority Actions up top.
import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkspaces } from '../../src/brain/useWorkspaces';
import { ALL_WIDGET_IDS, DEFAULT_HIDDEN_WIDGET_IDS, OVERVIEW_LAYOUT_MIGRATION } from '../../src/modules/overview/widgets';

const KEY = 'ora-overview-workspaces';
/** The default layout as shipped June 3 – July 6 (before results-banner / priority-actions existed). */
const JUNE_DEFAULT = { order: ['kpis', 'noi-market', 'top-tenants', 'cash-trend', 'lease-rollover', 'insights'], hidden: [] as string[] };

function stored(cfg: { order: string[]; hidden: string[] }, version?: number) {
  localStorage.setItem(KEY, JSON.stringify({ workspaces: { Default: cfg }, active: 'Default', ...(version === undefined ? {} : { version }) }));
}

function load() {
  return renderHook(() => useWorkspaces(ALL_WIDGET_IDS, DEFAULT_HIDDEN_WIDGET_IDS, OVERVIEW_LAYOUT_MIGRATION)).result.current;
}

beforeEach(() => localStorage.clear());

describe('OVERVIEW_LAYOUT_MIGRATION — June 3 – July 6 default', () => {
  it('moves an untouched June default (never migrated) onto the current default', () => {
    stored(JUNE_DEFAULT);
    const ws = load();
    expect(ws.visibleOrder).toEqual(ALL_WIDGET_IDS.filter((id) => !DEFAULT_HIDDEN_WIDGET_IDS.includes(id)));
    expect(ws.hiddenIds).toEqual(DEFAULT_HIDDEN_WIDGET_IDS);
  });

  it('also reaches a June default already stamped by the #514 migration (version 2)', () => {
    stored(JUNE_DEFAULT, 2);
    expect(load().visibleOrder[1]).toBe('priority-actions');
  });

  it('keeps a June-era layout the user changed (something hidden)', () => {
    stored({ order: JUNE_DEFAULT.order, hidden: ['top-tenants'] });
    expect(load().visibleOrder.slice(0, 3)).toEqual(['kpis', 'noi-market', 'cash-trend']);
  });

  // Adversarial review 2026-10-30 (C5): version 3 re-checked EVERY legacy default for any state
  // below 3, so a v2 user who deliberately put the layout back to the pre-#514 order after #514
  // migrated them was overwritten again. Each step applies only to states older than it.
  const LEGACY_ORDER = ['kpis', 'results-banner', 'noi-market', 'top-tenants', 'priority-actions', 'cash-trend', 'lease-rollover', 'insights'];

  it('leaves a v2 workspace the user set back to the legacy order (insights hidden) unchanged', () => {
    stored({ order: LEGACY_ORDER, hidden: ['insights'] }, 2);
    const ws = load();
    expect(ws.visibleOrder).toEqual(LEGACY_ORDER.filter((id) => id !== 'insights'));
    expect(ws.hiddenIds).toEqual(['insights']);
  });

  it('leaves a v2 workspace on the legacy order with nothing hidden unchanged', () => {
    stored({ order: LEGACY_ORDER, hidden: [] }, 2);
    expect(load().visibleOrder).toEqual(LEGACY_ORDER);
  });

  it('still migrates a v1 (and unversioned) workspace on the legacy order', () => {
    const current = ALL_WIDGET_IDS.filter((id) => !DEFAULT_HIDDEN_WIDGET_IDS.includes(id));
    stored({ order: LEGACY_ORDER, hidden: ['insights'] }, 1);
    expect(load().visibleOrder).toEqual(current);
    localStorage.clear();
    stored({ order: LEGACY_ORDER, hidden: [] });
    expect(load().visibleOrder).toEqual(current);
  });
});
