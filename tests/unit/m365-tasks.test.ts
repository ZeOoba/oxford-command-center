import { describe, it, expect } from 'vitest';
import { Task } from '../../src/contracts/index';
import { mapGraphTask, loadM365Tasks } from '../../server/sources/m365-tasks';
import { _resetGraphTokenCache } from '../../server/sources/graph-auth';

describe('m365-tasks — Graph To-Do mapping', () => {
  it('maps an open task to a contract-valid Task', () => {
    const t = mapGraphTask(
      { id: 'AAMk-123', title: 'Renew REDACTED-659 insurance COI', status: 'notStarted', dueDateTime: { dateTime: '2030-12-01T00:00:00Z' }, body: { content: '<p>Get the <b>updated</b> certificate</p>' } },
      'Acquisitions',
    );
    expect(t).not.toBeNull();
    expect(() => Task.parse(t)).not.toThrow();
    expect(t!.id).toBe('m365-aamk-123');
    expect(t!.section).toBe('Microsoft 365 · Acquisitions');
    expect(t!.type).toBe('M365 To-Do');
    expect(t!.dueDay).toBe('2030-12-01');
    expect(t!.status).toBe('pending'); // future due date
    expect(t!.notes).toBe('Get the updated certificate'); // HTML stripped
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
      expect(await loadM365Tasks()).toEqual([]);
    } finally {
      for (const k of keys) if (prev[k] !== undefined) process.env[k] = prev[k];
    }
  });
});
