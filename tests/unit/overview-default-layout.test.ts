import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_ORDER, OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';
import { OVERVIEW_MAX_ITEMS } from '../../src/lib/ranked-cap';

describe('Overview default layout (one home per attention list)', () => {
  it('shows Priority Actions by default; the full Insights tier board lives in Brain › Insights', () => {
    expect(DEFAULT_WIDGET_ORDER).toContain('priority-actions');
    expect(DEFAULT_WIDGET_ORDER).not.toContain('insights');
    expect(OVERVIEW_WIDGETS.some((w) => w.id === 'insights')).toBe(true); // still addable via Edit layout
  });

  it('puts Priority Actions right after the KPI strip, full width, ahead of the descriptive widgets', () => {
    expect(DEFAULT_WIDGET_ORDER.slice(0, 2)).toEqual(['kpis', 'priority-actions']);
    expect(OVERVIEW_WIDGETS.find((w) => w.id === 'priority-actions')?.span).toBe('full');
  });

  it('keeps NOI by Market and Top Tenants addable but off by default (descriptive, never change a decision)', () => {
    expect(DEFAULT_WIDGET_ORDER).not.toContain('noi-market');
    expect(DEFAULT_WIDGET_ORDER).not.toContain('top-tenants');
    expect(OVERVIEW_WIDGETS.some((w) => w.id === 'noi-market')).toBe(true);
    expect(OVERVIEW_WIDGETS.some((w) => w.id === 'top-tenants')).toBe(true);
  });

  it('keeps every other widget on by default (nothing alert-shaped is hidden)', () => {
    expect(DEFAULT_WIDGET_ORDER).toEqual(
      expect.arrayContaining(['priority-actions', 'kpis', 'results-banner', 'cash-trend', 'lease-rollover']),
    );
  });
});

describe('Overview ceiling', () => {
  it('is 7 rows (Gabriel 2026-10-29), below the MAX_ITEMS=10 every other surface keeps', () => {
    expect(OVERVIEW_MAX_ITEMS).toBe(7);
  });

  it('Priority Actions takes its limit from the shared constant, not a local literal', () => {
    const src = readFileSync('src/modules/overview/widgets.tsx', 'utf8');
    expect(src).toMatch(/OVERVIEW_MAX_ITEMS/);
    expect(src).not.toMatch(/PRIORITY_ACTIONS_LIMIT\s*=\s*\d/);
  });
});
