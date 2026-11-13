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
import { propertyConditionConditions, statedEndMonth } from '../../server/warehouse/property-condition-conditions';
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
      expect(ids).toEqual(['pca-warranty-p-r1', 'pca-warranty-p-r2']);
      expect(new Set(ids).size).toBe(2);
    } finally {
      db.close();
    }
  });

  function idsFor(assets: PcaAssetFact[], ref = REF): Array<[string, string]> {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports: [report({})], assets }));
      return propertyConditionConditions(db, ref)
        .filter((i) => i.id.startsWith('pca-warranty-'))
        .map((i) => [i.id, `${i.title}|${i.metric}`] as [string, string]);
    } finally {
      db.close();
    }
  }

  it('a component slug ending in "-<n>" cannot collide with a repeated component (suffix space is row identity)', () => {
    const out = idsFor([
      asset({ propertyKey: 'k', component: 'Roof', warrantyEndYear: 2027, rowSeq: 1 }),
      asset({ propertyKey: 'k', component: 'Roof', warrantyEndYear: 2028, rowSeq: 2 }),
      asset({ propertyKey: 'k', component: 'Roof 2', warrantyEndYear: 2027, rowSeq: 3 }),
    ]);
    const ids = out.map(([id]) => id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('(key, component) pairs that join to the same text still get distinct ids, independent of insertion order', () => {
    const A = asset({ propertyKey: 'plant-a', propertyLabel: 'Same', component: 'Roof', warrantyEndYear: 2027, rowSeq: 1 });
    const B = asset({ propertyKey: 'plant', propertyLabel: 'Same', component: 'a-roof', warrantyEndYear: 2028, rowSeq: 1 });
    const ab = idsFor([A, B]);
    const ba = idsFor([B, A]);
    expect(new Set(ab.map(([id]) => id)).size).toBe(2);
    expect(ab).toEqual(ba); // same id → same fact whatever SQLite's row order
  });

  it('an id stays on its fact when a sibling fact leaves the window as the year rolls', () => {
    const facts = [
      asset({ propertyKey: 'k', component: 'Roof', warrantyEndYear: 2025, rowSeq: 1 }),
      asset({ propertyKey: 'k', component: 'Roof', warrantyEndYear: 2027, rowSeq: 2 }),
    ];
    const y2026 = new Map(idsFor(facts, '2026-10-07'));
    const y2027 = new Map(idsFor(facts, '2027-10-07'));
    expect(y2027.has('pca-warranty-k-r1')).toBe(false); // the 2025 lapse is now history
    expect(y2026.get('pca-warranty-k-r2')?.endsWith('|2027')).toBe(true);
    expect(y2027.get('pca-warranty-k-r2')?.endsWith('|2027')).toBe(true); // the 2027 fact kept its id
  });
});

describe('pca-warranty-* month-grain refinement inside the reference year (raw warranty text)', () => {
  // REF = 2026-10-07 → reference month October 2026. Synthetic warranty strings only.
  function one(warranty: string | null, endYear = 2026, ref = REF): ReturnType<typeof propertyConditionConditions> {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports: [report({})], assets: [asset({ warranty, warrantyEndYear: endYear, rowSeq: 1 })] }));
      return propertyConditionConditions(db, ref);
    } finally {
      db.close();
    }
  }

  it('a stated month BEFORE the reference month in the reference year is lapsed, not "ending this year"', () => {
    const out = one('Synthetic 20-yr to 03-2026');
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('pca-warranty-p-r1'); // id unchanged
    expect(out[0]?.title).toBe('Warranty lapsed — P · Roof');
    expect(out[0]?.detail).toContain('stated end March 2026');
    expect(out[0]?.detail).toContain('lapsed earlier this year');
    expect(out[0]?.detail).toContain('now out of warranty');
    expect(out[0]?.detail).not.toContain('(this year)');
    expect(out[0]?.detail).not.toContain('file any claim');
    expect(out[0]?.metric).toBe('2026');
  });

  it('a stated month AFTER the reference month in the reference year stays "ending this year"', () => {
    const out = one('Synthetic 20-yr to 12-2026');
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('pca-warranty-p-r1');
    expect(out[0]?.title).toBe('Warranty ending — P · Roof');
    expect(out[0]?.detail).toContain('stated end December 2026 (this year)');
    expect(out[0]?.detail).toContain('file any claim before it ends');
  });

  it('the reference month itself is still in force ("this year")', () => {
    expect(one('Synthetic to 10/2026')[0]?.title).toBe('Warranty ending — P · Roof');
  });

  it('no stated month keeps the year-grain "this year" behaviour', () => {
    const out = one('Synthetic 20-yr, warranty to 2026');
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('pca-warranty-p-r1');
    expect(out[0]?.title).toBe('Warranty ending — P · Roof');
    expect(out[0]?.detail).toContain('stated end year 2026 (this year)');
    expect(out[0]?.detail).toContain('file any claim before it ends');
    expect(out[0]?.detail).toContain('Year-grain');
  });

  it('unparseable or ambiguous month text keeps the year-grain "this year" behaviour', () => {
    for (const w of ['Synthetic to 13/2026 per binder', 'Synthetic to Marathon 2026', 'Synthetic to 03/2026 or 11/2026', null]) {
      const out = one(w);
      expect(out, String(w)).toHaveLength(1);
      expect(out[0]?.title, String(w)).toBe('Warranty ending — P · Roof');
      expect(out[0]?.detail, String(w)).toContain('stated end year 2026 (this year)');
      expect(out[0]?.detail, String(w)).toContain('Year-grain');
    }
  });

  it('only applies inside the reference year: a past month in a FUTURE end year is still "1 yr out"', () => {
    const out = one('Synthetic to 03-2027', 2027);
    expect(out[0]?.title).toBe('Warranty ending — P · Roof');
    expect(out[0]?.detail).toContain('1 yr out');
  });
});

