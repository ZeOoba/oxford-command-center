// @vitest-environment node
//
// tests/unit/import-acq-screen-packet.test.ts
//
// scripts/import-acq-screen-packet.ts — parser rejects, candidate crosswalk, idempotent scoring through
// persistAndLogScore, per-packet isolation, batch provenance, CLI args. Synthetic RCT only
// (tests/support/rct.ts); a tmpdir SQLite, never data/warehouse/finance.sqlite. Pseudonymous deals.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { parseRuleset } from '../../server/warehouse/acquisition';
import type { AcquisitionRuleset } from '@contracts/acquisition';
import { loadTestRct } from '../support/rct';
import {
  SCREEN_PACKET_SCHEMA,
  importScreenPackets,
  latestScreenedAt,
  parseArgs,
  scoredTwin,
  streetKey,
  parseScreenPacket,
  parseScreenPacketPayload,
  resolveCandidate,
} from '../../scripts/import-acq-screen-packet';
import type { ParsedScreenPacket } from '../../scripts/import-acq-screen-packet';

const RULESET: AcquisitionRuleset = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadTestRct();
const FILE = { path: 'C:/deals/Example/screen-packet.json', sha256: 'a'.repeat(64) };

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-packet-test-')), 'test.sqlite'));
}

function seed(db: WarehouseDb, id: string, opts: { notion?: string; status?: string; address?: string } = {}): void {
  db.prepare("INSERT INTO acq_candidates (id, source, status, notion_deal_id, address) VALUES (?, 'notion-pipeline', ?, ?, ?)")
    .run(id, opts.status ?? 'active', opts.notion ?? null, opts.address ?? null);
}

function packet(over: Record<string, unknown> = {}, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SCREEN_PACKET_SCHEMA,
    skillVersion: 'acquisition-underwriting v4.55',
    screenedAt: '2026-11-12',
    deal: { notionPageId: 'page-aaa', address: '100 Example Way' },
    input: {
      price: 1_350_000, maxBuildingSf: 19_000, totalSf: 19_000, yearBuilt: 1970,
      sfhaOnPad: false, allInBasis: 1_540_000, stabilizedYoc: 0.06, unleveredIrr10yr: 0.074,
      ust10yr: 0.0501, ustAsOf: '2026-11-12', exitCapPct: 0.075, market: 'Columbus OH',
      clusterTier: 'established', isVacant: false, ddKnown: { flood: true },
      ...input,
    },
    ...over,
  };
}

function ok(p: ParsedScreenPacket | { reason: string }): ParsedScreenPacket {
  if ('reason' in p) throw new Error(`unexpected reject: ${p.reason}`);
  return p;
}

