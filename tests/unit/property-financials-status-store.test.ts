// @vitest-environment node
//
// tests/unit/property-financials-status-store.test.ts — per-insight workflow store (plan T4).
// Every test writes to its own tmpdir path; the repo's data/ is never touched.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  insightFingerprint,
  InsightStatusInput,
  putInsightStatus,
  readInsightStatuses,
  StatusStoreCorruptError,
  withVersion,
} from '../../server/property-financials/status-store';

const KNOWN = new Set(['REV-01', 'EXP-02', 'REC-01']);
const NOW = new Date('2026-10-05T16:00:00.000Z');
const storePath = () => join(mkdtempSync(join(tmpdir(), 'pf-status-')), 'nested', 'status.json');

describe('InsightStatusInput (strict Zod)', () => {
  it('accepts a minimal open record', () => {
    expect(InsightStatusInput.safeParse({ owner: 'Gabriel', dueDate: '2026-10-31', status: 'open' }).success).toBe(true);
    expect(InsightStatusInput.safeParse({ owner: null, dueDate: null, status: 'in_progress', dismissReason: null }).success).toBe(true);
  });

  it('rejects unknown keys, bad status, and impossible / malformed dates', () => {
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'open', extra: 1 }).success).toBe(false);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'closed' }).success).toBe(false);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: '2026-02-30', status: 'open' }).success).toBe(false);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: '10/31/2026', status: 'open' }).success).toBe(false);
  });

  it('dismissReason is required iff status is dismissed', () => {
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'dismissed' }).success).toBe(false);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'dismissed', dismissReason: '   ' }).success).toBe(false);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'dismissed', dismissReason: 'one-time item' }).success).toBe(true);
    expect(InsightStatusInput.safeParse({ owner: 'G', dueDate: null, status: 'open', dismissReason: 'why' }).success).toBe(false);
  });
});

describe('putInsightStatus / readInsightStatuses', () => {
  it('a missing store reads as empty', () => {
    expect(readInsightStatuses(storePath())).toEqual({});
  });

  it('writes a record (creating the directory) and reads it back with updatedAt', () => {
    const p = storePath();
    const r = putInsightStatus(p, 'REV-01', { owner: ' Gabriel ', dueDate: '2026-10-31', status: 'in_progress' }, KNOWN, NOW);
    expect(r).toEqual({
      ok: true,
      record: { insightId: 'REV-01', owner: 'Gabriel', dueDate: '2026-10-31', status: 'in_progress', dismissReason: null, updatedAt: NOW.toISOString() },
    });
    expect(readInsightStatuses(p)).toEqual({ 'REV-01': r.ok ? r.record : null });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('unknown insight id → not_found, nothing written', () => {
    const p = storePath();
    expect(putInsightStatus(p, 'ZZZ-99', { owner: null, dueDate: null, status: 'open' }, KNOWN, NOW)).toEqual({ ok: false, reason: 'not_found' });
    expect(existsSync(p)).toBe(false);
  });

  it('dismissed without a reason → invalid with Zod path+code issues, nothing written', () => {
    const p = storePath();
    const r = putInsightStatus(p, 'REV-01', { owner: null, dueDate: null, status: 'dismissed' }, KNOWN, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'invalid') expect(r.issues.join(' ')).toContain('dismissReason');
    else throw new Error('expected invalid');
    expect(existsSync(p)).toBe(false);
  });

  it('a later put replaces the record; other records are kept', () => {
    const p = storePath();
    putInsightStatus(p, 'REV-01', { owner: 'A', dueDate: null, status: 'open' }, KNOWN, NOW);
    putInsightStatus(p, 'EXP-02', { owner: 'B', dueDate: null, status: 'open' }, KNOWN, NOW);
    putInsightStatus(p, 'REV-01', { owner: 'A', dueDate: null, status: 'dismissed', dismissReason: 'one-time' }, KNOWN, NOW);
    const all = readInsightStatuses(p);
    expect(Object.keys(all).sort()).toEqual(['EXP-02', 'REV-01']);
    expect(all['REV-01']).toMatchObject({ status: 'dismissed', dismissReason: 'one-time' });
  });

  it('a corrupt store fails loud and is never overwritten', () => {
    const p = storePath();
    putInsightStatus(p, 'REV-01', { owner: 'A', dueDate: null, status: 'open' }, KNOWN, NOW);
    writeFileSync(p, '{ not json');
    expect(() => readInsightStatuses(p)).toThrow(StatusStoreCorruptError);
    expect(() => putInsightStatus(p, 'EXP-02', { owner: 'B', dueDate: null, status: 'open' }, KNOWN, NOW)).toThrow(StatusStoreCorruptError);
    expect(readFileSync(p, 'utf8')).toBe('{ not json');
  });

  it('a schema-invalid store (e.g. a bad status value) is treated as corrupt', () => {
    const p = storePath();
    putInsightStatus(p, 'REV-01', { owner: 'A', dueDate: null, status: 'open' }, KNOWN, NOW);
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { records: Record<string, { status: string }> };
    raw.records['REV-01']!.status = 'bogus';
    writeFileSync(p, JSON.stringify(raw));
    expect(() => readInsightStatuses(p)).toThrow(StatusStoreCorruptError);
  });

  it('concurrent writes (many in flight) leave a valid file with every record and no temp files', async () => {
    const p = storePath();
    const ids = [...KNOWN];
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        Promise.resolve().then(() =>
          putInsightStatus(p, ids[i % ids.length]!, { owner: `owner-${i}`, dueDate: null, status: 'open' }, KNOWN, NOW),
        ),
      ),
    );
    const all = readInsightStatuses(p);
    expect(Object.keys(all).sort()).toEqual([...ids].sort());
    expect(readdirSync(dirname(p))).toEqual(['status.json']);
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  it('never writes into the dataset directory (store module has no dataset path)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'server', 'property-financials', 'status-store.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/dataset\.json|monthly-long\.csv|propertyFinancialsDir/);
  });
});

