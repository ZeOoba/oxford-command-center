// A tab opened before a live rebuild still runs the old JS. Its next lazy module import names a
// hashed chunk the rebuild deleted (rebuild-live.ps1 mirrors dist with robocopy /MIR), the static
// server answers index.html, and the import rejects with "Failed to fetch dynamically imported
// module". Before this fix that left the page on an error panel until a manual hard reload.
// These tests pin the recovery: reload the tab once, never loop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  isStaleChunkError,
  reloadOnceForStaleChunk,
  installStaleChunkReload,
  STALE_CHUNK_RELOAD_KEY,
  STALE_CHUNK_RELOAD_WINDOW_MS,
} from '@/shell/stale-chunk';
import { ErrorBoundary } from '@/shell/ErrorBoundary';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('isStaleChunkError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://x/assets/OverviewModule-abc.js', // Chromium
    'error loading dynamically imported module: http://x/assets/a.js', // Firefox
    'Importing a module script failed.', // Safari
    'Unable to preload CSS for /assets/a.css', // Vite preload helper
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\".",
  ])('recognises %s', (msg) => {
    expect(isStaleChunkError(new TypeError(msg))).toBe(true);
  });

  it.each([
    new Error("Cannot read properties of undefined (reading 'noi')"),
    new Error('Request failed: 500'),
    'Failed to fetch dynamically imported module', // not an Error object
    null,
    undefined,
  ])('ignores ordinary errors (%#)', (err) => {
    expect(isStaleChunkError(err)).toBe(false);
  });
});

describe('reloadOnceForStaleChunk', () => {
  let storage: Storage;
  let reload: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    storage = memoryStorage();
    reload = vi.fn<() => void>();
  });

  it('reloads on the first stale chunk and stamps the time', () => {
    expect(reloadOnceForStaleChunk({ storage, reload, now: () => 1_000_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe('1000000');
  });

  it('does not reload again inside the window (no loop when the chunk is genuinely missing)', () => {
    storage.setItem(STALE_CHUNK_RELOAD_KEY, '1000000');
    const now = () => 1_000_000 + STALE_CHUNK_RELOAD_WINDOW_MS - 1;
    expect(reloadOnceForStaleChunk({ storage, reload, now })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again once the window has passed (a later rebuild)', () => {
    storage.setItem(STALE_CHUNK_RELOAD_KEY, '1000000');
    const now = () => 1_000_000 + STALE_CHUNK_RELOAD_WINDOW_MS + 1;
    expect(reloadOnceForStaleChunk({ storage, reload, now })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when storage is unavailable (cannot prove it is not looping)', () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error('SecurityError');
    };
    expect(reloadOnceForStaleChunk({ storage: broken, reload, now: () => 1 })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('installStaleChunkReload', () => {
  it('reloads and suppresses the error on vite:preloadError', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installStaleChunkReload(target, { storage: memoryStorage(), reload, now: () => 5 });
    const e = Object.assign(new Event('vite:preloadError', { cancelable: true }), {
      payload: new TypeError('Failed to fetch dynamically imported module: /assets/a.js'),
    });
    target.dispatchEvent(e);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('lets the error through when the guard refuses a second reload', () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    storage.setItem(STALE_CHUNK_RELOAD_KEY, '5');
    const reload = vi.fn();
    installStaleChunkReload(target, { storage, reload, now: () => 6 });
    const e = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(e);
    expect(reload).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('ErrorBoundary with a stale chunk', () => {
  function Throws({ error }: { error: Error }): never {
    throw error;
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.sessionStorage.removeItem(STALE_CHUNK_RELOAD_KEY);
  });

  it('shows an updating message and asks for one reload', () => {
    const reload = vi.fn();
    render(
      <ErrorBoundary reloadDeps={{ storage: memoryStorage(), reload, now: () => 1 }}>
        <Throws error={new TypeError('Failed to fetch dynamically imported module: /assets/a.js')} />
      </ErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toMatch(/new version/i);
  });

  it('keeps the ordinary error panel for a render bug', () => {
    const reload = vi.fn();
    render(
      <ErrorBoundary reloadDeps={{ storage: memoryStorage(), reload, now: () => 1 }}>
        <Throws error={new Error('boom')} />
      </ErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong rendering this module/);
  });
});
