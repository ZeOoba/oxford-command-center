// tests/unit/bake-warehouse-acq-redaction.test.ts
//
// Audit 2026-10-13, Wave 1 F1 (Hard Invariant 3). A REDACTED (public-safe) warehouse bake used to
// drop only /lease-market/*: /brain/report still carried acquisition-candidate addresses (the
// floor-indeterminate open-question titles embed acq_candidates.address, which the HubSpot sync
// fills with the raw dealname) and /calibration/log + the brain report's trackRecord carried
// deal-kind subjectIds (`parcel:<state>:<county>:<apn>`, `pipeline:<candidateId>`). Every value
// below is SYNTHETIC — no real deal, address or parcel number.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { inProcessResolver, buildWarehouseEnvelope, buildWarehouseBake, bakeWarehouseJson } from '../../scripts/bake-warehouse';

// Same seam as lease-market-api-bake.test.ts: keeps server/brain's heavy graph out of this suite.
vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn(() => null) },
}));

const DEALNAME_AS_ADDRESS = 'Synthetic Heron Flex Deal - 4417 Fictional Pkwy';
const APN = 'APN-SYN-000417';
const CANDIDATE_ID = `parcel:zz:synthcounty:${APN}`;
const PIPELINE_SUBJECT = `pipeline:${CANDIDATE_ID}`;
const PROPERTY_ID = 'synthetic-property-1';
const ROSTER_TERM = 'zanzibar quill';
const SECRETS = [DEALNAME_AS_ADDRESS, '4417 Fictional', APN, CANDIDATE_ID, PIPELINE_SUBJECT];

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const openDbs: WarehouseDb[] = [];
const openDirs: string[] = [];
const ORIGINAL_TERMS = process.env.CONFIDENTIAL_TERMS_PATH;
const ORIGINAL_PLACEHOLDER = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
let rosterDir: string;

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  rosterDir = mkdtempSync(join(tmpdir(), 'acq-redact-roster-'));
  openDirs.push(rosterDir);
  const p = join(rosterDir, 'terms.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic Deal', active: true, always: [ROSTER_TERM] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_TERMS === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = ORIGINAL_TERMS;
  if (ORIGINAL_PLACEHOLDER === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = ORIGINAL_PLACEHOLDER;
  vi.restoreAllMocks();
});

/** A migrated warehouse carrying one synthetic confidential acquisition candidate (dealname stored
 *  as its address, APN in its id), a floor-indeterminate score for it, a resolved deal-kind
 *  acquisition verdict, an open capital-allocation `buy` verdict on its pipeline token, and one
 *  resolved PROPERTY verdict as the positive control that redaction is not wiping everything. */
function seed(opts: { dqDetail?: string; importFileName?: string } = {}): { db: WarehouseDb; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acq-redact-db-'));
  openDirs.push(dir);
  const dbPath = join(dir, 't.sqlite');
  const db = openWarehouse(dbPath);
  openDbs.push(db);
  db.prepare(`INSERT INTO acq_candidates (id, source, address, status) VALUES (?, 'hubspot-pipeline', ?, 'active')`)
    .run(CANDIDATE_ID, DEALNAME_AS_ADDRESS);
  const inp = db.prepare(`INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES (?, 'iv-syn', '{}')`)
    .run(CANDIDATE_ID);
  db.prepare(`
    INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json)
    VALUES (?, ?, 'iv-syn', 50, 'T2', 'WATCH', 1, '{}')
  `).run(CANDIDATE_ID, inp.lastInsertRowid);
  db.prepare(`
    INSERT INTO calibration_inputs_version (inputs_version, ledger_fingerprint, config_hash, code_version, config_json)
    VALUES ('civ-syn', 'fp', 'ch', 'dev', '{}')
  `).run();
  const verdict = db.prepare(`
    INSERT INTO calibration_verdict
      (subject_kind, subject_id, verdict_kind, verdict_engine, predicted_band, as_of_period, horizon_periods,
       inputs_version, emitted_by, dedup_key)
    VALUES (?, ?, ?, ?, ?, '2025', 1, 'civ-syn', 'test', ?)
  `);
  const outcome = db.prepare(`
    INSERT INTO calibration_outcome (calibration_id, realized_band, outcome_period, hit, resolved_by, resolution_basis, is_resolution)
    VALUES (?, ?, '2026', 1, 'manual:test', 'test', 1)
  `);
  const dealV = verdict.run('deal', CANDIDATE_ID, 'acquisition-score', 'acquisition', 'WATCH', `deal|${CANDIDATE_ID}|acq`);
  outcome.run(dealV.lastInsertRowid, 'WATCH');
  verdict.run('deal', PIPELINE_SUBJECT, 'capital-action-v2', 'capital-allocation', 'buy', `deal|${PIPELINE_SUBJECT}|cap`);
  const propV = verdict.run('property', PROPERTY_ID, 'health-band', 'scores', 'healthy', `property|${PROPERTY_ID}|hb`);
  outcome.run(propV.lastInsertRowid, 'healthy');
  if (opts.dqDetail) {
    db.prepare(`INSERT INTO data_quality_issues (property_id, kind, detail) VALUES (?, 'synthetic-check', ?)`)
      .run(PROPERTY_ID, opts.dqDetail);
  }
  if (opts.importFileName) {
    db.prepare(`
      INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, version, status)
      VALUES (?, 'hash-syn-1', 'raw/syn.xlsx', '2026-10-01T00:00:00Z', 1, 'active')
    `).run(opts.importFileName);
  }
  return { db, dbPath };
}

