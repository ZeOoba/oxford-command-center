import { describe, it, expect } from 'vitest';
import { Task } from '../../src/contracts/index';
import { mapGraphTask, loadM365Tasks } from '../../server/sources/m365-tasks';

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

  it('returns [] (graceful) when GRAPH_TOKEN is unset', async () => {
    const prev = process.env.GRAPH_TOKEN;
    delete process.env.GRAPH_TOKEN;
    try {
      expect(await loadM365Tasks()).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.GRAPH_TOKEN = prev;
    }
  });
});
