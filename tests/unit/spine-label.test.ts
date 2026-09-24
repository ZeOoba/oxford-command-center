import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { noiBasisLabel, spineLabel } from '../../src/lib/spine-label';
import { totalsBySpine } from '../../src/modules/insights/insights.logic';

// Source with block comments and `// …` line comments removed, so only code + string/JSX text remain.
// A `//` counts as a comment only at line start or after whitespace (keeps `https://…` inside strings).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// "Spine A" / "Spine-A" / "SpineB" (capital S — the prose form) and the hyphenated lowercase
// "spine-a" / "spine-b" form. Case-sensitive on the first alternative on purpose: a case-insensitive
// match would flag camelCase identifiers such as `spineA` (insights.logic.ts), which never render.
const SPINE_COPY = /\bSpine[- ]?[AB]\b|\b[Ss]pine-[ab]\b/;

describe('spine labels', () => {
  it('maps internal spines to plain basis names', () => {
    expect([spineLabel('A'), spineLabel('B'), spineLabel('cross')]).toEqual(['Workbook', 'Ledger', 'Combined']);
    expect(totalsBySpine([]).map((t) => t.label)).toEqual(['Workbook basis', 'Ledger & combined basis']);
  });
  it('maps a server noiBasis value for display without touching the wire value', () => {
    expect(noiBasisLabel('spine-b/warehouse-ledger')).toBe('Ledger (warehouse)');
    expect(noiBasisLabel('spine-a')).toBe('Workbook');
    expect(noiBasisLabel('spine-a/workbook')).toBe('Workbook');
    expect(noiBasisLabel('fy2025-actual')).toBe('fy2025-actual');
  });
  it.each([
    'src/modules/alerts/AlertsModule.tsx', 'src/modules/overview/widgets.tsx', 'src/modules/leasing/LeaseForecastModule.tsx',
    'src/modules/insights/InsightsModule.tsx', 'src/modules/debt/ScorecardView.tsx', 'src/modules/taxes/TaxesModule.tsx',
    'src/modules/taxes/StrategyBoard.tsx', 'src/modules/capital/CapitalModule.tsx', 'src/brain/AiPanel.tsx',
    'src/analytics/lease-forecast.ts',
    // Server-rendered copy that reaches the UI: tax basisNote/missing-parts text (StrategyBoard) and
    // the IC memo HTML. debt-scoring.ts is deliberately NOT scanned — its 'spine-b/warehouse-ledger'
    // is a wire value that noiBasisLabel() maps at render time.
    'server/warehouse/tax-analysis.ts', 'server/warehouse/ic-memo.ts',
  ])('%s renders no "Spine A/B" copy (comments excluded)', (f) => {
    expect(stripComments(readFileSync(f, 'utf8'))).not.toMatch(SPINE_COPY);
  });
  it('the Ask panel does not describe itself as querying "the live spine"', () => {
    expect(stripComments(readFileSync('src/brain/AiPanel.tsx', 'utf8'))).not.toMatch(/live spine/i);
  });
  it('the debt scorecard maps noiBasis through noiBasisLabel rather than rendering the raw wire value', () => {
    expect(readFileSync('src/modules/debt/ScorecardView.tsx', 'utf8')).toContain('noiBasisLabel(row.noiBasis)');
  });
  it('insights tier chips use the plain basis names (its comments still say Spine, so match the old literals)', () => {
    const src = readFileSync('src/modules/insights/insights.logic.ts', 'utf8');
    for (const old of ["'Spine A'", "'Spine B'", "'Cross-spine'"]) expect(src).not.toContain(old);
    expect(src).toContain('chips: [spineLabel(m.spine)]');
  });
  it('the scan itself catches the hyphenated and lowercase forms the old regex missed', () => {
    expect(stripComments('<p>Spine-A insights are unavailable.</p>')).toMatch(SPINE_COPY);
    expect(stripComments("noiBasis: 'spine-b/warehouse-ledger'")).toMatch(SPINE_COPY);
    expect(stripComments('// Spine A is internal vocabulary\nconst x = 1;')).not.toMatch(SPINE_COPY);
    expect(stripComments('/* Spine-B ledger */ const y = 2;')).not.toMatch(SPINE_COPY);
    expect(stripComments("const url = 'https://x.test/Spine-A'; // Spine B")).toMatch(SPINE_COPY);
  });
});