const blobOf = (endpoints: Record<string, unknown>) => JSON.stringify(endpoints);

describe('warehouse bake — acquisition redaction in redacted mode (F1)', () => {
  it('control: includeConfidential:true still bakes the candidate address and deal subjects (the checks below are not vacuous)', async () => {
    const { db } = seed();
    const env = await buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: true });
    const blob = blobOf(env.endpoints);
    expect(blob).toContain(DEALNAME_AS_ADDRESS);
    expect(blob).toContain(PIPELINE_SUBJECT);
  });

  it('redacted: /brain/report and /calibration/* keep property data but carry no candidate address, APN or pipeline token', async () => {
    const { db } = seed();
    const env = await buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false });
    const report = env.endpoints['/api/warehouse/brain/report'] as {
      openQuestions: Array<{ kind: string }>; trackRecord: Array<{ subject: string }>;
    };
    expect(report).toBeDefined();
    expect(report.openQuestions.some((q) => q.kind === 'floor-indeterminate')).toBe(false);
    expect(report.trackRecord.map((t) => t.subject)).toEqual([PROPERTY_ID]);
    const log = env.endpoints['/api/warehouse/calibration/log'] as { log: Array<{ subjectId: string; subjectKind: string }> };
    expect(log.log.map((r) => r.subjectId)).toEqual([PROPERTY_ID]);
    expect(env.endpoints['/api/warehouse/calibration/report']).toBeDefined();
    const blob = blobOf(env.endpoints);
    for (const s of SECRETS) expect(blob, `redacted bake must not contain "${s}"`).not.toContain(s);
  });

  it('redacted is the DEFAULT when includeConfidential is omitted', async () => {
    const { db } = seed();
    const env = await buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read' });
    const blob = blobOf(env.endpoints);
    for (const s of SECRETS) expect(blob).not.toContain(s);
  });

  it('redacted: a roster hit anywhere in a scanned payload drops that whole route', async () => {
    const { db } = seed({ dqDetail: 'Reconcile the Zanzibar Quill closing statement' });
    const env = await buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false });
    expect(env.endpoints['/api/warehouse/brain/report']).toBeUndefined();
    // The un-hit calibration routes still bake.
    expect(env.endpoints['/api/warehouse/calibration/log']).toBeDefined();
  });

  // Refute round 6, G4: the redacted bake scanned only the four acquisition routes, so a roster term
  // in free text on ANY other route (/issues detail or fileName, /imports fileName, ...) baked into
  // public/warehouse.json unscanned. Every planned endpoint is now scanned, and a roster that cannot
  // be verified refuses the whole bake (previously: only the four scanned routes were dropped).
  it('redacted: a roster term in an /issues detail drops /issues, and the omission is recorded', async () => {
    const { db } = seed({ dqDetail: `Reconcile the Zanzibar${String.fromCodePoint(0xa0)}Quill closing statement` });
    const { envelope, omitted } = await buildWarehouseBake(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false });
    expect(envelope.endpoints['/api/warehouse/issues']).toBeUndefined();
    expect(omitted).toContain('/issues');
    expect(envelope.endpoints['/api/warehouse/noi']).toBeDefined();
    expect(blobOf(envelope.endpoints)).not.toMatch(/zanzibar/i);
  });

  it('redacted: a roster term in an /imports fileName drops /imports', async () => {
    const { db } = seed({ importFileName: 'Zanzibar_Quill_closing_rent_roll.xlsx' });
    const { envelope, omitted } = await buildWarehouseBake(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false });
    expect(envelope.endpoints['/api/warehouse/imports']).toBeUndefined();
    expect(omitted).toContain('/imports');
    expect(envelope.endpoints['/api/warehouse/noi']).toBeDefined();
    expect(blobOf(envelope.endpoints)).not.toMatch(/zanzibar/i);
  });

  it('redacted: every baked endpoint payload passed through the scanner', async () => {
    const { db } = seed();
    const seen: unknown[] = [];
    const env = await buildWarehouseEnvelope(inProcessResolver(db), {
      now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false,
      confidentialScan: (v) => { seen.push(v); return null; },
    });
    expect(Object.keys(env.endpoints).length).toBeGreaterThan(10);
    for (const payload of Object.values(env.endpoints)) expect(seen).toContain(payload);
  });

  it('private mode (includeConfidential:true) bakes verbatim and never calls the scanner', async () => {
    const { db } = seed({ importFileName: 'Zanzibar_Quill_closing_rent_roll.xlsx' });
    const env = await buildWarehouseEnvelope(inProcessResolver(db), {
      now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: true,
      confidentialScan: () => { throw new Error('must not be called'); },
    });
    expect(env.endpoints['/api/warehouse/imports']).toBeDefined();
  });

  it('redacted: an UNREADABLE roster REFUSES the bake', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(rosterDir, 'missing.json');
    const { db } = seed();
    await expect(buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false }))
      .rejects.toThrow(/refusing/i);
  });

  it('redacted: the PLACEHOLDER stand-in roster REFUSES the bake', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(rosterDir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { db } = seed();
    await expect(buildWarehouseEnvelope(inProcessResolver(db), { now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false }))
      .rejects.toThrow(/refusing/i);
  });

  it.each([['matrix', 'a plain route (/noi)'], ['openQuestions', 'an acquisition route (/brain/report)']])(
    'redacted: a scanner THROW on %s, %s, refuses the bake',
    async (marker) => {
      const { db } = seed();
      await expect(buildWarehouseEnvelope(inProcessResolver(db), {
        now: NOW, warehouseSource: 'checkpoint-read', includeConfidential: false,
        confidentialScan: (v) => {
          if (v && typeof v === 'object' && marker in v) throw new Error('roster gone');
          return null;
        },
      })).rejects.toThrow(/refusing/i);
    },
  );
});

