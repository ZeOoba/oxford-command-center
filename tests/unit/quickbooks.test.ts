// @vitest-environment node
// Node environment (not the jsdom default): resolveQuickbooks reads the previous snapshot off disk,
// so this file imports node:fs. The pre-existing pure-function suites below are env-agnostic.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { QbActuals, NoiBudgetInput } from '../../src/contracts/quickbooks';
import { parseQuickbooksCsv, resolveQuickbooks } from '../../server/sources/quickbooks';
import type { Property } from '../../src/contracts/index';

describe('QuickBooks contract', () => {
  it('defaults a QbActuals with empty properties', () => {
    const a = QbActuals.parse({ parsedAt: '2026-06-05T00:00:00.000Z' });
    expect(a.properties).toEqual([]);
    expect(a.sourceFile).toBeNull();
  });
  it('validates the budget action input', () => {
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: 250000 }).success).toBe(true);
    expect(NoiBudgetInput.safeParse({ propertyId: '', amount: 1 }).success).toBe(false);
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: -5 }).success).toBe(false);
  });
});

// address is now load-bearing: parseQuickbooksCsv resolves propertyId via server/workbook/parse.ts's
// resolvePropertyId (word-token + street-number + alias matching against Property.address), not the
// old bidirectional-substring check against Property.name.
const props = [
  { id: 'rarig', name: '1100 Rarig Ave', address: '1100 Rarig Ave, Columbus OH' },
  { id: 'northwood', name: '2207 Northwood', address: '2203-2207 Northwood Dr, Salisbury MD' },
] as unknown as Property[];

const CSV = `Property,Month,Account,Type,Amount
1100 Rarig,2026-01,Rental Income,Income,"$42,000"
1100 Rarig,2026-01,Repairs & Maintenance,Expense,3100
1100 Rarig,2026-02,Rental Income,Income,42000
1100 Rarig,2026-02,Insurance,Expense,900
2207 Northwood,2026-01,Rental Income,Income,38000
Unknown Strip Mall,2026-01,Rental Income,Income,5000`;

const NOW = '2026-06-05T00:00:00.000Z';

describe('parseQuickbooksCsv', () => {
  const qb = parseQuickbooksCsv(CSV, props, NOW)!;

  it('groups by property and sums annual income/expense/NOI', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.annualIncome).toBe(84000); // 42k + 42k
    expect(rarig.annualExpense).toBe(4000); // 3100 + 900
    expect(rarig.annualNoi).toBe(80000);
    expect(rarig.monthly).toHaveLength(2);
  });

  it('resolves propertyId via resolvePropertyId (word-token + number match); leaves unmatched null', () => {
    expect(qb.properties.find((p) => p.propertyKey === '1100 Rarig')!.propertyId).toBe('rarig');
    expect(qb.properties.find((p) => p.propertyKey === 'Unknown Strip Mall')!.propertyId).toBeNull();
  });

  it('resolves a Sepich-alias QB key via RENT_ROLL_PROPERTY_ALIASES, not left null (2026-08-24 fix)', () => {
    // Regression for Finding 3 of the 2026-08-24 integrity sweep: the old inline resolveId() never
    // consulted the alias table, so QB rows keyed by a Sepich-portfolio sub-address (this fixture
    // stands in for the real 'FVC' / '4595 E. 5th Ave' keys) came back propertyId:null and were
    // silently dropped from every per-property NOI-variance row.
    const sepichProps = [
      { id: 'sepich-portfolio-columbus-oh-8-props', name: 'Sepich Portfolio', address: '1234 Placeholder Way, Columbus OH' },
    ] as unknown as Property[];
    const csv = `Property,Month,Account,Type,Amount\n4595 E. 5th Ave,2026-01,Rental Income,Income,10000`;
    const qbSepich = parseQuickbooksCsv(csv, sepichProps, NOW)!;
    expect(qbSepich.properties[0]!.propertyId).toBe('sepich-portfolio-columbus-oh-8-props');
  });

  it('itemizes GL expense per property (no hardcoded categories)', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.glExpense.map((g) => g.account).sort()).toEqual(['Insurance', 'Repairs & Maintenance']);
  });

  it('parses tolerant amounts ($ and commas) and stamps parsedAt', () => {
    expect(qb.parsedAt).toBe(NOW);
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.monthly.find((m) => m.month === '2026-01')!.income).toBe(42000);
  });

  it('infers type from the account when no Type column is present', () => {
    const noType = `Property,Month,Account,Amount\n1100 Rarig,2026-01,Rental Income,1000\n1100 Rarig,2026-01,Landscaping,200`;
    const r = parseQuickbooksCsv(noType, props, NOW)!.properties[0]!;
    expect(r.annualIncome).toBe(1000); // "Rental Income" → income
    expect(r.annualExpense).toBe(200); // "Landscaping" → expense
  });

  it('returns null for empty/headerless content', () => {
    expect(parseQuickbooksCsv('', props, NOW)).toBeNull();
    expect(parseQuickbooksCsv('not,a,recognized,header', props, NOW)).toBeNull();
  });
});