describe('statedEndMonth (raw warranty text → end month in the stated end year)', () => {
  it('reads the register and common month formats', () => {
    expect(statedEndMonth('JM 20-yr to 03-2026', 2026)).toBe(3);
    expect(statedEndMonth('Exp. 03/2026', 2026)).toBe(3);
    expect(statedEndMonth('Exp. 3/2026', 2026)).toBe(3);
    expect(statedEndMonth('to March 2026', 2026)).toBe(3);
    expect(statedEndMonth('to Mar. 2026', 2026)).toBe(3);
    expect(statedEndMonth('to Sept 2026', 2026)).toBe(9);
    expect(statedEndMonth('to 2026-03', 2026)).toBe(3);
    expect(statedEndMonth('to 2026-03-31', 2026)).toBe(3);
  });

  it('reads the end month after the "to" clause, never a start date', () => {
    expect(statedEndMonth('from 10/2022 to 10/2026', 2026)).toBe(10);
    expect(statedEndMonth('from 04/2026 to 2026', 2026)).toBeNull();
  });

  it('returns null for no month, a month in another year, an invalid month, a non-month word, or conflicting months', () => {
    expect(statedEndMonth('20-yr to 2026', 2026)).toBeNull();
    expect(statedEndMonth('to 03-2027', 2026)).toBeNull();
    expect(statedEndMonth('to 13/2026', 2026)).toBeNull();
    expect(statedEndMonth('to 00/2026', 2026)).toBeNull();
    expect(statedEndMonth('to Marathon 2026', 2026)).toBeNull();
    expect(statedEndMonth('to 2026-2028', 2026)).toBeNull();
    expect(statedEndMonth('to 03/2026 or 11/2026', 2026)).toBeNull();
    expect(statedEndMonth(null, 2026)).toBeNull();
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
      report({ reportId: 'A', propertyKey: 'a', propertyLabel: 'Alpha', reportDate: '2016-10', immediateUsd: 200000 }),
      report({ reportId: 'B', propertyKey: 'b', propertyLabel: 'Beta', reportDate: '2015-08-12', immediateUsd: 50000 }),
      report({ reportId: 'C', propertyKey: 'c', propertyLabel: 'Gamma', reportDate: '2026-04-07', immediateUsd: 90000 }), // fresh
    ]);
    expect(out).toHaveLength(1);
    const i = out[0]!;
    expect(i.severity).toBe('info');
    expect(i.category).toBe('capex');
    expect(i.title).toBe('Dated PCA on file — 2 properties');
    expect(i.metric).toBe('2');
    expect(i.detail.indexOf('Alpha')).toBeLessThan(i.detail.indexOf('Beta'));
    expect(i.detail).not.toContain('Gamma');
    // Both are pre-2024, so STALE under the one vintage rule: history only, never fed to totals or the improve gate.
    expect(i.detail).toContain('history only');
    expect(i.detail).not.toContain('still used');
  });

  it('a 5+ calendar-year-old report that is NOT stale (dated 2024+) is still used, and says so', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports: [report({ reportId: 'A', propertyKey: 'a', propertyLabel: 'Alpha', reportDate: '2024-03-01', immediateUsd: 100 })] }));
      const i = propertyConditionConditions(db, '2029-01-02').find((x) => x.id === 'pca-dated-reports')!;
      expect(i.detail).toContain('still used');
      expect(i.detail).not.toContain('history only');
    } finally {
      db.close();
    }
  });

  it('age is CALENDAR years (as-of year minus report year), and the copy says so', () => {
    const db = freshDb();
    try {
      writeRegister(db, parsed({ reports: [report({ reportId: 'A', propertyKey: 'a', propertyLabel: 'Alpha', reportDate: '2021-12-31', immediateUsd: 100 })] }));
      const i = propertyConditionConditions(db, '2026-01-02').find((x) => x.id === 'pca-dated-reports')!;
      expect(i.detail).toContain('5+ calendar years old');
    } finally {
      db.close();
    }
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
      report({ reportId: 'OLD', propertyKey: 'p', reportDate: '2014-10-23', immediateUsd: 3000 }),
      report({ reportId: 'NEW', propertyKey: 'p', reportDate: '2026-04-07', immediateUsd: 1000 }),
    ]);
    expect(out).toEqual([]);
  });

  it('shortens register labels that carry parentheticals or dash notes', () => {
    const i = run([
      report({ reportId: 'A', propertyKey: 'a', propertyLabel: "100 Example Rd (folder labelled '120 Example Road')", reportDate: '2007-07-19', immediateUsd: 10000 }),
      report({ reportId: 'B', propertyKey: 'b', propertyLabel: 'Synthetic Park — 200-210 Sample Dr + 300-310 Sample Way', reportDate: '2014-10-23', immediateUsd: 3000 }),
    ])[0]!;
    expect(i.detail).toContain('100 Example Rd (19 yrs');
    expect(i.detail).toContain('Synthetic Park (12 yrs');
    expect(i.detail).not.toContain('folder labelled');
    expect(i.detail).not.toContain('Sample Way');
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
      reports: [report({ propertyLabel: 'Synthetic Park', reportDate: '2014-10-23', immediateUsd: 3000 })],
      assets: [asset({ propertyLabel: 'Synthetic Park', component: 'Roof', warrantyEndYear: 2028, warranty: '20-yr to 2028' })],
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
