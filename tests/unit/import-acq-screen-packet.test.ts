// @vitest-environment node
//
// tests/unit/import-acq-screen-packet.test.ts
//
// scripts/import-acq-screen-packet.ts — parser rejects, candidate crosswalk, idempotent scoring through
// persistAndLogScore, per-packet isolation, batch provenance, CLI args. Synthetic RCT only
// (tests/support/rct.ts); a tmpdir SQLite, never data/warehouse/finance.sqlite. Pseudonymous deals.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { parseRuleset } from '../../server/warehouse/acquisition';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import type { AcquisitionRuleset } from '@contracts/acquisition';
import { loadTestRct } from '../support/rct';
import {
  SCREEN_PACKET_SCHEMA,
  importScreenPackets,
  latestScreenedAt,
  main,
  parseArgs,
  scoredTwin,
  streetKey,
  streetKeys,
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

  it('streetKeys holds every number + two words, always including streetKey', () => {
    expect([...streetKeys('Suite 120, 4410 Sample Road')]).toEqual(['120 4410 sample', '4410 sample rd']);
    expect(streetKeys('4410 Sample Rd, Exampleville, OH 40001').has(streetKey('4410 Sample Rd, Exampleville, OH 40001')!)).toBe(true);
    expect(streetKeys('E Example Street, Columbus').size).toBe(0);
    expect(streetKeys(null).size).toBe(0);
  });

  // A missed twin is double-scored — the costly direction. Every shape that defeated an earlier attempt to
  // pick THE street number or separate twins by city / ZIP / unit (merge gate PR #591 C-2; refutes
  // wf_6f36c81a-7bd, wf_aea96b00-a7e) must be caught: the second twin skips as ambiguous.
  it.each([
    ['4410 Sample Rd, Suite 100, Exampleville OH', '4410 Sample Road, Exampleville, OH 40001'],
    ['4410 Sample Rd, Bldg B, Exampleville', '4410 Sample Rd, Exampleville'],
    ['Suite 120, 4410 Sample Road, Exampleville', '4410 Sample Road, Exampleville, OH 40001'],
    ['Suite #120, 4410 Sample Road', '4410 Sample Rd'],
    ['4410 Sample Rd, Exampleville, OH 40001', '4410 Sample Rd - 25000 SF flex'],
    ['4410 Sample Rd, Exampleville, OH 40001', '4410 Sample Rd, OH 40001 (12000 SF)'],
    ['4410 Sample Rd, Exampleville OH 40001', 'Commerce Building 4410 Sample Rd'],
    ['4410 66 Hwy', '4410 66 Highway, Exampleville, OH 40001'],
    ['4410 1/2 Sample Rd', '4410 1/2 Sample Road'],
  ])('a twin is caught: %s vs %s', async (scored, other) => {
    await expectTwin(scored, other, true);
  });

  // Refute wf_99b93364-38d: extra keys built from size / ZIP figures matched unrelated properties.
  it.each([
    ['100 Main St (15,000 SF)', '2200 Oak Ave (22,000 SF)'],
    ['100 Main St, Exampleville, OH 40001, USA', '2200 High St, Exampleville, OH 40001, USA'],
    ['100 Main St - 15,000 SF flex', '2200 Oak Ave - 48,000 SF flex'],
    ['100 Main St 25000 SF', '2200 Oak Ave 25000 SF'],
  ])('different properties sharing only a size or ZIP figure are not twins: %s vs %s', async (scored, other) => {
    await expectTwin(scored, other, false);
  });

  async function expectTwin(scored: string, other: string, twin: boolean): Promise<void> {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa', address: scored });
    seed(db, 'deal:hubspot:42', { address: other });
    await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet({ deal: { hubspotDealId: '42' } })))], RULESET, RCT, fileB);
    expect(r).toMatchObject(twin ? { scored: [], ambiguous: 1 } : { ambiguous: 0 });
    if (!twin) expect(r.scored).toHaveLength(1);
  }

  // Refute wf_99b93364-38d: the named-twice count used to be read once, before any lock. A sync that creates
  // the candidate mid-run let the first packet score and the second slip through as 'already imported'
  // (exit 0, no DQ row). Under the lock both packets now resolve to it, so neither scores.
  it('a candidate created mid-run by a concurrent sync is still caught as named twice', async () => {
    const db = freshDb();
    let inserted = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (!inserted && sql === 'BEGIN IMMEDIATE') {
              inserted = true;
              seed(target, 'deal:page-race', { notion: 'page-race' }); // the sync commits just before our lock
            }
            return target.exec(sql);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await importScreenPackets(racing, [
      ok(parseScreenPacket(packet({ screenedAt: '2026-11-01', deal: { notionPageId: 'page-race' } }))),
      ok(parseScreenPacket(packet({ screenedAt: '2026-11-20', deal: { notionPageId: 'page-race' } }, { price: 1_200_000 }))),
    ], RULESET, RCT, FILE);
    expect(r).toMatchObject({ scored: [], ambiguous: 2, alreadyImported: 0 });
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
  });

  // The same-run backstop: packet 1 scores X; before packet 2's lock a sync makes packet 1's refs ambiguous
  // and links packet 2's Notion page to X, so the named-twice count for X is 1 and X is already in this
  // file's ledger. Without the backstop packet 2 would be a silent 'already imported' (exit 0).
  it('a later packet resolving to a candidate scored earlier in the same run is ambiguous, not already-imported', async () => {
    const db = freshDb();
    seed(db, 'deal:x');
    let begins = 0;
    const relinking = new Proxy(db, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (sql === 'BEGIN IMMEDIATE' && ++begins === 2) {
              seed(target, 'deal:hubspot:77');
              target.prepare("UPDATE acq_candidates SET notion_deal_id = 'page-late' WHERE id = 'deal:x'").run();
            }
            return target.exec(sql);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await importScreenPackets(relinking, [
      ok(parseScreenPacket(packet({ deal: { candidateId: 'deal:x', hubspotDealId: '77' } }))),
      ok(parseScreenPacket(packet({ deal: { notionPageId: 'page-late' } }, { price: 1_200_000 }))),
    ], RULESET, RCT, FILE);
    expect(r.scored.map((s) => s.candidateId)).toEqual(['deal:x']);
    expect(r).toMatchObject({ ambiguous: 1, alreadyImported: 0 });
    const dq = db.prepare("SELECT detail FROM data_quality_issues WHERE kind = 'acq-screen-packet-ambiguous'").all() as Array<{ detail: string }>;
    expect(dq.some((d) => d.detail.includes('the first was scored'))).toBe(true);
  });

  it('the stale guard ignores a future date already sitting in the ledger', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    db.prepare("INSERT INTO acq_source_batches (id, source, notes) VALUES ('screen-packet:legacy', 'screen-packet', ?)")
      .run(JSON.stringify({ screens: { 'deal:page-aaa': '2062-11-12' } }));
    expect(latestScreenedAt(db, 'deal:page-aaa', Date.parse('2026-11-23T12:00:00Z'))).toBeNull();
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet()))], RULESET, RCT, FILE);
    expect(r).toMatchObject({ stale: 0 });
    expect(r.scored).toHaveLength(1);
  });
});

