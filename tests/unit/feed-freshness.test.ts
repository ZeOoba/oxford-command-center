// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessFeeds,
  FEED_MAX_AGE_DAYS,
  lastBackupAt,
  lastLedgerImportAt,
  lastPcaImportAt,
  lastTaxAssessmentAsOf,
  readFeed,
} from '../../server/feed-freshness';

const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('assessFeeds', () => {
  it('grades each feed against its own max age and reports missing feeds', () => {
    const feeds = assessFeeds({
      snapshot: '2026-09-22T14:38:33Z',
      cashHistory: '2026-07-10',
      ar: '2026-07-15',
      dailyBrief: '2026-07-09T11:00:00Z',
      leaseMarket: null,
      docIndex: '2026-06-06T15:54:00Z',
      warehouseLedger: '2026-06-13T19:52:51.570Z',
    }, NOW);
    const by = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(by.snapshot!.status).toBe('fresh');
    expect(by.cashHistory!.status).toBe('stale');
    expect(by.ar!.status).toBe('stale');
    expect(by.dailyBrief!.status).toBe('stale');
    expect(by.dailyBrief!.ageDays).toBe(76);
    expect(by.leaseMarket!.status).toBe('missing');
    expect(by.docIndex!.status).toBe('stale');
    expect(by.warehouseLedger!.status).toBe('stale');
    expect(by.warehouseLedger!.ageDays).toBe(101);
    expect(feeds.every((f) => f.fix.length > 0)).toBe(true);
    expect(FEED_MAX_AGE_DAYS.dailyBrief).toBe(1.5);
  });

  // I-3 (2026-09-23 review): the Data Feeds row's dailyBrief budget (1.5 days) must agree with the
  // card badge's BRIEF_STALE_HOURS = 36 (src/lib/freshness.ts) to the millisecond, not just the day.
  it('dailyBrief boundary: exactly 36h old is fresh, 36h + 1min old is stale', () => {
    const exactly36h = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();
    const over36h = new Date(NOW - (36 * 60 * 60 * 1000 + 60 * 1000)).toISOString();
    const feedsAt = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, leaseMarket: null, docIndex: null, warehouseLedger: null,
      dailyBrief: exactly36h,
    }, NOW);
    const feedsOver = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, leaseMarket: null, docIndex: null, warehouseLedger: null,
      dailyBrief: over36h,
    }, NOW);
    expect(feedsAt.find((f) => f.id === 'dailyBrief')!.status).toBe('fresh');
    expect(feedsOver.find((f) => f.id === 'dailyBrief')!.status).toBe('stale');
  });

  it('a feed exactly at its own maxAgeDays boundary is fresh (ms-exact comparison, not floor-then-compare)', () => {
    const exactlyAtMax = new Date(NOW - FEED_MAX_AGE_DAYS.leaseMarket * 24 * 60 * 60 * 1000).toISOString();
    const feeds = assessFeeds({
      snapshot: null, cashHistory: null, ar: null, dailyBrief: null, docIndex: null, warehouseLedger: null,
      leaseMarket: exactlyAtMax,
    }, NOW);
    expect(feeds.find((f) => f.id === 'leaseMarket')!.status).toBe('fresh');
  });

  it('warehouseLedger: 45-day budget on the last COMMITTED import (roadmap 2026-10-30, 1.1)', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE import_batches (imported_at TEXT NOT NULL, status TEXT NOT NULL)");
    expect(lastLedgerImportAt(db)).toBeNull();
    db.exec(`INSERT INTO import_batches VALUES
      ('2026-06-13T19:52:50.801Z', 'committed'),
      ('2026-08-30T10:00:00.000Z', 'committed'),
      ('2026-09-20T10:00:00.000Z', 'superseded'),
      ('2026-09-21T10:00:00.000Z', 'pending-review')`);
    const at = lastLedgerImportAt(db);
    expect(at).toBe('2026-08-30T10:00:00.000Z');
    const feed = (lastAt: string | null) =>
      assessFeeds({ snapshot: null, cashHistory: null, ar: null, dailyBrief: null, leaseMarket: null, docIndex: null, warehouseLedger: lastAt }, NOW)
        .find((f) => f.id === 'warehouseLedger')!;
    expect(FEED_MAX_AGE_DAYS.warehouseLedger).toBe(45);
    expect(feed(at).status).toBe('fresh'); // 24 days before NOW
    expect(feed('2026-08-08T11:59:00Z').status).toBe('stale'); // just over 45 days
    expect(feed(null).status).toBe('missing');
    db.close();
  });
});

