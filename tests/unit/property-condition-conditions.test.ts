// @vitest-environment node
//
// tests/unit/property-condition-conditions.test.ts
//
// Phase 3 alert conditions (server/warehouse/property-condition-conditions.ts) against a fresh tmpdir
// warehouse loaded through the real writeRegister(), plus the runBrief wiring. Pins: year-grain warranty
// windows (stated end years only), the dated-PCA rollup that still honours "current = newest report, no
// age cutoff", severity ceiling (never critical → never emailed), and the fail-open/visible-failure split.
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { PcaAssetFact, PcaReport } from '../../src/contracts/property-condition';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { propertyConditionConditions } from '../../server/warehouse/property-condition-conditions';
import { writeRegister, type ParsedRegister } from '../../scripts/import-pca-register';
import { runBrief } from '../../server/brief/run';

const REF = '2026-10-07'; // ref year 2026

function report(over: Partial<PcaReport>): PcaReport {
  return {
    reportId: 'R01', propertyKey: 'p', propertyMasterId: null, propertyLabel: 'P', location: null, consultant: 'X', client: null,
    oraCommissioned: true, purpose: null, inspectionDate: null, reportDate: '2026-04-07', sf: 10000, buildings: 1, yearBuilt: null,
    immediateUsd: 1000, shortTermUsd: null, reservesUninflUsd: 5000, reservesInflUsd: null, termYears: 12, psfYrStated: null,
    usabilityRaw: 'CURRENT', usabilityClass: 'current', sourceFiles: null, notes: null, ...over,
  };
}

function asset(over: Partial<PcaAssetFact>): PcaAssetFact {
  return {
    propertyKey: 'p', propertyMasterId: null, propertyLabel: 'P', component: 'Roof', installFact: null, installYear: 2010,
    warranty: '20-yr warranty', warrantyEndYear: null, source: null, flag: null, rowSeq: 1, ...over,
  };
}

function parsed(over: Partial<ParsedRegister>): ParsedRegister {
  return { reports: [], components: [], quotes: [], assets: [], pairs: [], openItems: [], rejects: [], ...over };
}

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'pca-cond-')), 'finance.sqlite'));
}

