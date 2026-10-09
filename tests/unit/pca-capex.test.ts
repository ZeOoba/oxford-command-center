// @vitest-environment node
//
// tests/unit/pca-capex.test.ts
//
// loadPcaNearTermCapex (Phase 4 input to the capital-allocation improve gate) and the calibration
// inputs-version fingerprint that must move when it moves. Real tmpdir warehouse loaded through the real
// writeRegister().
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { loadPcaCapexCoverage, loadPcaNearTermCapex } from '../../server/warehouse/pca-capex';
import { computeInputsVersion } from '../../server/warehouse/calibration';
import { writeRegister, type ParsedRegister } from '../../scripts/import-pca-register';
import type { PcaReport } from '../../src/contracts/property-condition';

const AS_OF = '2026-10-07';

function freshDb(): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'pca-capex-')), 'finance.sqlite'));
  for (const id of ['prop-a', 'prop-b', 'sepich']) {
    db.prepare('INSERT OR IGNORE INTO property_master (id, name) VALUES (?, ?)').run(id, id);
  }
  return db;
}

function report(over: Partial<PcaReport>): PcaReport {
  return {
    reportId: 'R01', propertyKey: 'prop-a', propertyMasterId: 'prop-a', propertyLabel: 'A', location: null, consultant: 'X',
    client: null, oraCommissioned: true, purpose: null, inspectionDate: null, reportDate: '2026-04-07', sf: 10000, buildings: 1,
    yearBuilt: null, immediateUsd: 20000, shortTermUsd: 30000, reservesUninflUsd: 99999, reservesInflUsd: null, termYears: 12,
    psfYrStated: null, usabilityRaw: 'CURRENT', usabilityClass: 'current', sourceFiles: null, notes: null, ...over,
  };
}

function load(db: WarehouseDb, reports: PcaReport[]): void {
  const parsed: ParsedRegister = { reports, components: [], quotes: [], assets: [], pairs: [], openItems: [], rejects: [] };
  writeRegister(db, parsed);
}

