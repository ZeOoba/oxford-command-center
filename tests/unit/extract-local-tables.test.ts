// @vitest-environment node
//
// scripts/extract-local-tables.ts rebuilds config/local/ar-seed-mappings.json from the inline
// CONFIRMED table of a pre-untrack seed-ar-mappings.ts. A partial table must never be written.
import { describe, expect, it } from 'vitest';
import { parseConfirmedTable } from '../../scripts/extract-local-tables';

const SOURCE = `/** [PM export name, Lease.id, why it is safe] */
const CONFIRMED: ReadonlyArray<readonly [string, string, string]> = [
  // a comment line with [brackets] is ignored
  ['Kelvar Service', 'p1-a1-kelvar-service', 'confirmed by hand; unit A1'],
  [
    "Dibita LLC",
    'p2-b4-dibita-llc',
    'it\\'s the only lease on B4',
  ],
];

async function main(): Promise<void> {}
`;

describe('parseConfirmedTable', () => {
  it('reads every [name, leaseId, why] row, single- or double-quoted, across lines', () => {
    expect(parseConfirmedTable(SOURCE)).toEqual({
      confirmed: [
        { name: 'Kelvar Service', leaseId: 'p1-a1-kelvar-service', why: 'confirmed by hand; unit A1' },
        { name: 'Dibita LLC', leaseId: 'p2-b4-dibita-llc', why: "it's the only lease on B4" },
      ],
    });
  });

  it('refuses a row it cannot parse instead of writing a partial table', () => {
    const bad = SOURCE.replace("'confirmed by hand; unit A1'", 'WHY_CONST');
    expect(() => parseConfirmedTable(bad)).toThrow(/parsed 1 of 2 CONFIRMED row\(s\)/);
  });

  it('refuses a source with no CONFIRMED table', () => {
    expect(() => parseConfirmedTable('const OTHER = [];\n')).toThrow(/no `const CONFIRMED` table/);
  });
});