const count = (db: WarehouseDb, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe('parseScreenPacket', () => {
  it('accepts a valid packet; a missing dealId is left for the crosswalk to fill', () => {
    const p = ok(parseScreenPacket(packet()));
    expect(p.inputHadDealId).toBe(false);
    expect(p.input.price).toBe(1_350_000);
    expect(p.input.productType).toBeNull(); // blank stays blank, never inferred
  });

  it.each([
    ['wrong schema', packet({ schema: 'ora.acq-screen-packet/0' }), /schema/],
    ['blank skillVersion', packet({ skillVersion: ' ' }), /skillVersion/],
    ['US date', packet({ screenedAt: '11/12/2026' }), /ISO/],
    ['impossible date', packet({ screenedAt: '2026-02-30' }), /ISO/],
    ['no deal identity', packet({ deal: { address: 'x' } }), /candidateId, notionPageId or hubspotDealId/],
    ['unknown deal key', packet({ deal: { notionPageId: 'p', candidateID: 'x' } }), /deal/],
    ['unknown input key (misspelled field)', packet({}, { clearHeight: 24 }), /input/],
    ['input contract violation', packet({}, { officePct: 1.5 }), /input: officePct/],
    ['negative price', packet({}, { price: -1 }), /input\.price/],
    ['zero SF', packet({}, { totalSf: 0 }), /input\.totalSf/],
    ['largest building > total SF', packet({}, { maxBuildingSf: 30_000, totalSf: 19_000 }), /maxBuildingSf exceeds totalSf/],
    ['unknown top-level key', packet({ verdict: 'PURSUE' }), /packet/],
    // Percent-form rates (refute wf_c51f7c6a-65b HIGH): 6.0 / 7.43 used to parse and clear the floors.
    ['percent-form stabilizedYoc', packet({}, { stabilizedYoc: 6.0 }), /input\.stabilizedYoc: 6 is outside/],
    ['percent-form unleveredIrr10yr', packet({}, { unleveredIrr10yr: 7.43 }), /input\.unleveredIrr10yr: 7\.43 is outside/],
    ['percent-form leveredIrr', packet({}, { leveredIrr: 12 }), /input\.leveredIrr/],
    ['percent-form env remediation', packet({}, { envRemediationPctOfPrice: 15 }), /input\.envRemediationPctOfPrice/],
    ['negative env remediation', packet({}, { envRemediationPctOfPrice: -0.01 }), /input\.envRemediationPctOfPrice/],
  ])('rejects %s', (_name, raw, re) => {
    const r = parseScreenPacket(raw);
    expect('reason' in r).toBe(true);
    expect((r as { reason: string }).reason).toMatch(re);
  });

  it('accepts decimal rates at the band edges and a negative IRR', () => {
    ok(parseScreenPacket(packet({}, { stabilizedYoc: 0.5, unleveredIrr10yr: -0.12, leveredIrr: 1, envRemediationPctOfPrice: 0 })));
  });

  it('splits a { packets } payload into valid and rejected', () => {
    const { packets, rejected } = parseScreenPacketPayload({ packets: [packet(), packet({ screenedAt: 'x' })] });
    expect(packets).toHaveLength(1);
    expect(rejected).toEqual([expect.objectContaining({ index: 1 })]);
  });
});

describe('resolveCandidate', () => {
  it('matches candidateId, notion_deal_id, deal:<page> and deal:hubspot:<id>; never creates a row', () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    seed(db, 'deal:hubspot:42');
    expect(resolveCandidate(db, { notionPageId: 'page-aaa' })).toMatchObject({ kind: 'found', candidateId: 'deal:page-aaa' });
    expect(resolveCandidate(db, { hubspotDealId: '42' })).toMatchObject({ kind: 'found', candidateId: 'deal:hubspot:42' });
    expect(resolveCandidate(db, { candidateId: 'deal:hubspot:42', hubspotDealId: '42' })).toMatchObject({ kind: 'found' });
    expect(resolveCandidate(db, { notionPageId: 'nope' })).toEqual({ kind: 'unmapped' });
    expect(resolveCandidate(db, { notionPageId: 'page-aaa', hubspotDealId: '42' }))
      .toEqual({ kind: 'ambiguous', ids: ['deal:hubspot:42', 'deal:page-aaa'] });
    expect(count(db, 'SELECT COUNT(*) n FROM acq_candidates')).toBe(2);
  });
});