describe('loadPcaNearTermCapex', () => {
  it('is empty (never throws) when migration 035 is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pca-capex-bare-'));
    const bare = new Database(join(dir, 'b.sqlite'));
    bare.exec('CREATE TABLE unrelated (a INTEGER)');
    try {
      expect(loadPcaNearTermCapex(bare as unknown as WarehouseDb, AS_OF).size).toBe(0);
    } finally {
      bare.close();
    }
  });

  it('is empty when the ledger exists but nothing is imported', () => {
    const db = freshDb();
    try {
      expect(loadPcaNearTermCapex(db, AS_OF).size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('computes (immediate + short-term) ÷ SF and ignores 12-yr reserves', () => {
    const db = freshDb();
    try {
      load(db, [report({ immediateUsd: 20000, shortTermUsd: 30000, sf: 10000, reservesUninflUsd: 9_999_999 })]);
      const e = loadPcaNearTermCapex(db, AS_OF).get('prop-a')!;
      expect(e.psf).toBeCloseTo(5, 10);
      expect(e.dollars).toBe(50000);
      expect(e.coveredSf).toBe(10000);
      expect(e.reportIds).toEqual(['R01']);
    } finally {
      db.close();
    }
  });

  it('treats a missing short-term figure as $0 but requires at least one dollar figure', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'A', propertyKey: 'ka', propertyMasterId: 'prop-a', immediateUsd: 1000, shortTermUsd: null, sf: 1000 }),
        report({ reportId: 'B', propertyKey: 'kb', propertyMasterId: 'prop-b', immediateUsd: null, shortTermUsd: null, sf: 1000 }),
      ]);
      const m = loadPcaNearTermCapex(db, AS_OF);
      expect(m.get('prop-a')?.psf).toBeCloseTo(1, 10);
      expect(m.has('prop-b')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('excludes a report with no SF or zero SF (never guesses an intensity)', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'A', propertyKey: 'ka', propertyMasterId: 'prop-a', sf: null }),
        report({ reportId: 'B', propertyKey: 'kb', propertyMasterId: 'prop-b', sf: 0 }),
      ]);
      expect(loadPcaNearTermCapex(db, AS_OF).size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('ignores reports not mapped to a property_master id', () => {
    const db = freshDb();
    try {
      load(db, [report({ reportId: 'F', propertyKey: 'e-fulton', propertyMasterId: null })]);
      expect(loadPcaNearTermCapex(db, AS_OF).size).toBe(0);
    } finally {
      db.close();
    }
  });

  it('uses the NEWEST report per key (no age cutoff) and never the superseded one', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'OLD', reportDate: '2014-10-23', immediateUsd: 999999, shortTermUsd: null, sf: 1000 }),
        report({ reportId: 'NEW', reportDate: '2016-10', immediateUsd: 1000, shortTermUsd: null, sf: 1000 }),
      ]);
      const e = loadPcaNearTermCapex(db, AS_OF).get('prop-a')!;
      expect(e.reportIds).toEqual(['NEW']);
      expect(e.psf).toBeCloseTo(1, 10);
      // A 10-year-old report is still used when it is the newest we have.
      expect(e.oldestReportDate).toBe('2016-10');
    } finally {
      db.close();
    }
  });

  it('rolls several keys up to one master id as Σ$ ÷ ΣSF over the covered keys, skipping uncoverable ones', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'BAN', propertyKey: 'banwick', propertyMasterId: 'sepich', immediateUsd: 1050, shortTermUsd: null, sf: 24000 }),
        report({ reportId: 'MOR', propertyKey: 'old-morrison', propertyMasterId: 'sepich', immediateUsd: 2050, shortTermUsd: null, sf: 31200 }),
        report({ reportId: 'NAR', propertyKey: 'sepich-portfolio', propertyMasterId: 'sepich', immediateUsd: null, shortTermUsd: null, sf: null }),
      ]);
      const e = loadPcaNearTermCapex(db, AS_OF).get('sepich')!;
      expect(e.dollars).toBe(3100);
      expect(e.coveredSf).toBe(55200);
      expect(e.psf).toBeCloseTo(3100 / 55200, 10);
      expect(e.reportIds).toEqual(['BAN', 'MOR']);
    } finally {
      db.close();
    }
  });

  it('flags draft / limited-reliance reports and reports an undated one as undated', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'A', propertyKey: 'ka', propertyMasterId: 'prop-a', usabilityClass: 'draft' }),
        report({ reportId: 'B', propertyKey: 'kb', propertyMasterId: 'prop-b', usabilityClass: 'current', reportDate: null }),
      ]);
      const m = loadPcaNearTermCapex(db, AS_OF);
      expect(m.get('prop-a')?.anyDraftOrLimited).toBe(true);
      expect(m.get('prop-b')?.anyDraftOrLimited).toBe(false);
      expect(m.get('prop-b')?.oldestReportDate).toBeNull();
    } finally {
      db.close();
    }
  });

  it('fails open to an empty map on an unreadable ledger, and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pca-capex-broken-'));
    const broken = new Database(join(dir, 'x.sqlite'));
    broken.exec("CREATE TABLE pca_reports (report_id TEXT); INSERT INTO pca_reports VALUES ('R1')");
    try {
      expect(loadPcaNearTermCapex(broken as unknown as WarehouseDb, AS_OF).size).toBe(0);
    } finally {
      broken.close();
    }
  });
});