// Tier 1 data honesty (2026-11-23 review): a read FAILURE must not look like "never imported", and
// the registers + backup + overlay get their own rows so they cannot go stale silently.
describe('Tier 1 feed honesty', () => {
  it("a read failure grades 'error' (not 'missing') and carries the message", () => {
    const feeds = assessFeeds({ warehouseLedger: { error: 'SQLITE_BUSY: database is locked' } }, NOW);
    const ledger = feeds.find((f) => f.id === 'warehouseLedger')!;
    expect(ledger.status).toBe('error');
    expect(ledger.lastAt).toBeNull();
    expect(ledger.error).toBe('SQLITE_BUSY: database is locked');
    // An omitted input is still 'missing', never 'error'.
    expect(feeds.find((f) => f.id === 'snapshot')!.status).toBe('missing');
  });

  it('grades the backup, overlay and register feeds', () => {
    expect(FEED_MAX_AGE_DAYS.backup).toBe(2);
    const feeds = assessFeeds({
      backup: '2026-09-17T03:00:00Z',
      overlay: '2026-09-23T08:00:00Z',
      taxRegister: '2025-07-01',
      pcaRegister: '2026-09-05T19:22:19Z',
    }, NOW);
    const by = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(by.backup!.status).toBe('stale'); // 6 days before NOW, budget 2
    expect(by.overlay!.status).toBe('fresh');
    expect(by.taxRegister!.status).toBe('fresh'); // 449 days, inside the 18-month cycle
    expect(by.pcaRegister!.status).toBe('fresh');
    expect(feeds.every((f) => f.fix.length > 0)).toBe(true);
  });

  it('backup goes stale after 2 days', () => {
    const at = (d: string) => assessFeeds({ backup: d }, NOW).find((f) => f.id === 'backup')!.status;
    expect(at('2026-09-21T11:00:00Z')).toBe('stale');
    expect(at('2026-09-22T12:00:00Z')).toBe('fresh');
  });

  it('lastBackupAt reads manifest.json `at`; missing dir is null; a corrupt manifest throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feed-backup-'));
    try {
      expect(lastBackupAt(join(dir, 'absent'))).toBeNull();
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ latest: 'x.enc', at: '2026-09-20T03:00:00.000Z' }));
      expect(lastBackupAt(dir)).toBe('2026-09-20T03:00:00.000Z');
      writeFileSync(join(dir, 'manifest.json'), '{not json');
      expect(() => lastBackupAt(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('register readers return the newest stamp, or null when the table is empty', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE property_tax_assessments (as_of TEXT); CREATE TABLE pca_reports (imported_at TEXT NOT NULL)');
    expect(lastTaxAssessmentAsOf(db)).toBeNull();
    expect(lastPcaImportAt(db)).toBeNull();
    db.exec("INSERT INTO property_tax_assessments VALUES ('2024-07-01'), ('2025-07-01'), (NULL)");
    db.exec("INSERT INTO pca_reports VALUES ('2026-11-05 19:22:19'), ('2026-10-01 10:00:00')");
    expect(lastTaxAssessmentAsOf(db)).toBe('2025-07-01');
    expect(lastPcaImportAt(db)).toBe('2026-11-05 19:22:19');
    // Not lexical: '9/1/2025' would win a SQL MAX over '2026-01-01'; loose and future values are
    // ignored (refute round 2: '45658' parses as year 45658, '2052-01-01' is a typo year).
    db.exec("INSERT INTO property_tax_assessments VALUES ('9/1/2025'), ('2026-01-01'), ('45658'), ('2052-01-01'), ('2026-02-30')");
    expect(lastTaxAssessmentAsOf(db, NOW)).toBe('2026-01-01');
    db.exec('DELETE FROM property_tax_assessments');
    db.exec("INSERT INTO property_tax_assessments VALUES (NULL), ('FY2025'), ('2099-01-01')");
    expect(() => lastTaxAssessmentAsOf(db, NOW)).toThrow(/none with a valid past as_of/);
    db.close();
  });

  it('a stamp more than a day in the future grades error, never fresh', () => {
    const f = assessFeeds({ taxRegister: '2052-01-01' }, NOW).find((x) => x.id === 'taxRegister')!;
    expect(f.status).toBe('error');
    expect(f.error).toMatch(/in the future/);
  });

  it('readFeed turns a throw into an error input', () => {
    expect(readFeed(() => '2026-09-01')).toBe('2026-09-01');
    expect(readFeed(() => null)).toBeNull();
    expect(readFeed(() => { throw new Error('boom'); })).toEqual({ error: 'boom' });
  });
});
