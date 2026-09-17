import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { appendAudit, auditTrail } from '../../server/warehouse/audit';
import { withAgentRun, recordUsage } from '../../server/warehouse/agent-runs';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('appendAudit / auditTrail', () => {
  it('records an entry and returns its sequence number', () => {
    const db = makeDb();
    const seq = appendAudit(db, {
      at: '2026-09-17T12:00:00Z',
      actor: 'gabriel',
      action: 'verify',
      entity: 'lease_facts',
      entityId: 'f1',
      before: { status: 'extracted' },
      after: { status: 'verified' },
    });
    expect(seq).toBe(1);
    const trail = auditTrail(db, 'lease_facts', 'f1');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.after).toEqual({ status: 'verified' });
  });

  it('keeps entries in insertion order for one entity', () => {
    const db = makeDb();
    for (const action of ['extract', 'dispute', 'verify']) {
      appendAudit(db, {
        at: '2026-09-17T12:00:00Z',
        actor: 'pipeline',
        action,
        entity: 'lease_facts',
        entityId: 'f1',
      });
    }
    expect(auditTrail(db, 'lease_facts', 'f1').map((e) => e.action)).toEqual([
      'extract',
      'dispute',
      'verify',
    ]);
  });
});

describe('withAgentRun', () => {
  it('marks a successful run ok and records usage', async () => {
    const db = makeDb();
    const out = await withAgentRun(
      db,
      { pipeline: 'lease-extract', model: 'claude-sonnet-5' },
      async (runId) => {
        recordUsage(db, runId, { tokensIn: 1000, tokensOut: 200, costUsd: 0.004 });
        return 'done';
      },
    );
    expect(out).toBe('done');
    const row = db.prepare('SELECT status, tokens_in, cost_usd, ended_at FROM agent_runs').get() as {
      status: string;
      tokens_in: number;
      cost_usd: number;
      ended_at: string;
    };
    expect(row.status).toBe('ok');
    expect(row.tokens_in).toBe(1000);
    expect(row.ended_at).toBeTruthy();
  });

  it('marks a failed run error, stores the message, and rethrows', async () => {
    const db = makeDb();
    await expect(
      withAgentRun(db, { pipeline: 'lease-extract' }, async () => {
        throw new Error('model refused');
      }),
    ).rejects.toThrow('model refused');
    const row = db.prepare('SELECT status, error FROM agent_runs').get() as {
      status: string;
      error: string;
    };
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/model refused/);
  });
});
