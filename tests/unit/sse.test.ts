import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectBrainSSE } from '../../src/data/sse';

class MockES {
  static instances: MockES[] = [];
  url: string;
  closed = false;
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  constructor(url: string) { this.url = url; MockES.instances.push(this); }
  addEventListener(t: string, fn: (e: unknown) => void) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t: string, fn: (e: unknown) => void) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  close() { this.closed = true; }
  emit(t: string, e: unknown = {}) { (this.listeners[t] ?? []).forEach((fn) => fn(e)); }
}

afterEach(() => { vi.unstubAllGlobals(); MockES.instances = []; });

describe('connectBrainSSE bounded reconnect', () => {
  it('closes the stream after 3 consecutive errors with no successful event', () => {
    vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
    connectBrainSSE({});
    const es = MockES.instances.at(-1)!;
    es.emit('error'); es.emit('error');
    expect(es.closed).toBe(false);
    es.emit('error'); // 3rd
    expect(es.closed).toBe(true);
  });

  it('an open event resets the error streak (reconnect path)', () => {
    vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
    connectBrainSSE({});
    const es = MockES.instances.at(-1)!;
    es.emit('error'); es.emit('error');
    es.emit('open'); // reconnected → reset
    es.emit('error'); es.emit('error');
    expect(es.closed).toBe(false); // only 2 since reset
  });

  it('a delivered event resets the error streak', () => {
    vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
    connectBrainSSE({ onSnapshot: () => {} });
    const es = MockES.instances.at(-1)!;
    es.emit('error'); es.emit('error');
    es.emit('snapshot'); // healthy → reset
    es.emit('error'); es.emit('error');
    expect(es.closed).toBe(false); // only 2 since reset
  });
});
