export interface StartupDeps {
  listen: (onListening: (port: number) => void) => void;
  refresh: () => Promise<void>;
  warmDocs: () => Promise<void>;
  log: (msg: string) => void;
  warn: (msg: string, err: unknown) => void;
}

/**
 * Bind first, then do heavy work one macrotask later. loadDiskIndex() is a synchronous better-sqlite3
 * + sqlite-vec read of a ~179 MB file; called in the same tick as serve() it held listen() for ~7 min
 * on a cold, AV-scanned start (2026-09-23 review), defeating the old "bind first" comment.
 */
export function startServer(d: StartupDeps): void {
  d.listen((port) => {
    d.log(`◆ Oxford Brain Server — http://127.0.0.1:${port} (localhost only)`);
    setTimeout(() => {
      d.refresh().catch((err) => d.warn('⚠ Brain startup refresh failed — serving in degraded mode (snapshot 503 until workbook loads):', err));
      d.warmDocs().catch((err) => d.warn('⚠ Document index warm-up failed (non-fatal):', err));
    }, 0);
  });
}
