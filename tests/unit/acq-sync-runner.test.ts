// @vitest-environment node
//
// tests/unit/acq-sync-runner.test.ts
//
// acq-sync-runner.ts — the run/classify step shared by POST /acq/sync/{hubspot,notion} and
// scripts/acq-sync.ts. Pins: outcome classification, upstream-body redaction, the CLI exit-code
// contract (an unconfigured source alone is not a failure), and that the routes keep their
// 400 / 200 / 502 answers. Tmpdir SQLite + mocked fetch — never touches finance.sqlite or the network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import type { FetchLike } from '../../server/warehouse/acq-hubspot-sync';
import {
  ACQ_SYNC_SOURCES,
  acqSyncExitCode,
  redactSyncError,
  runAcqSync,
} from '../../server/warehouse/acq-sync-runner';
import type { AcqSyncOutcome } from '../../server/warehouse/acq-sync-runner';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-sync-runner-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

const SECRET_BODY = '{"status":"error","message":"Authentication credentials not found","correlationId":"abc-123"}';
const unauthorized: FetchLike = async () => new Response(SECRET_BODY, { status: 401 });
const emptyHubSpot: FetchLike = async () =>
  new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

const hub = ACQ_SYNC_SOURCES.hubspot;
const notion = ACQ_SYNC_SOURCES.notion;
const ok = (errors: string[] = []): AcqSyncOutcome => ({ source: hub, status: 'ok', result: { inserted: 1, updated: 0, errors } });
const skipped = (source = notion): AcqSyncOutcome => ({ source, status: 'not-configured' });
const failed: AcqSyncOutcome = { source: hub, status: 'failed', error: 'HubSpot API 401' };

describe('redactSyncError', () => {
  it('keeps only "<Vendor> API <status>" from an upstream HTTP failure', () => {
    expect(redactSyncError(new Error(`HubSpot API 401: ${SECRET_BODY}`))).toBe('HubSpot API 401');
    expect(redactSyncError(new Error('Notion API 429: rate limited'))).toBe('Notion API 429');
  });

  it('passes other messages through, capped at 200 chars', () => {
    expect(redactSyncError(new Error('fetch failed'))).toBe('fetch failed');
    expect(redactSyncError('x'.repeat(500))).toHaveLength(201);
  });
});

describe('runAcqSync', () => {
  it('is not-configured when the token is unset or empty, without calling the source', async () => {
    const fetchImpl = vi.fn(emptyHubSpot);
    const db = freshDb();
    expect((await runAcqSync(db, 'hubspot', { env: {}, fetchImpl })).status).toBe('not-configured');
    expect((await runAcqSync(db, 'hubspot', { env: { HUBSPOT_TOKEN: '' }, fetchImpl })).status).toBe('not-configured');
    expect(fetchImpl).not.toHaveBeenCalled();
    db.close();
  });

  it('is failed with a redacted message on a first-page auth failure', async () => {
    const db = freshDb();
    const o = await runAcqSync(db, 'hubspot', { env: { HUBSPOT_TOKEN: 't' }, fetchImpl: unauthorized });
    expect(o).toMatchObject({ status: 'failed', error: 'HubSpot API 401' });
    expect(JSON.stringify(o)).not.toContain('correlationId');
    db.close();
  });

  it('is ok with the sync result when the source answers', async () => {
    const db = freshDb();
    const o = await runAcqSync(db, 'hubspot', { env: { HUBSPOT_TOKEN: 't' }, fetchImpl: emptyHubSpot });
    expect(o).toMatchObject({ status: 'ok', result: { inserted: 0, updated: 0, errors: [] } });
    db.close();
  });
});

describe('acqSyncExitCode', () => {
  it('is 0 when every configured source succeeded, even with another source unconfigured', () => {
    expect(acqSyncExitCode([ok(), ok()])).toBe(0);
    expect(acqSyncExitCode([ok(), skipped()])).toBe(0);
  });

  it('is 1 when a configured source failed or had row errors', () => {
    expect(acqSyncExitCode([failed, ok()])).toBe(1);
    expect(acqSyncExitCode([ok(['deal 1: could not be processed']), skipped()])).toBe(1);
  });

  it('is 1 when no source ran', () => {
    expect(acqSyncExitCode([skipped(hub), skipped(notion)])).toBe(1);
    expect(acqSyncExitCode([])).toBe(1);
  });
});

describe('POST /acq/sync/* keep their answers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('400 with "<TOKEN> not configured" when the token is unset', async () => {
    vi.stubEnv('HUBSPOT_TOKEN', '');
    vi.stubEnv('NOTION_TOKEN', '');
    const db = freshDb();
    const app = warehouseRoutes(() => db);
    for (const [path, tokenVar] of [['hubspot', 'HUBSPOT_TOKEN'], ['notion', 'NOTION_TOKEN']] as const) {
      const res = await app.request(`/acq/sync/${path}`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `${tokenVar} not configured` });
    }
    db.close();
  });

  it('502 "<source> sync failed" on an upstream failure, with no upstream body in the response', async () => {
    vi.stubEnv('HUBSPOT_TOKEN', 't');
    vi.stubEnv('NOTION_TOKEN', 't');
    vi.stubGlobal('fetch', unauthorized);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = freshDb();
    const app = warehouseRoutes(() => db);
    for (const path of ['hubspot', 'notion'] as const) {
      const res = await app.request(`/acq/sync/${path}`, { method: 'POST' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: `${path} sync failed` });
    }
    expect(err.mock.calls.flat().join(' ')).not.toContain('correlationId');
    err.mockRestore();
    db.close();
  });
});