describe('L4: records remember which version of the insight they were set against', () => {
  const ins = { finding: 'TTM26 is +21.0% against TTM25.', annual_impact_usd: REDACTED-AMT, impact_basis: '8% savings [SPECULATIVE]' };

  it('insightFingerprint is a sha256 of the finding + impact text; changes when either is restated', () => {
    const h = insightFingerprint(ins);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(insightFingerprint({ ...ins })).toBe(h);
    expect(insightFingerprint({ ...ins, finding: 'TTM26 is -1.8% against TTM25.' })).not.toBe(h);
    expect(insightFingerprint({ ...ins, annual_impact_usd: 13268 })).not.toBe(h);
    expect(insightFingerprint({ ...ins, impact_basis: null })).not.toBe(h);
  });

  it('a put stores the hash; withVersion reads current / earlier / unknown', () => {
    const path = storePath();
    const h = insightFingerprint(ins);
    const r = putInsightStatus(path, 'REV-01', { owner: 'G', dueDate: null, status: 'resolved' }, KNOWN, NOW, h);
    expect(r.ok && r.record.insightHash).toBe(h);
    const stored = readInsightStatuses(path)['REV-01']!;
    expect(withVersion(stored, h).version).toBe('current');
    expect(withVersion(stored, insightFingerprint({ ...ins, finding: 'restated' })).version).toBe('earlier');
    // the record is kept as it was: status, owner and hash untouched by the read
    expect(withVersion(stored, 'f'.repeat(64))).toMatchObject({ status: 'resolved', owner: 'G', insightHash: h, version: 'earlier' });
  });

  it('backward compatible: a store written before hashes existed reads fine and its records are "unknown"', () => {
    const path = storePath();
    putInsightStatus(path, 'REV-01', { owner: null, dueDate: null, status: 'open' }, KNOWN, NOW);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, Record<string, unknown>> };
    expect(raw.records['REV-01']).not.toHaveProperty('insightHash');
    const rec = readInsightStatuses(path)['REV-01']!;
    expect(withVersion(rec, insightFingerprint(ins)).version).toBe('unknown');
  });

  it('the PUT body stays strict: a client cannot send its own insightHash', () => {
    expect(InsightStatusInput.safeParse({ owner: null, dueDate: null, status: 'open', insightHash: 'a'.repeat(64) }).success).toBe(false);
  });

  it('a malformed stored hash makes the store corrupt (fails loud, never overwritten)', () => {
    const path = storePath();
    putInsightStatus(path, 'REV-01', { owner: null, dueDate: null, status: 'open' }, KNOWN, NOW, 'a'.repeat(64));
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, Record<string, unknown>> };
    raw.records['REV-01']!.insightHash = 'not-a-hash';
    writeFileSync(path, JSON.stringify(raw));
    expect(() => readInsightStatuses(path)).toThrow(StatusStoreCorruptError);
  });
});
