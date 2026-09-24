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
    'src/analytics/lease-forecast.ts',
  ])('%s renders no "Spine A/B" copy', (f) => {
    expect(readFileSync(f, 'utf8')).not.toMatch(/['"`>][^'"`<]*Spine [AB]\b/);
  });
  it('insights tier chips use the plain basis names (its comments still say Spine, so match the old literals)', () => {
    const src = readFileSync('src/modules/insights/insights.logic.ts', 'utf8');
    for (const old of ["'Spine A'", "'Spine B'", "'Cross-spine'"]) expect(src).not.toContain(old);
    expect(src).toContain('chips: [spineLabel(m.spine)]');
  });
});
