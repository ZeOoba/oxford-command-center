// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openWarehouse } from '../../server/warehouse/db';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessFeeds,
  FEED_MAX_AGE_DAYS,
  lastAcqInputAt,
  lastBackupAt,
  lastLeaseEventsImportAt,
  lastLedgerImportAt,
  lastMarketSeriesAsOf,
  lastPcaImportAt,
  lastTaxAssessmentAsOf,
  readFeed,
} from '../../server/feed-freshness';
import { STALE_DAYS } from '../../server/warehouse/market-intel';
import { runMigrations } from '../../server/warehouse/migrate';

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
    // One property throughout (property_id defaults to 'a'): these cases test the date reading itself.
    db.exec("CREATE TABLE property_tax_assessments (as_of TEXT, property_id TEXT DEFAULT 'a', tax_year INTEGER); CREATE TABLE pca_reports (imported_at TEXT NOT NULL)");
    expect(lastTaxAssessmentAsOf(db)).toBeNull();
    expect(lastPcaImportAt(db)).toBeNull();
    db.exec("INSERT INTO property_tax_assessments (as_of) VALUES ('2024-07-01'), ('2025-07-01'), (NULL)");
    db.exec("INSERT INTO pca_reports VALUES ('2026-11-05 19:22:19'), ('2026-10-01 10:00:00')");
    expect(lastTaxAssessmentAsOf(db)).toBe('2025-07-01');
    expect(lastPcaImportAt(db)).toBe('2026-11-05 19:22:19');
    // Not lexical: '9/1/2025' would win a SQL MAX over '2026-01-01'; loose and future values are
    // ignored (refute round 2: '45658' parses as year 45658, '2052-01-01' is a typo year).
    db.exec("INSERT INTO property_tax_assessments (as_of) VALUES ('9/1/2025'), ('2026-01-01'), ('45658'), ('2052-01-01'), ('2026-02-30')");
    expect(lastTaxAssessmentAsOf(db, NOW)).toBe('2026-01-01');
    db.exec('DELETE FROM property_tax_assessments');
    db.exec("INSERT INTO property_tax_assessments (as_of) VALUES (NULL), ('FY2025'), ('2099-01-01')");
    expect(() => lastTaxAssessmentAsOf(db, NOW)).toThrow(/none with a valid past as_of/);
    db.close();
  });

  // Tier 1 follow-up (2026-11-24): MAX over every row let one fresh property hide a stale one.
  it('tax register freshness is the OLDEST property\'s latest valuation', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE property_tax_assessments (property_id TEXT, as_of TEXT, tax_year INTEGER)');
    db.exec("INSERT INTO property_tax_assessments VALUES ('a','2023-07-01',2023), ('a','2025-07-01',2025), ('b','2022-01-01',2022), ('b','not a date',NULL)");
    expect(lastTaxAssessmentAsOf(db, NOW)).toBe('2022-01-01');
    // A blank as_of falls back to 1 January of the tax year; a future tax year is ignored.
    db.exec("INSERT INTO property_tax_assessments VALUES ('b',NULL,2024), ('b',NULL,2099)");
    expect(lastTaxAssessmentAsOf(db, NOW)).toBe('2024-01-01');
    // A property with rows but no usable date cannot hide behind the others: the feed errors.
    db.exec("INSERT INTO property_tax_assessments VALUES ('c','2052-01-01',NULL), ('c','FY2025',NULL)");
    expect(() => lastTaxAssessmentAsOf(db, NOW)).toThrow(/1 property has assessments but no valid past as_of/);
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

// Tier 1 #2 (2026-11-23 review): market_series and lease_events gained writers
// (scripts/import-market-series.ts, scripts/import-lease-events.ts), so each gets a freshness row.
describe('market_series + lease_events feeds', () => {
  const MARKET_DDL = `CREATE TABLE market_series (cluster TEXT, as_of TEXT, source TEXT, metric TEXT);
    CREATE TABLE lease_events (abstract_date TEXT, source_file TEXT)`;

  it("marketSeries budget is the market-intel scorer's census-acs window", () => {
    expect(FEED_MAX_AGE_DAYS.marketSeries).toBe(STALE_DAYS['census-acs']);
    expect(FEED_MAX_AGE_DAYS.marketSeries).toBe(400);
    expect(FEED_MAX_AGE_DAYS.leaseEvents).toBe(14);
  });

  it('lastMarketSeriesAsOf: the stalest cluster, newest valid census-acs as_of; other sources ignored', () => {
    const db = new Database(':memory:');
    db.exec(MARKET_DDL);
    expect(lastMarketSeriesAsOf(db, NOW)).toBeNull();
    db.exec(`INSERT INTO market_series VALUES
      ('Cluster A', '2025-01-30', 'census-acs', 'vacancy_rate'),
      ('Cluster B', '2025-12-11', 'census-acs', 'vacancy_rate'),
      ('Cluster A', '2026-09-01', 'comps-ai', 'cap_rate'),
      ('Cluster A', '9/1/2026', 'census-acs', 'vacancy_rate'),
      ('Cluster A', '2025-02-30', 'census-acs', 'vacancy_rate'),
      ('Cluster A', '2099-01-01', 'census-acs', 'vacancy_rate')`);
    // Cluster A's newest valid release is 2025-01-30 (601 days, scorer-stale) even though Cluster B
    // has 2025-12-11: the feed reports the stalest cluster, matching the per-cluster scorer.
    expect(lastMarketSeriesAsOf(db, NOW)).toBe('2025-01-30');
    db.exec("INSERT INTO market_series VALUES ('Cluster A', '2026-01-29', 'census-acs', 'vacancy_rate')");
    expect(lastMarketSeriesAsOf(db, NOW)).toBe('2025-12-11');
    db.close();
  });

  it('lastMarketSeriesAsOf: census rows present but none valid throws (feed reads error)', () => {
    const db = new Database(':memory:');
    db.exec(MARKET_DDL);
    db.exec("INSERT INTO market_series VALUES ('Cluster A', 'ACS 2024', 'census-acs', 'v'), ('Cluster A', '2026-09-01', 'comps-ai', 'c')");
    expect(() => lastMarketSeriesAsOf(db, NOW)).toThrow(/none with a valid past as_of/);
    // One valid cluster does not mask another cluster whose rows are all invalid.
    db.exec("INSERT INTO market_series VALUES ('Cluster B', '2026-01-29', 'census-acs', 'v')");
    expect(() => lastMarketSeriesAsOf(db, NOW)).toThrow(/cluster Cluster A/);
    expect(readFeed(() => lastMarketSeriesAsOf(db, NOW))).toMatchObject({ error: expect.stringMatching(/census-acs/) });
    db.close();
  });

  it('lastLeaseEventsImportAt: newest created_at (UTC) over [DERIVED:] rows only', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE lease_events (abstract_date TEXT, source_file TEXT, created_at TEXT)');
    expect(lastLeaseEventsImportAt(db)).toBeNull();
    // Only non-derived rows: still 'never derived', not an error.
    db.exec("INSERT INTO lease_events VALUES ('2026-09-22', 'lease-abstract.pdf', '2026-09-22 10:00:00'), ('2026-09-22', NULL, '2026-09-22 10:00:00')");
    expect(lastLeaseEventsImportAt(db)).toBeNull();
    // abstract_date (the capture an event was seen in) does not drive the feed: an old capture
    // re-derived today is a run today.
    db.exec(`INSERT INTO lease_events VALUES
      ('2026-06-01', 'rent-roll-diff a -> b [DERIVED:first_absent]', '2026-09-20 06:15:00'),
      ('2026-05-01', 'rent-roll b [DERIVED:lease_start]', '2026-09-21 23:59:59'),
      ('2026-05-01', 'x [DERIVED:lease_start]', '2026-02-30 00:00:00'),
      ('2026-05-01', 'x [DERIVED:lease_start]', 'yesterday'),
      ('2026-05-01', 'x [DERIVED:lease_start]', NULL),
      ('2026-05-01', 'x [DERIVED-no-colon]', '2026-09-23 00:00:00')`);
    // SQLite datetime('now') carries no zone: it is UTC, returned as ISO with Z.
    expect(lastLeaseEventsImportAt(db)).toBe('2026-09-21T23:59:59Z');
    // Case-insensitive like the importer's own LIKE ownership match.
    db.exec("INSERT INTO lease_events VALUES ('2026-05-01', 'x [derived:lease_start]', '2026-09-22 01:00:00')");
    expect(lastLeaseEventsImportAt(db)).toBe('2026-09-22T01:00:00Z');
    db.exec("DELETE FROM lease_events WHERE created_at IN ('2026-09-20 06:15:00', '2026-09-21 23:59:59', '2026-09-22 01:00:00')");
    expect(() => lastLeaseEventsImportAt(db)).toThrow(/none with a valid created_at/);
    db.close();
  });

  it('lastLeaseEventsImportAt reads the migration-011 created_at default as UTC', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec("INSERT INTO lease_events (property_id, event_kind, event_date, source_file) VALUES ('P1', 'commence', '2026-01-01', 'x [DERIVED:lease_start]')");
    const at = lastLeaseEventsImportAt(db)!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(5 * 60_000);
    db.close();
  });

  it("on the real migrated schema with no importer run, both feeds read 'missing', not 'error'", () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const feeds = assessFeeds({
      marketSeries: readFeed(() => lastMarketSeriesAsOf(db, NOW)),
      leaseEvents: readFeed(() => lastLeaseEventsImportAt(db)),
    }, NOW);
    const by = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(by.marketSeries!.status).toBe('missing');
    expect(by.leaseEvents!.status).toBe('missing');
    expect(by.marketSeries!.label).toBe('Market series (Census ACS, latest release)');
    expect(by.leaseEvents!.label).toBe('Lease events (last import of rent-roll diffs)');
    expect(by.marketSeries!.fix).toMatch(/import-market-series\.ts --census/);
    expect(by.leaseEvents!.fix).toMatch(/import-lease-events\.ts/);
    db.close();
  });

  it('grades against the budgets', () => {
    const at = (id: 'marketSeries' | 'leaseEvents', d: string) =>
      assessFeeds({ [id]: d }, NOW).find((f) => f.id === id)!.status;
    expect(at('marketSeries', '2025-09-01')).toBe('fresh'); // 387 days
    expect(at('marketSeries', '2025-08-01')).toBe('stale'); // 418 days
    expect(at('leaseEvents', '2026-09-10T00:00:00Z')).toBe('fresh'); // 13.5 days
    expect(at('leaseEvents', '2026-09-08T00:00:00Z')).toBe('stale'); // 15.5 days
  });
});

