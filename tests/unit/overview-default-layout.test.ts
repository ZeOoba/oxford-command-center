import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_ORDER, OVERVIEW_WIDGETS } from '../../src/modules/overview/widgets';

describe('Overview default layout (one home per attention list)', () => {
  it('shows Priority Actions by default; the full Insights tier board lives in Brain › Insights', () => {
    expect(DEFAULT_WIDGET_ORDER).toContain('priority-actions');
    expect(DEFAULT_WIDGET_ORDER).not.toContain('insights');
    expect(OVERVIEW_WIDGETS.some((w) => w.id === 'insights')).toBe(true); // still addable via Edit layout
  });
});
