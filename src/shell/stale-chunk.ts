// Stale-chunk recovery after a rebuild.
//
// Every module is a lazy, content-hashed chunk. A tab opened before a rebuild keeps running the
// old entry JS, so the first time it opens a module it has not loaded yet, it asks for a chunk
// name the rebuild deleted (the live deploy mirrors dist, dropping old hashes). The static server
// answers index.html, the import rejects, and the module shows an error until a manual hard
// reload. A reload picks up the new index.html and its current chunk names, so do that once.
//
// The guard stamps the reload time in sessionStorage and refuses a second reload inside the
// window. A chunk that is still missing after a fresh load (a broken deploy, not a stale tab)
// therefore falls through to the normal error panel instead of reload-looping.

export const STALE_CHUNK_RELOAD_KEY = 'ora:stale-chunk-reload-at';
export const STALE_CHUNK_RELOAD_WINDOW_MS = 30_000;

const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's preload helper
  /Failed to load module script/i, // index.html served with a text/html MIME type
];

export function isStaleChunkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return STALE_CHUNK_PATTERNS.some((re) => re.test(err.message));
}

export interface StaleChunkReloadDeps {
  storage: Storage;
  reload: () => void;
  now: () => number;
}

function defaultDeps(): StaleChunkReloadDeps {
  return {
    storage: window.sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}

/** Reloads the tab unless it already reloaded for a stale chunk within the window. Returns whether it reloaded. */
export function reloadOnceForStaleChunk(deps: StaleChunkReloadDeps = defaultDeps()): boolean {
  try {
    const last = Number(deps.storage.getItem(STALE_CHUNK_RELOAD_KEY) ?? NaN);
    const now = deps.now();
    if (Number.isFinite(last) && now - last < STALE_CHUNK_RELOAD_WINDOW_MS) return false;
    deps.storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch {
    // Without storage the guard cannot tell a first reload from a loop; show the error instead.
    return false;
  }
  deps.reload();
  return true;
}

/**
 * Vite's preload helper dispatches a cancelable `vite:preloadError` on the window when a wrapped
 * dynamic import fails; preventing it stops the rejection. Covers lazy imports outside the
 * shell's ErrorBoundary (tab panels, drawers).
 */
export function installStaleChunkReload(target: EventTarget = window, deps?: StaleChunkReloadDeps): void {
  target.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForStaleChunk(deps)) event.preventDefault();
  });
}
