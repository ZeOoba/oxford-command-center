// tests/support/fetch-timeout.ts
//
// Helpers that prove a fetch is BOUNDED, not merely that it was handed some AbortSignal. Node's
// AbortSignal.timeout runs on an internal timer that vitest fake timers do not control, so the helper
// replaces it with a fake-timer-driven equivalent (records every requested bound) and pairs it with a
// fetch stub that never settles unless its signal aborts. If a source drops the bound, the stub hangs,
// `settlesWithin` reports false, and the test fails immediately instead of waiting on a real timeout.
import { vi } from 'vitest';

/** Install fake timers and a fake-timer-driven AbortSignal.timeout. Returns the spy (call args = bounds). */
export function installFakeTimeoutClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
}

/** A fetch response that only ever settles by rejecting when `init.signal` aborts; with no signal it hangs. */
export function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // unbounded call: never settles
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** Advance the fake clock by `ms` and report whether `p` settled (resolved or rejected) by then. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}
