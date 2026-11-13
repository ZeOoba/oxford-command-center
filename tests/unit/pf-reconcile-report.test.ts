// @vitest-environment node
//
// tests/unit/pf-reconcile-report.test.ts — scripts/reconcile-pf.ts: the on-demand report over the three PF
// cross-checks. Warn-only by contract: it describes, it never gates. Runs over the committed synthetic
// snapshot + PF dataset (fixtures/synthetic); nothing here pins a value, only the report's structure.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePropertyFinancialsDataset } from '@contracts/property-financials';
import { PortfolioSnapshot } from '../../src/contracts/index';
import { buildReport } from '../../scripts/reconcile-pf';

const ds = parsePropertyFinancialsDataset(JSON.parse(readFileSync('fixtures/synthetic/data/property-financials/dataset.json', 'utf8')));
const snapshot = PortfolioSnapshot.parse(JSON.parse(readFileSync('fixtures/synthetic/data/snapshots/portfolio.json', 'utf8')));

describe('buildReport', () => {
  const { lines, counts } = buildReport(snapshot, ds);
  const text = lines.join('\n');
  const body = lines.filter((l) => /^(✓|⚠)/.test(l));

  it('has the three sections and a warn-only footer', () => {
    expect(text).toMatch(/SNAPSHOT.*PF.*TIE-OUT/i);
    expect(text).toMatch(/TAX TIMING/i);
    expect(text).toMatch(/INSURANCE.*LEDGER/i);
    expect(text).toMatch(/warn-only/i);
  });

  it('prints a line per row and never an error marker', () => {
    expect(body.length).toBeGreaterThan(10);
    expect(lines.some((l) => /\bERROR\b|✗/.test(l))).toBe(false);
  });

  it('counts agree with the printed lines and never include an error count', () => {
    expect(counts.tieOutWarn).toBe(lines.filter((l) => /^⚠ WARN\s+(noi|sf|ltv)\b/.test(l)).length);
    expect(counts.tieOutNm).toBe(lines.filter((l) => /^(✓|⚠) \S+\s+(noi|sf|ltv)\b.* · n\/m\b/.test(l)).length);
    expect(Object.keys(counts).sort()).toEqual(['insuranceFindings', 'taxFindings', 'tieOutNm', 'tieOutWarn']);
  });

  it('prints every n/m row with its reason (nothing is silently clean)', () => {
    const nm = body.filter((l) => /\bn\/m\b/.test(l));
    expect(nm.length).toBeGreaterThan(0);
    expect(nm.every((l) => / — .{5,}/.test(l))).toBe(true);
  });
});

describe('buildReport: staggered-term excess (refute round 3)', () => {
  // Synthetic rewrite of one location: a Package (Nov term) and a GL (Sep term) both in force, with the
  // Package paid twice inside the trailing 12. Staggered terms: info for review, no dollar figures.
  const ENTITY = '29000 Info Lane';
  const snap = structuredClone(snapshot);
  (snap as unknown as { insurance: unknown[] }).insurance = [
    { ...snapshot.insurance[0], id: 'ins-29000info-pckg', coverage: 'Package (PCKG)', status: 'Current', effective: '2025-11-15', expires: '2026-11-15', premium: 8_000 },
    { ...snapshot.insurance[0], id: 'ins-29000info-gl', coverage: 'General Liability', status: 'Current', effective: '2026-09-01', expires: '2027-09-01', premium: 8_000 },
  ];
  const data = structuredClone(ds);
  const ledger = (data.monthly as unknown as Record<string, Record<string, { opex_by: { Insurance: number } }>>)[ENTITY]!;
  for (const [m, row] of Object.entries(ledger)) row.opex_by.Insurance = ['2025-11', '2026-03', '2026-09'].includes(m) ? 8_000 : 0;
  const { lines } = buildReport(snap, data);
  const row = lines.find((l) => l.includes(ENTITY) && /excess-ledger/.test(l));

  it('prints the staggered row as INFO with its ratio and no dollar figures', () => {
    expect(row).toBeDefined();
    expect(row!).toMatch(/^✓ INFO /);
    expect(row!).toMatch(/needs review, staggered policy terms\): 1\.50x/);
    expect(row!).not.toMatch(/\$/);
  });
});