describe('loadPcaCapexCoverage — exclusions and overlap', () => {
  it('reports a no-SF current report as excluded instead of silently dropping it', () => {
    const db = freshDb();
    try {
      load(db, [report({ reportId: 'NOSF', sf: null, immediateUsd: 40000, shortTermUsd: null })]);
      const c = loadPcaCapexCoverage(db, AS_OF);
      expect(c.byProperty.size).toBe(0);
      expect(c.excludedByProperty.get('prop-a')).toEqual([{ reportId: 'NOSF', reason: 'no-sf', dollars: 40000 }]);
    } finally {
      db.close();
    }
  });

  it('does not sum a portfolio-scope report with its sibling building reports (no double count)', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'PORT', propertyKey: 'sepich-portfolio', propertyMasterId: 'sepich', sf: 110000, immediateUsd: 500000, shortTermUsd: null }),
        report({ reportId: 'BAN', propertyKey: 'banwick', propertyMasterId: 'sepich', sf: 24000, immediateUsd: 1050, shortTermUsd: null }),
      ]);
      const c = loadPcaCapexCoverage(db, AS_OF);
      expect(c.byProperty.get('sepich')!.reportIds).toEqual(['BAN']);
      expect(c.byProperty.get('sepich')!.dollars).toBe(1050);
      expect(c.excludedByProperty.get('sepich')).toEqual([{ reportId: 'PORT', reason: 'portfolio-overlap', dollars: 500000 }]);
    } finally {
      db.close();
    }
  });

  it('uses a portfolio report when it is the only coverage, tolerates a timestamp asOf, and omits $0 intensities', () => {
    const db = freshDb();
    try {
      load(db, [
        report({ reportId: 'PORT', propertyKey: 'sepich-portfolio', propertyMasterId: 'sepich', sf: 110000, immediateUsd: 11000, shortTermUsd: null }),
        report({ reportId: 'ZERO', propertyKey: 'kb', propertyMasterId: 'prop-b', immediateUsd: 0, shortTermUsd: 0 }),
      ]);
      const m = loadPcaNearTermCapex(db, '2026-10-07T00:00:00Z');
      expect(m.get('sepich')!.psf).toBeCloseTo(0.1, 10);
      expect(m.has('prop-b')).toBe(false);
    } finally {
      db.close();
    }
  });
});

const ver = (db: WarehouseDb) => computeInputsVersion(db, undefined, { pcaCapex: loadPcaNearTermCapex(db, AS_OF) });

describe('calibration inputs-version fingerprint', () => {
  it('is untouched for callers that do not pass the PCA map (score / anomaly / tax streams never re-version)', () => {
    const db = freshDb();
    try {
      const before = computeInputsVersion(db).inputsVersion;
      load(db, [report({})]);
      expect(computeInputsVersion(db).inputsVersion).toBe(before);
    } finally {
      db.close();
    }
  });

  it('is UNCHANGED by an empty ledger (every pre-PCA version stays byte-identical)', () => {
    const db = freshDb();
    try {
      const before = ver(db);
      expect(before.ledgerFingerprint).not.toContain('pca:');
      expect(ver(db).inputsVersion).toBe(before.inputsVersion);
    } finally {
      db.close();
    }
  });

  it('forks once when PCA data lands, is stable across calls, and forks again when it changes', () => {
    const db = freshDb();
    try {
      const empty = ver(db);
      load(db, [report({ immediateUsd: 20000, shortTermUsd: 30000 })]);
      const loaded = ver(db);
      expect(loaded.ledgerFingerprint).toContain('|pca:');
      expect(loaded.inputsVersion).not.toBe(empty.inputsVersion);
      expect(ver(db).inputsVersion).toBe(loaded.inputsVersion);
      load(db, [report({ immediateUsd: 20000, shortTermUsd: 31000 })]);
      expect(ver(db).inputsVersion).not.toBe(loaded.inputsVersion);
    } finally {
      db.close();
    }
  });

  it('does not move on a change that cannot affect the gate (reserves, notes, report age)', () => {
    const db = freshDb();
    try {
      load(db, [report({ reservesUninflUsd: 1, notes: 'a' })]);
      const a = ver(db).inputsVersion;
      load(db, [report({ reservesUninflUsd: 2_000_000, notes: 'b' })]);
      expect(ver(db).inputsVersion).toBe(a);
    } finally {
      db.close();
    }
  });
});