describe('propertyConditionConditions — guards', () => {
  it('returns [] when migration 035 is absent (feature not deployed there)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pca-cond-bare-'));
    const bare = new Database(join(dir, 'bare.sqlite'));
    bare.exec('CREATE TABLE unrelated (a INTEGER)');
    try {
      expect(propertyConditionConditions(bare as unknown as WarehouseDb, REF)).toEqual([]);
    } finally {
      bare.close();
    }
  });

  it('returns [] when the ledger exists but the register has not been imported', () => {
    const db = freshDb();
    try {
      expect(propertyConditionConditions(db, REF)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('pca-warranty-* (year-grain, stated end years only)', () => {
  function run(endYears: Array<number | null>): ReturnType<typeof propertyConditionConditions> {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [report({})],
        assets: endYears.map((y, i) => asset({ component: `Roof ${i}`, warrantyEndYear: y, rowSeq: i + 1 })),
      }));
      return propertyConditionConditions(db, REF);
    } finally {
      db.close();
    }
  }

  it('warns for end years this year and ≤2 years out; stays silent beyond that and for no stated year', () => {
    const out = run([2026, 2028, 2029, null]);
    const titles = out.map((i) => i.title);
    expect(titles).toEqual(['Warranty ending — P · Roof 0', 'Warranty ending — P · Roof 1']);
    expect(out[0]?.detail).toContain('this year');
    expect(out[1]?.detail).toContain('2 yrs out');
    expect(out[1]?.detail).toContain('Year-grain');
  });

  it('flags a warranty that lapsed at most 1 year ago; older lapses are history', () => {
    const out = run([2025, 2024]);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Warranty lapsed — P · Roof 0');
    expect(out[0]?.detail).toContain('lapsed 1 yr ago');
  });

  it('is a warning-severity capex insight on spine B and never critical (so it can never email)', () => {
    const out = run([2026, 2025, 2028]);
    expect(out.length).toBeGreaterThan(0);
    for (const i of out) {
      expect(i.severity).toBe('warning');
      expect(i.category).toBe('capex');
      expect(i.spine).toBe('B');
      expect(i.provenance).toBe('derived');
      expect(i.impactAnnualUsd).toBeNull();
    }
  });

  it('keeps ids unique and stable when two asset facts share a property and component', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [report({})],
        assets: [
          asset({ component: 'Roof', warrantyEndYear: 2027, rowSeq: 1 }),
          asset({ component: 'Roof', warrantyEndYear: 2028, rowSeq: 2 }),
        ],
      }));
      const ids = propertyConditionConditions(db, REF).map((i) => i.id);
      expect(ids).toEqual(['pca-warranty-p-roof', 'pca-warranty-p-roof-2']);
      expect(new Set(ids).size).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('pca-dated-reports (one rollup; current = newest report, no age cutoff)', () => {
  function run(reports: PcaReport[]): ReturnType<typeof propertyConditionConditions> {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports }));
      return propertyConditionConditions(db, REF).filter((i) => i.id === 'pca-dated-reports');
    } finally {
      db.close();
    }
  }

  it('rolls every ≥5-yr-old current report with immediate repairs into ONE info insight, biggest first', () => {
    const out = run([
      report({ reportId: 'A', propertyKey: 'a', propertyLabel: 'Alpha', reportDate: '2016-10', immediateUsd: 252350 }),
      report({ reportId: 'B', propertyKey: 'b', propertyLabel: 'Beta', reportDate: '2015-08-12', immediateUsd: 76150 }),
      report({ reportId: 'C', propertyKey: 'c', propertyLabel: 'Gamma', reportDate: '2026-04-07', immediateUsd: 99999 }), // fresh
    ]);
    expect(out).toHaveLength(1);
    const i = out[0]!;
    expect(i.severity).toBe('info');
    expect(i.category).toBe('capex');
    expect(i.title).toBe('Dated PCA on file — 2 properties');
    expect(i.metric).toBe('2');
    expect(i.detail.indexOf('Alpha')).toBeLessThan(i.detail.indexOf('Beta'));
    expect(i.detail).not.toContain('Gamma');
    expect(i.detail).toContain('still used');
  });

  it('boundary: exactly 5 whole years alerts, 4 does not; zero/absent immediate repairs and undated reports do not', () => {
    const out = run([
      report({ reportId: 'A', propertyKey: 'a', propertyLabel: 'Five', reportDate: '2021-01-01', immediateUsd: 100 }),
      report({ reportId: 'B', propertyKey: 'b', propertyLabel: 'Four', reportDate: '2022-01-01', immediateUsd: 100 }),
      report({ reportId: 'C', propertyKey: 'c', propertyLabel: 'ZeroImm', reportDate: '2010-01-01', immediateUsd: 0 }),
      report({ reportId: 'D', propertyKey: 'd', propertyLabel: 'NullImm', reportDate: '2010-01-01', immediateUsd: null }),
      report({ reportId: 'E', propertyKey: 'e', propertyLabel: 'Undated', reportDate: null, immediateUsd: 500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Dated PCA on file — 1 property');
    expect(out[0]?.detail).toContain('Five');
    for (const name of ['Four', 'ZeroImm', 'NullImm', 'Undated']) expect(out[0]?.detail).not.toContain(name);
  });

  it('uses the NEWEST report per property: an old report superseded by a fresh one does not alert', () => {
    const out = run([
      report({ reportId: 'OLD', propertyKey: 'p', reportDate: '2014-10-23', immediateUsd: 3100 }),
      report({ reportId: 'NEW', propertyKey: 'p', reportDate: '2026-04-07', immediateUsd: 1050 }),
    ]);
    expect(out).toEqual([]);
  });

  it('shortens register labels that carry parentheticals or dash notes', () => {
    const i = run([
      report({ reportId: 'A', propertyKey: 'a', propertyLabel: "6410 Sheriff Rd (folder labelled '6300 Sherriff Road')", reportDate: '2007-07-19', immediateUsd: 11500 }),
      report({ reportId: 'B', propertyKey: 'b', propertyLabel: 'Muirkirk — 6850-6872 Distribution Dr + 12201-12225 Distribution Way', reportDate: '2014-10-23', immediateUsd: 3100 }),
    ])[0]!;
    expect(i.detail).toContain('6410 Sheriff Rd (19 yrs');
    expect(i.detail).toContain('Muirkirk (12 yrs');
    expect(i.detail).not.toContain('folder labelled');
    expect(i.detail).not.toContain('Distribution Way');
  });

  it('lists at most 6 names and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      report({ reportId: `R${i}`, propertyKey: `k${i}`, propertyLabel: `Prop${i}`, reportDate: '2010-01-01', immediateUsd: 1000 + i }),
    );
    const i = run(many)[0]!;
    expect(i.title).toBe('Dated PCA on file — 8 properties');
    expect(i.detail).toContain('+2 more');
  });
});