describe('importScreenPackets', () => {
  it('scores a mapped packet through the engine with cowork-skill provenance and a batch row', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    expect(r.scored).toHaveLength(1);
    expect(r.scored[0]).toMatchObject({ candidateId: 'deal:page-aaa', persisted: 'inserted', candidateStatus: 'active' });
    const inp = db.prepare('SELECT scored_by, input_json FROM acq_score_inputs').get() as { scored_by: string; input_json: string };
    expect(inp.scored_by).toBe('cowork-skill');
    expect((JSON.parse(inp.input_json) as { dealId: string }).dealId).toBe('deal:page-aaa');
    const cur = db.prepare('SELECT current_score_id AS id FROM acq_candidates WHERE id = ?').get('deal:page-aaa') as { id: number | null };
    expect(cur.id).not.toBeNull();
    expect(count(db, "SELECT COUNT(*) n FROM calibration_verdict WHERE subject_id = 'deal:page-aaa'")).toBe(1);
    const batch = db.prepare('SELECT id, source, candidate_count, notes FROM acq_source_batches').get() as
      { id: string; source: string; candidate_count: number; notes: string };
    expect(batch).toMatchObject({ id: `screen-packet:${'a'.repeat(16)}`, source: 'screen-packet', candidate_count: 1 });
    expect(JSON.parse(batch.notes)).toMatchObject({ sha256: FILE.sha256 });
  });

  it('is idempotent: a re-import of the same file skips what it already scored and writes nothing new', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const p = ok(parseScreenPacket(packet()));
    await importScreenPackets(db, [p], RULESET, RCT, FILE);
    const again = await importScreenPackets(db, [p], RULESET, RCT, FILE);
    expect(again).toMatchObject({ scored: [], alreadyImported: 1, stale: 0, ambiguous: 0, failed: 0 });
    // The same packet under another file name (other sha) re-runs the engine and is a no-op there too.
    const other = await importScreenPackets(db, [p], RULESET, RCT, { ...FILE, sha256: 'd'.repeat(64) });
    expect(other.scored[0]!.persisted).toBe('unchanged');
    for (const t of ['acq_score_inputs', 'acq_scores', 'calibration_verdict']) {
      expect(count(db, `SELECT COUNT(*) n FROM ${t}`)).toBe(1);
    }
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind LIKE 'acq-screen-packet-%'")).toBe(0);
  });

  it('re-importing a file never reinstates a same-day screen another file superseded (refute wf_52534d83-279)', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const f1 = [ok(parseScreenPacket(packet({ screenedAt: '2026-11-20' }, { stabilizedYoc: 0.09 })))];
    const f2 = [ok(parseScreenPacket(packet({ screenedAt: '2026-11-20' }, { stabilizedYoc: 0.05, price: 1_600_000 })))];
    await importScreenPackets(db, f1, RULESET, RCT, FILE);
    await importScreenPackets(db, f2, RULESET, RCT, { ...FILE, sha256: 'e'.repeat(64) });
    const currentPrice = () => (JSON.parse((db.prepare(`SELECT i.input_json FROM acq_candidates c
      JOIN acq_scores s ON s.id = c.current_score_id JOIN acq_score_inputs i ON i.id = s.score_input_id
      WHERE c.id = 'deal:page-aaa'`).get() as { input_json: string }).input_json) as { price: number }).price;
    expect(currentPrice()).toBe(1_600_000);
    const again = await importScreenPackets(db, f1, RULESET, RCT, FILE);
    expect(again).toMatchObject({ scored: [], alreadyImported: 1 });
    expect(currentPrice()).toBe(1_600_000);
  });

  it('a changed packet is a new input and becomes the current score', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet({}, { price: 1_200_000 })))], RULESET, RCT,
      { ...FILE, sha256: 'b'.repeat(64) });
    expect(r.scored[0]!.persisted).toBe('inserted');
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(2);
    // The current-score pointer follows the newest input.
    const latestPrice = (db.prepare(`SELECT i.input_json FROM acq_candidates c JOIN acq_scores s ON s.id = c.current_score_id
      JOIN acq_score_inputs i ON i.id = s.score_input_id WHERE c.id = 'deal:page-aaa'`).get() as { input_json: string }).input_json;
    expect((JSON.parse(latestPrice) as { price: number }).price).toBe(1_200_000);
  });

  it('unmapped and ambiguous deals are logged to data_quality_issues and never scored or inserted', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    seed(db, 'deal:hubspot:42');
    const r = await importScreenPackets(db, [
      ok(parseScreenPacket(packet({ deal: { notionPageId: 'missing-page' } }))),
      ok(parseScreenPacket(packet({ deal: { notionPageId: 'page-aaa', hubspotDealId: '42' } }))),
    ], RULESET, RCT, FILE);
    expect(r).toMatchObject({ unmapped: 1, ambiguous: 1, scored: [], batchId: null });
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind = 'acq-screen-packet-unmapped'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind = 'acq-screen-packet-ambiguous'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM acq_candidates')).toBe(2);
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) n FROM acq_source_batches')).toBe(0);
    // A repeat does not stack an identical open DQ row.
    await importScreenPackets(db, [ok(parseScreenPacket(packet({ deal: { notionPageId: 'missing-page' } })))], RULESET, RCT, FILE);
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind = 'acq-screen-packet-unmapped'")).toBe(1);
  });

  it('one failing packet does not block its siblings', async () => {
    const db = freshDb();
    seed(db, 'deal:bad');
    seed(db, 'deal:good');
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON acq_score_inputs WHEN NEW.candidate_id = 'deal:bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const r = await importScreenPackets(db, [
      ok(parseScreenPacket(packet({ deal: { candidateId: 'deal:bad' } }))),
      ok(parseScreenPacket(packet({ deal: { candidateId: 'deal:good' } }))),
    ], RULESET, RCT, FILE);
    expect(r.failed).toBe(1);
    expect(r.scored.map((s) => s.candidateId)).toEqual(['deal:good']);
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind = 'acq-screen-packet-check-violation'")).toBe(1);
  });

  it('scores a candidate that is already passed but writes no outcome (no hindsight calibration)', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa', status: 'passed' });
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    expect(r.scored[0]!.candidateStatus).toBe('passed');
    expect(count(db, 'SELECT COUNT(*) n FROM calibration_outcome')).toBe(0);
  });

  it('keeps a packet-supplied dealId', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    await importScreenPackets(db, [ok(parseScreenPacket(packet({}, { dealId: 'example-deal' })))], RULESET, RCT, FILE);
    const inp = db.prepare('SELECT input_json FROM acq_score_inputs').get() as { input_json: string };
    expect((JSON.parse(inp.input_json) as { dealId: string }).dealId).toBe('example-deal');
  });
});