// resolveQuickbooks() closes the 2026-08-17 two-producer data-loss gap. `quickbooks` is a
// SERVER-ATTACHED section: loadQuickbooks() was called only from server/brain.ts, while the two
// CLI writers (scripts/extract-workbook.ts and scripts/lease-snapshot-drift-check.ts) wrote
// applyOverlay(snapshot, overlay) with no attach at all. Because src/contracts/index.ts declares
// `quickbooks: QbActuals.nullable().default(null)`, both writers legitimately emitted `null` and
// every committed CLI refresh DELETED whatever the server path had written -- on 2026-08-17 that
// was 8 per-property P&L rows (828 deleted lines), and the spec'd section-shrink guard could not
// see it because it only counts leases/deals/counterparties/properties/loans.
//
// The floor this locks in: a CLI writer must never turn a populated quickbooks block into null.
// Fresh parse wins when QUICKBOOKS_CSV is readable; otherwise the previous block is carried
// forward (it self-documents its own staleness via parsedAt) rather than destroyed.
describe('resolveQuickbooks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-qb-test-'));
  const saved = process.env.QUICKBOOKS_CSV;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.QUICKBOOKS_CSV;
    else process.env.QUICKBOOKS_CSV = saved;
  });

  /** A previous snapshot on disk carrying a populated, schema-valid quickbooks block. */
  function writePrevSnapshot(name: string, quickbooks: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ leases: [], quickbooks }));
    return path;
  }

  const POPULATED = {
    sourceFile: 'C:\\ora\\ora-pl-by-property.csv',
    parsedAt: '2026-08-16T18:51:31.040Z',
    properties: [{ propertyKey: '1100 Rarig', propertyId: 'rarig', annualIncome: 84000, annualExpense: 4000, annualNoi: 80000, monthly: [], glExpense: [] }],
  };

  it('preserves a populated previous block instead of nulling it when QUICKBOOKS_CSV is unset', () => {
    delete process.env.QUICKBOOKS_CSV;
    const path = writePrevSnapshot('prev-populated.json', POPULATED);

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.quickbooks).not.toBeNull();
    expect(result.quickbooks!.properties).toHaveLength(1);
    expect(result.quickbooks!.parsedAt).toBe('2026-08-16T18:51:31.040Z'); // carried, not restamped
    expect(result.preservedFrom).not.toBeNull();
  });

  it('preserves a populated previous block when QUICKBOOKS_CSV points at a missing file', () => {
    process.env.QUICKBOOKS_CSV = join(dir, 'no-such-export.csv');
    const path = writePrevSnapshot('prev-populated-2.json', POPULATED);

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.quickbooks!.properties).toHaveLength(1);
    expect(result.preservedFrom).not.toBeNull();
  });

  it('prefers a fresh CSV parse over the previous block', () => {
    const csv = join(dir, 'fresh.csv');
    writeFileSync(csv, CSV);
    process.env.QUICKBOOKS_CSV = csv;
    const path = writePrevSnapshot('prev-stale.json', POPULATED);

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.preservedFrom).toBeNull(); // fresh, not carried
    expect(result.quickbooks!.parsedAt).toBe(NOW);
    expect(result.quickbooks!.properties.length).toBeGreaterThan(1); // CSV has 3 property keys
  });

  it('returns null on a genuine first run (no CSV, no previous snapshot) without throwing', () => {
    delete process.env.QUICKBOOKS_CSV;

    const result = resolveQuickbooks(props, join(dir, 'does-not-exist.json'), NOW);

    expect(result.quickbooks).toBeNull();
    expect(result.preservedFrom).toBeNull();
  });

  it('returns null when the previous block is itself null (nothing to lose)', () => {
    delete process.env.QUICKBOOKS_CSV;
    const path = writePrevSnapshot('prev-null.json', null);

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.quickbooks).toBeNull();
    expect(result.preservedFrom).toBeNull();
  });

  it('does not carry forward an empty-properties husk', () => {
    delete process.env.QUICKBOOKS_CSV;
    const path = writePrevSnapshot('prev-husk.json', { sourceFile: null, parsedAt: NOW, properties: [] });

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.quickbooks).toBeNull();
    expect(result.preservedFrom).toBeNull();
  });

  it('returns null rather than throwing when the previous snapshot is corrupt', () => {
    delete process.env.QUICKBOOKS_CSV;
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{ not valid json');

    const result = resolveQuickbooks(props, path, NOW);

    expect(result.quickbooks).toBeNull();
    expect(result.preservedFrom).toBeNull();
  });
});
