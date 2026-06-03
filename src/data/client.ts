import { PortfolioSnapshot, type BrainState } from '@contracts/index';

export interface SnapshotResponse {
  snapshot: PortfolioSnapshot;
  state: BrainState;
}

/**
 * Fetch the live snapshot and re-validate at the client boundary (defense in depth).
 * Falls back to a baked static snapshot (/snapshot.json) so the deployed read-only
 * Cloudflare mirror works without the local Brain Server.
 */
export async function fetchSnapshot(): Promise<SnapshotResponse> {
  try {
    const res = await fetch('/api/snapshot');
    if (res.ok) {
      const json = (await res.json()) as { snapshot: unknown; state: BrainState };
      return { snapshot: PortfolioSnapshot.parse(json.snapshot), state: json.state };
    }
  } catch {
    /* server offline — try the static mirror */
  }
  const res = await fetch('/snapshot.json');
  if (!res.ok) throw new Error('No snapshot available (Brain Server offline and no baked mirror).');
  const snapshot = PortfolioSnapshot.parse(await res.json());
  return {
    snapshot,
    state: {
      status: 'fresh',
      source: 'snapshot-fallback',
      lastUpdated: snapshot.meta.generatedAt,
      lastError: null,
      workbookPath: '(static mirror)',
      flagCount: snapshot.dataQuality.length,
    },
  };
}

export async function refreshSnapshot(): Promise<BrainState> {
  const res = await fetch('/api/refresh', { method: 'POST' });
  if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
  const json = (await res.json()) as { state: BrainState };
  return json.state;
}