describe('acqInputs feed (2026-11-23 review Tier 1 #3)', () => {
  it('is missing when no deal input was ever scored, then fresh, then stale after 30 days', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-feed-')), 't.sqlite'));
    expect(lastAcqInputAt(db)).toBeNull();
    expect(assessFeeds({ acqInputs: null }, NOW).find((f) => f.id === 'acqInputs')!.status).toBe('missing');
    db.prepare("INSERT INTO acq_candidates (id, source) VALUES ('c', 'manual')").run();
    // A POST /acq/score or re-score row is not a Cowork screen and never counts (refute wf_c51f7c6a-65b).
    db.prepare("INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, scored_at, scored_by) VALUES ('c', 'api-v', '{}', '2026-09-22 12:00:00', 'api')").run();
    expect(lastAcqInputAt(db)).toBeNull();
    db.prepare("INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, scored_at, scored_by) VALUES ('c', 'v', '{}', '2026-09-20 12:00:00', 'cowork-skill')").run();
    const at = lastAcqInputAt(db);
    expect(at).toBe('2026-09-20T12:00:00Z'); // stored UTC, read as UTC (not local time)
    expect(FEED_MAX_AGE_DAYS.acqInputs).toBe(30);
    expect(assessFeeds({ acqInputs: at }, NOW).find((f) => f.id === 'acqInputs')!.status).toBe('fresh');
    expect(assessFeeds({ acqInputs: '2026-08-01T00:00:00Z' }, NOW).find((f) => f.id === 'acqInputs')!.status).toBe('stale');
    db.close();
  });
});

// Merge gate PR #591, T-2: FeedInputs is Partial, so dropping a feed's input line from the /api/health
// assessFeeds call still type-checks and the feed silently reads 'missing' forever. Every feed id must be
// wired there. (Structural check on the source: booting server/index.ts in a unit test is heavy.)
describe('every feed is wired into /api/health', () => {
  it('server/index.ts passes an input for each FeedId', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8');
    const start = src.indexOf('assessFeeds({');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}, Date.now())', start));
    const ids = assessFeeds({}, NOW).map((f) => f.id);
    expect(ids).toContain('acqInputs');
    const unwired = ids.filter((id) => !new RegExp(String.raw`\b${id}\s*:`).test(block));
    expect(unwired).toEqual([]);
  });
});