// The orchestrator, end to end: what actually lands in public/warehouse.json on the unattended
// checkpoint-read path with MIRROR_INCLUDE_CONFIDENTIAL unset. Same cwd/restore discipline as
// lease-market-api-bake.test.ts's orchestrator suite.
describe('bakeWarehouseJson — redacted public/warehouse.json carries no acquisition identifiers (F1)', () => {
  const ORIGINAL_WAREHOUSE_DB = process.env.WAREHOUSE_DB;
  const ORIGINAL_BAKE_SOURCE_URL = process.env.BRAIN_BAKE_SOURCE_URL;
  const warehouseJsonPath = join(process.cwd(), 'public', 'warehouse.json');
  const hadWarehouseJson = existsSync(warehouseJsonPath);
  const originalWarehouseJson = hadWarehouseJson ? readFileSync(warehouseJsonPath, 'utf8') : null;

  afterEach(() => {
    if (ORIGINAL_WAREHOUSE_DB === undefined) delete process.env.WAREHOUSE_DB;
    else process.env.WAREHOUSE_DB = ORIGINAL_WAREHOUSE_DB;
    if (ORIGINAL_BAKE_SOURCE_URL === undefined) delete process.env.BRAIN_BAKE_SOURCE_URL;
    else process.env.BRAIN_BAKE_SOURCE_URL = ORIGINAL_BAKE_SOURCE_URL;
    if (hadWarehouseJson) writeFileSync(warehouseJsonPath, originalWarehouseJson!);
    else rmSync(warehouseJsonPath, { force: true });
  });

  it('default (redacted) bake: no dealname-as-address, APN or pipeline subjectId in the written file', async () => {
    const { db, dbPath } = seed();
    db.close();
    process.env.WAREHOUSE_DB = dbPath;
    process.env.BRAIN_BAKE_SOURCE_URL = 'http://127.0.0.1:1';
    const result = await bakeWarehouseJson({ now: NOW });
    expect(result.warehouseSource).toBe('checkpoint-read');
    const raw = readFileSync(result.path, 'utf8');
    const written = JSON.parse(raw) as { endpoints: Record<string, unknown> };
    expect(written.endpoints['/api/warehouse/brain/report']).toBeDefined();
    for (const s of SECRETS) expect(raw, `public/warehouse.json must not contain "${s}"`).not.toContain(s);
  });
});
