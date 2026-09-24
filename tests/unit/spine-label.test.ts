import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spineLabel } from '../../src/lib/spine-label';
import { totalsBySpine } from '../../src/modules/insights/insights.logic';

describe('spine labels', () => {
  it('maps internal spines to plain basis names', () => {
    expect([spineLabel('A'), spineLabel('B'), spineLabel('cross')]).toEqual(['Workbook', 'Ledger', 'Combined']);
    expect(totalsBySpine([]).map((t) => t.label)).toEqual(['Workbook basis', 'Ledger & combined basis']);
  });
  it.each([
    'src/modules/alerts/AlertsModule.tsx', 'src/modules/overview/widgets.tsx', 'src/modules/leasing/LeaseForecastModule.tsx',
    'src/modules/insights/InsightsModule.tsx', 'src/modules/debt/ScorecardView.tsx', 'src/modules/taxes/TaxesModule.tsx',
  ])('%s renders no "Spine A/B" copy', (f) => {
    expect(readFileSync(f, 'utf8')).not.toMatch(/['"`>][^'"`<]*Spine [AB]\b/);
  });
});
