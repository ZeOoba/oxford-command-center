// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../../server/startup';

describe('startServer', () => {
  it('runs no heavy startup work until the port has bound, then defers it one macrotask', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let onListening: ((port: number) => void) | null = null;
    startServer({
      listen: (cb) => { calls.push('listen'); onListening = cb; },
      refresh: async () => { calls.push('refresh'); },
      warmDocs: async () => { calls.push('warmDocs'); },
      log: () => {},
      warn: () => {},
    });
    expect(calls).toEqual(['listen']);          // nothing heavy before bind
    onListening!(8911);
    expect(calls).toEqual(['listen']);          // not in the bind callback's own tick
    await vi.runAllTimersAsync();
    expect(calls).toEqual(['listen', 'refresh', 'warmDocs']);
    vi.useRealTimers();
  });
});
