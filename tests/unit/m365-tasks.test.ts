import { describe, it, expect } from 'vitest';
import { Task } from '../../src/contracts/index';
import { mapGraphTask, loadM365Tasks, isTaskList } from '../../server/sources/m365-tasks';
import { _resetGraphTokenCache } from '../../server/sources/graph-auth';

describe('m365-tasks — Graph To-Do mapping', () => {
  it('maps an open task to a contract-valid Task', () => {
    const t = mapGraphTask(
      { id: 'AAMk-123', title: 'Renew Eurosort insurance COI', status: 'notStarted', dueDateTime: { dateTime: '2030-12-01T00:00:00Z' }, body: { content: '<p>Get the <b>updated</b> certificate</p>' } },
      'Acquisitions',
    );
    expect(t).not.toBeNull();
    expect(() => Task.parse(t)).not.toThrow();
    expect(t!.id).toMatch(/^m365-[0-9a-f]{32}$/);
    expect(t!.section).toBe('Microsoft 365 · Acquisitions');
    expect(t!.type).toBe('M365 To-Do');
    expect(t!.dueDay).toBe('2030-12-01');
    expect(t!.status).toBe('pending'); // future due date
    expect(t!.notes).toBe('Get the updated certificate'); // HTML stripped
  });

  // 2026-09-30 audit: Graph To-Do ids share a long common prefix and differ only past character 60.
  // slugId truncated to 60, so all 56 live M365 rows landed on ONE Task.id. The id must be derived
  // from the WHOLE source id.
  it('gives distinct ids to Graph ids that share a 60+ character prefix', () => {
    const prefix = 'AAMkAGVlM2FhYTA0LWI4MDItNDYwNi1hNzczLWQ1ZWQ5ZDE5NjgzYgBGAAAA';
    expect(prefix.length).toBeGreaterThanOrEqual(60);
    const a = mapGraphTask({ id: `${prefix}AAA1`, title: 'Task A' }, 'To Do');
    const b = mapGraphTask({ id: `${prefix}AAA2`, title: 'Task B' }, 'To Do');
    expect(a!.id).not.toBe(b!.id);
  });

  it('gives the same id to the same Graph id on every call (stable across snapshot refreshes)', () => {
    const one = mapGraphTask({ id: 'AAMk-stable', title: 'First title' }, 'To Do');
    const two = mapGraphTask({ id: 'AAMk-stable', title: 'Renamed title' }, 'Other list');
    expect(one!.id).toBe(two!.id);
  });

  it('keeps ids distinct for two id-less tasks with different titles', () => {
    const a = mapGraphTask({ title: 'Call the lender' }, 'To Do');
    const b = mapGraphTask({ title: 'Call the broker' }, 'To Do');
    expect(a!.id).not.toBe(b!.id);
  });

  it('flags a past-due open task as overdue', () => {
    const t = mapGraphTask({ id: 'x', title: 'Old task', status: 'notStarted', dueDateTime: { dateTime: '2000-01-01T00:00:00Z' } }, 'To Do');
    expect(t!.status).toBe('overdue');
  });

  it('maps completed tasks to done and drops empty titles', () => {
    expect(mapGraphTask({ id: 'a', title: 'Done thing', status: 'completed' }, 'To Do')!.status).toBe('done');
    expect(mapGraphTask({ id: 'b', title: '   ' }, 'To Do')).toBeNull();
  });

  it('returns [] (graceful) when Graph is unconfigured', async () => {
    const keys = ['GRAPH_TOKEN', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    keys.forEach((k) => delete process.env[k]);
    _resetGraphTokenCache();
    try {
      expect((await loadM365Tasks()).tasks).toEqual([]);
    } finally {
      for (const k of keys) if (prev[k] !== undefined) process.env[k] = prev[k];
    }
  });

  it('skips Outlook’s Flagged Emails list (marketing blasts surfaced as tasks)', () => {
    expect(isTaskList({ wellknownListName: 'flaggedEmails' })).toBe(false);
    expect(isTaskList({ wellknownListName: 'defaultList' })).toBe(true);
    expect(isTaskList({})).toBe(true);
  });
});

describe('mapGraphTask — notes redaction (#511 follow-up)', () => {
  it('redacts third-party contact data in the task body before it reaches the snapshot', () => {
    const t = mapGraphTask(
      { id: 'pii-1', title: 'Roof quote', body: { content: '<p>Send COI to jane.roe@example.com or call 555-010-0123</p>' } },
      'To Do',
    );
    expect(t!.notes).not.toMatch(/jane\.roe@example\.com|555-010-0123/);
    expect(t!.notes).toContain('[email redacted]');
    expect(t!.notes).toContain('[phone redacted]');
  });
});