describe('determinism', () => {
  it('output is sorted by id', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({
        reports: [report({ reportDate: '2010-01-01', immediateUsd: 10 })],
        assets: [asset({ component: 'Zed', warrantyEndYear: 2027 }), asset({ component: 'Alpha', warrantyEndYear: 2027, rowSeq: 2 })],
      }));
      const ids = propertyConditionConditions(db, REF).map((i) => i.id);
      expect(ids).toEqual([...ids].sort());
      expect(ids).toContain('pca-dated-reports');
    } finally {
      db.close();
    }
  });
});

describe('runBrief wiring', () => {
  function baseSnap(): PortfolioSnapshot {
    return {
      meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00Z', source: 't', scenario: 'Base' },
      assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-04' },
      properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
      cash: { asOf: '2026-06-04', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    } as unknown as PortfolioSnapshot;
  }

  async function brief(dbPath: string, stateDir: string): Promise<{ bodies: string[]; alerts: number; warns: string[] }> {
    const prev = process.env['WAREHOUSE_DB'];
    process.env['WAREHOUSE_DB'] = dbPath;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bodies: string[] = [];
    let warns: string[] = [];
    let alerts = 0;
    try {
      const res = await runBrief(baseSnap(), {
        statePath: join(stateDir, 'state.json'),
        now: new Date('2026-07-09T11:00:00Z'), // brief gate open; ref year 2026
        send: async (email) => {
          bodies.push(email.html);
          return { ok: true, via: 'com' };
        },
      });
      alerts = res.alertsSent;
    } finally {
      warns = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      if (prev === undefined) delete process.env['WAREHOUSE_DB'];
      else process.env['WAREHOUSE_DB'] = prev;
    }
    return { bodies, alerts, warns };
  }

  it('a populated warehouse puts the warranty and dated-PCA insights in the brief, with no alert email', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pca-brief-'));
    const dbPath = join(d, 'finance.sqlite');
    const db = openWarehouse(dbPath);
    writeRegister(db, parsed({
      reports: [report({ propertyLabel: 'Muirkirk', reportDate: '2014-10-23', immediateUsd: 3100 })],
      assets: [asset({ propertyLabel: 'Muirkirk', component: 'Roof', warrantyEndYear: 2028, warranty: '20-yr to 2028' })],
    }));
    db.close();
    const { bodies, alerts } = await brief(dbPath, d);
    const html = bodies.join(' | ');
    expect(html).toContain('Warranty ending');
    expect(html).toContain('Dated PCA on file');
    expect(alerts).toBe(0); // warning/info only — nothing reaches the per-critical email path
  });

  it('a warehouse behind migration 035 adds nothing and raises no property-condition warning', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pca-brief-stale-'));
    const dbPath = join(d, 'stale.sqlite');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE unrelated (a INTEGER)');
    seed.close();
    const { bodies, warns } = await brief(dbPath, d);
    expect(warns.some((m) => m.includes('property condition conditions unavailable'))).toBe(false);
    expect(bodies.join(' | ')).not.toContain('Property condition alerts unavailable');
  });

  it('an unreadable ledger is a VISIBLE warning insight, not a silent skip', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pca-brief-broken-'));
    const dbPath = join(d, 'broken.sqlite');
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE pca_reports (report_id TEXT)'); // table present, columns missing
    seed.exec("INSERT INTO pca_reports VALUES ('R1')");
    seed.close();
    const { bodies, warns } = await brief(dbPath, d);
    expect(warns.some((m) => m.includes('property condition conditions unavailable'))).toBe(true);
    expect(bodies.join(' | ')).toContain('Property condition alerts unavailable');
  });
});
