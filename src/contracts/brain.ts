/**
 * Live-brain runtime state — shared by the server and the client.
 * `static` is set by the client when it falls back to a baked snapshot (the deployed
 * mirror has no server). It is NEVER emitted by the live Brain Server.
 */
export type BrainStatus = 'idle' | 'refreshing' | 'fresh' | 'error' | 'static';
export type BrainSource = 'workbook' | 'snapshot-fallback' | 'none';

/** Render-time freshness, derived from BrainState (see src/lib/freshness.ts). */
export type FreshnessKind = 'live' | 'static' | 'stale' | 'refreshing' | 'offline' | 'connecting';

export interface BrainState {
  status: BrainStatus;
  source: BrainSource;
  lastUpdated: string | null;
  lastError: string | null;
  workbookPath: string;
  flagCount: number;
}