describe('merge gate PR #591 round 1 regressions', () => {
  it('C-1: rejects a future screenedAt (one day of timezone slack allowed)', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    expect(parseScreenPacket(packet({ screenedAt: '2062-11-12' }), 0, now)).toMatchObject({ reason: expect.stringMatching(/in the future/) });
    expect('reason' in parseScreenPacket(packet({ screenedAt: '2026-11-24' }), 0, now)).toBe(false);
    expect(parseScreenPacket(packet({ screenedAt: '2026-11-25' }), 0, now)).toMatchObject({ reason: expect.stringMatching(/in the future/) });
  });

  it('C-3: rejects a non-finite number anywhere in the input (JSON 1e400 parses to Infinity)', () => {
    const viaJson = JSON.parse(JSON.stringify(packet()).replace('"price":1350000', '"price":1350000,"clearHeightFt":1e400')) as unknown;
    expect(parseScreenPacket(viaJson)).toMatchObject({ reason: expect.stringMatching(/input\.clearHeightFt: must be a finite number/) });
    expect(parseScreenPacket(packet({}, { truckCourtFt: -Infinity }))).toMatchObject({ reason: expect.stringMatching(/input\.truckCourtFt/) });
  });

  it('S-1: rejects a misspelled key inside ddKnown or use (nested objects are not stripped silently)', () => {
    expect(parseScreenPacket(packet({}, { ddKnown: { flood: true, roofs: true } })))
      .toMatchObject({ reason: expect.stringMatching(/input\.ddKnown\.roofs: unrecognized key/) });
    expect(parseScreenPacket(packet({}, { use: { automotive: false, childRelated: false, childSafetyReviewed: true, automotve: true } })))
      .toMatchObject({ reason: expect.stringMatching(/input\.use\.automotve: unrecognized key/) });
    expect('reason' in parseScreenPacket(packet({}, { use: { automotive: false, childRelated: false, childSafetyReviewed: true } }))).toBe(false);
  });

  it('persistAndLogScore without opts still stamps scored_by api (the existing callers keep their provenance)', async () => {
    const db = freshDb();
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const p = ok(parseScreenPacket(packet()));
    await persistAndLogScore(db, 'deal:page-aaa', { ...p.input, dealId: 'deal:page-aaa' }, RULESET, RCT);
    expect(db.prepare('SELECT scored_by FROM acq_score_inputs').get()).toEqual({ scored_by: 'api' });
  });

  // R-1 / R-2 / T-1: the guards, the score and the ledger date run under ONE write lock per packet. A second
  // process holds the write lock and commits a NEWER screen for the candidate; this import must wait for it
  // and then see it (stale). With the guards read outside the lock it scored the older packet instead.
  it('R-1: guards are read under the write lock, so a concurrent newer screen makes this packet stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acq-packet-lock-'));
    const path = join(dir, 'test.sqlite');
    const db = openWarehouse(path);
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    const holder = [
      "const D = require('better-sqlite3');",
      `const db = new D(${JSON.stringify(path)});`,
      "db.pragma('busy_timeout = 10000');",
      "db.exec('BEGIN IMMEDIATE');",
      "db.prepare(\"INSERT INTO acq_source_batches (id, source, candidate_count, notes) VALUES ('screen-packet:other', 'screen-packet', 1, ?)\")",
      "  .run(JSON.stringify({ screens: { 'deal:page-aaa': '2026-11-20' } }));",
      "process.stdout.write('locked\\n');",
      "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);",
    ].join('\n');
    const child = spawn(process.execPath, ['-e', holder], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res, rej) => {
      child.stdout.on('data', (b: Buffer) => { if (b.toString().includes('locked')) res(); });
      child.on('exit', (code) => rej(new Error(`lock holder exited early (${code})`)));
    });
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet({ screenedAt: '2026-11-12' })))], RULESET, RCT, FILE);
    await new Promise<void>((res) => { if (child.exitCode !== null) res(); else child.on('exit', () => res()); });
    expect(r).toMatchObject({ stale: 1, scored: [], failed: 0 });
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
    db.close();
  });

  it('a failed persist rolls back its ledger date with it (no date for a score that never landed)', async () => {
    const db = freshDb();
    seed(db, 'deal:bad');
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON acq_scores WHEN NEW.candidate_id = 'deal:bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const r = await importScreenPackets(db, [ok(parseScreenPacket(packet({ deal: { candidateId: 'deal:bad' } })))], RULESET, RCT, FILE);
    expect(r).toMatchObject({ failed: 1, scored: [], batchId: null });
    expect(count(db, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) n FROM acq_source_batches')).toBe(0);
    expect(db.inTransaction).toBe(false);
  });
});

describe('main() exit codes (merge gate PR #591, T-3)', () => {
  function writePacketFile(dir: string, body: unknown): string {
    const p = join(dir, 'packet.json');
    writeFileSync(p, JSON.stringify(body));
    return p;
  }
  it('dry run: 0 when every packet would score, 1 when one is unmapped or rejected; nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acq-packet-main-'));
    const dbPath = join(dir, 'test.sqlite');
    const db = openWarehouse(dbPath);
    seed(db, 'deal:page-aaa', { notion: 'page-aaa' });
    db.close();
    expect(await main([writePacketFile(dir, packet()), '--db', dbPath, '--dry-run'])).toBe(0);
    expect(await main([writePacketFile(dir, packet({ deal: { notionPageId: 'nope' } })), '--db', dbPath, '--dry-run'])).toBe(1);
    expect(await main([writePacketFile(dir, { packets: [packet(), packet({ screenedAt: 'x' })] }), '--db', dbPath, '--dry-run'])).toBe(1);
    expect(await main([join(dir, 'missing.json'), '--db', dbPath])).toBe(1);
    const check = openWarehouse(dbPath);
    expect(count(check, 'SELECT COUNT(*) n FROM acq_score_inputs')).toBe(0);
    check.close();
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