describe('screen order, duplicates and twins (refute wf_c51f7c6a-65b)', () => {
  const fileB = { ...FILE, sha256: 'b'.repeat(64) };

  it('records screenedAt per candidate and skips an OLDER packet as stale; the same date is allowed', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    await importScreenPackets(db, [ok(parseScreenPacket(packet({ screenedAt: '2026-11-12' })))], RULESET, RCT, FILE);
    expect(latestScreenedAt(db, 'deal:page-aaa')).toBe('2026-11-12');
    const old = await importScreenPackets(db, [ok(parseScreenPacket(packet({ screenedAt: '2026-10-01' }, { price: 1_000_000 })))], RULESET, RCT, fileB);
    expect(old).toMatchObject({ stale: 1, scored: [], batchId: null });
    expect(count(db, "SELECT COUNT(*) n FROM data_quality_issues WHERE kind = 'acq-screen-packet-stale'")).toBe(1);
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(1);
    const same = await importScreenPackets(db, [ok(parseScreenPacket(packet({ screenedAt: '2026-11-12' }, { price: 1_300_000 })))], RULESET, RCT,
      { ...FILE, sha256: 'c'.repeat(64) });
    expect(same.scored[0]!.persisted).toBe('inserted');
  });

  it('a same-file re-import that newly scores a candidate MERGES its screen date, so an older packet is still stale (refute wf_de354fb0-4c3)', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const fileF = [
      ok(parseScreenPacket(packet({ screenedAt: '2026-11-20' }))),
      ok(parseScreenPacket(packet({ screenedAt: '2026-11-20', deal: { notionPageId: 'page-bbb' } }))),
    ];
    const r1 = await importScreenPackets(db, fileF, RULESET, RCT, FILE);
    expect(r1).toMatchObject({ unmapped: 1 });
    expect(latestScreenedAt(db, 'deal:page-bbb')).toBeNull();
    seed(db, 'deal:page-bbb', { notion: 'page-bbb' }); // the sync creates the candidate
    const r2 = await importScreenPackets(db, fileF, RULESET, RCT, FILE); // same file, same sha
    expect(r2.scored.map((s) => [s.candidateId, s.persisted])).toEqual([['deal:page-bbb', 'inserted']]);
    expect(r2.alreadyImported).toBe(1); // page-aaa: this file already scored it
    expect(latestScreenedAt(db, 'deal:page-bbb')).toBe('2026-11-20');
    expect(count(db, 'SELECT candidate_count AS n FROM acq_source_batches')).toBe(2);
    const older = await importScreenPackets(db,
      [ok(parseScreenPacket(packet({ screenedAt: '2026-10-01', deal: { notionPageId: 'page-bbb' } }, { stabilizedYoc: 0.11 })))],
      RULESET, RCT, fileB);
    expect(older).toMatchObject({ stale: 1, scored: [] });
  });

  it('a malformed batch notes row neither crashes the stale check nor blocks the merge', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    db.prepare("INSERT INTO acq_source_batches (id, source, notes) VALUES (?, 'screen-packet', '{not json')").run(`screen-packet:${'a'.repeat(16)}`);
    expect(latestScreenedAt(db, 'deal:page-aaa')).toBeNull();
    await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    expect(latestScreenedAt(db, 'deal:page-aaa')).toBe('2026-11-12');
  });

  it('rejects a file that names one candidate in two packets, scoring neither', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const r = await importScreenPackets(db, [
      ok(parseScreenPacket(packet({ screenedAt: '2026-11-12' }))),
      ok(parseScreenPacket(packet({ screenedAt: '2026-10-01', deal: { candidateId: 'deal:page-aaa' } }, { price: 1_000_000 }))),
    ], RULESET, RCT, FILE);
    expect(r).toMatchObject({ ambiguous: 2, scored: [] });
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
  });

  it('refuses to score the twin of a property whose other candidate already holds a current score', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa', address: '100 Example Road, Sampletown, OH' });
    seed(db, 'deal:hubspot:42', { address: '100 Example Rd' });
    seed(db, 'deal:hubspot:43', { address: '200 Other St' });
    await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    const r = await importScreenPackets(db, [
      ok(parseScreenPacket(packet({ deal: { hubspotDealId: '42' } }))),
      ok(parseScreenPacket(packet({ deal: { hubspotDealId: '43' } }))),
    ], RULESET, RCT, fileB);
    expect(r.ambiguous).toBe(1);
    expect(r.scored.map((s) => s.candidateId)).toEqual(['deal:hubspot:43']);
    expect(scoredTwin(db, 'deal:hubspot:42')).toBe('deal:page-aaa');
  });

  it('streetKey normalizes number + two words and returns null without a street number', () => {
    expect(streetKey('4410 Sample Road, Exampleville, OH')).toBe('4410 sample rd');
    expect(streetKey('Example Center — 4410 Sample Rd')).toBe('4410 sample rd');
    expect(streetKey('3849 N. Example Ave, Indy')).toBe('3849 n example');
    expect(streetKey('E Example Street, Columbus')).toBeNull();
    expect(streetKey(null)).toBeNull();
  });
});

describe('parseArgs', () => {
  it('takes one file, --db and --dry-run', () => {
    expect(parseArgs(['p.json'])).toEqual({ filePath: 'p.json', db: undefined, dryRun: false });
    expect(parseArgs(['p.json', '--db', 'x.sqlite', '--dry-run'])).toEqual({ filePath: 'p.json', db: 'x.sqlite', dryRun: true });
  });
  it('rejects a missing --db value, an unknown flag, and zero or two files', () => {
    expect(() => parseArgs(['p.json', '--db'])).toThrow(/--db/);
    expect(() => parseArgs(['p.json', '--force'])).toThrow(/unknown flag/);
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/Usage/);
  });
});
