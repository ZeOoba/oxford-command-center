// @vitest-environment node
// Tier 4 (2026-11-23 review): three write routes in server/index.ts cast the request body
// (`as { ... }`) instead of validating it, so a non-string type/dueDay/notes reached the overlay,
// which is not re-parsed through Zod on read. Also pins the root JSON error/404 wiring.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DealStageBody, TaskBody, TenantNoteBody } from '../../server/action-bodies';
import { jsonErrorHandler, jsonNotFound } from '../../server/warehouse/json-errors';

describe('action body schemas', () => {
  it('deal-stage requires a non-empty dealId and a known stage', () => {
    expect(DealStageBody.safeParse({ dealId: 'd1', stage: 'Candidate' }).success).toBe(true);
    expect(DealStageBody.safeParse({ dealId: '  ', stage: 'Candidate' }).success).toBe(false);
    expect(DealStageBody.safeParse({ dealId: 'd1', stage: 'Nope' }).success).toBe(false);
    expect(DealStageBody.safeParse({ dealId: 42, stage: 'Candidate' }).success).toBe(false);
  });

  it('task requires a label and rejects non-string optional fields that used to reach the overlay', () => {
    expect(TaskBody.parse({ label: ' Call lender ' }).label).toBe('Call lender');
    expect(TaskBody.safeParse({ label: '' }).success).toBe(false);
    expect(TaskBody.safeParse({ label: 'x', type: { evil: true } }).success).toBe(false);
    expect(TaskBody.safeParse({ label: 'x', dueDay: 15 }).success).toBe(false);
    expect(TaskBody.safeParse({ label: 'x', notes: ['a'] }).success).toBe(false);
    expect(TaskBody.safeParse({ label: 'x', section: 'S', type: 'Manual', dueDay: '15', notes: 'n' }).success).toBe(true);
    expect(TaskBody.safeParse({ label: 'x', dueDay: null, notes: null }).success).toBe(true);
    // null section/type fall back to the route defaults, as before (refute wf_92c09816-8c3).
    expect(TaskBody.safeParse({ label: 'x', section: null, type: null }).success).toBe(true);
  });

  it('tenant-note requires a tenantId; a missing note is an empty note, a non-string note is rejected', () => {
    expect(TenantNoteBody.parse({ tenantId: 't1' })).toEqual({ tenantId: 't1', note: '' });
    expect(TenantNoteBody.parse({ tenantId: 't1', note: null })).toEqual({ tenantId: 't1', note: '' });
    expect(TenantNoteBody.safeParse({ tenantId: '' }).success).toBe(false);
    expect(TenantNoteBody.safeParse({ tenantId: 't1', note: { x: 1 } }).success).toBe(false);
  });
});

describe('root JSON error + 404 handlers', () => {
  it('an uncaught error is a generic JSON 500 and the message stays server-side', async () => {
    const app = new Hono();
    app.onError(jsonErrorHandler('server'));
    app.get('/boom', () => {
      throw new Error('SQLITE_CONSTRAINT: secret_table');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(spy.mock.calls[0]?.[0]).toMatch(/^\[server\] route error: GET "\/boom"/);
    spy.mockRestore();
  });

  it('an unknown route is a JSON 404', async () => {
    const app = new Hono();
    app.notFound(jsonNotFound);
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('server/index.ts wires both on the root app', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(src).toMatch(/app\.onError\(jsonErrorHandler\('server'\)\)/);
    expect(src).toMatch(/app\.notFound\(jsonNotFound\)/);
    // The three formerly cast bodies are parsed with safeParse (visible to check:schema-drift), not cast.
    expect(src).toMatch(/DealStageBody\.safeParse\(/);
    expect(src).toMatch(/TaskBody\.safeParse\(/);
    expect(src).toMatch(/TenantNoteBody\.safeParse\(/);
    expect(src).not.toMatch(/as \{ dealId\?: string; stage\?: string \}/);
    expect(src).not.toMatch(/as \{ tenantId\?: string; note\?: string \}/);
    expect(src).not.toMatch(/label\?: string; section\?: string; type\?: string/);
  });
});
