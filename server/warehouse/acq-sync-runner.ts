// server/warehouse/acq-sync-runner.ts
//
// One place that decides what an acquisition-pipeline sync run means, shared by the
// POST /acq/sync/{hubspot,notion} routes (server/warehouse/api.ts) and the weekly CLI
// (scripts/acq-sync.ts). It reads the source's token, runs the sync and classifies the outcome:
//   not-configured — token unset; a supported mode (the route answers 400, the CLI skips it)
//   ok             — sync ran; per-row errors are in result.errors
//   failed         — first-page network/auth failure (the route answers 502)
// A failed outcome's message is redacted to "<Vendor> API <status>": the sync modules throw with the
// full upstream response body, which neither an HTTP response nor a scheduled-task log should carry.
import { syncHubSpotPipeline } from './acq-hubspot-sync';
import type { AcqSyncResult, FetchLike } from './acq-hubspot-sync';
import { syncNotionPipeline } from './acq-notion-sync';
import type { WarehouseDb } from './db';

export type AcqSyncSourceId = 'hubspot' | 'notion';

export interface AcqSyncSource {
  id: AcqSyncSourceId;
  name: string;
  tokenVar: string;
  run: (db: WarehouseDb, token: string, opts?: { fetchImpl?: FetchLike }) => Promise<AcqSyncResult>;
}

export const ACQ_SYNC_SOURCES: Readonly<Record<AcqSyncSourceId, AcqSyncSource>> = {
  hubspot: { id: 'hubspot', name: 'HubSpot', tokenVar: 'HUBSPOT_TOKEN', run: syncHubSpotPipeline },
  notion: { id: 'notion', name: 'Notion', tokenVar: 'NOTION_TOKEN', run: syncNotionPipeline },
};

export type AcqSyncOutcome =
  | { source: AcqSyncSource; status: 'not-configured' }
  | { source: AcqSyncSource; status: 'ok'; result: AcqSyncResult }
  | { source: AcqSyncSource; status: 'failed'; error: string };

/** "<Vendor> API <status>" when the sync threw an upstream HTTP failure; otherwise the message, capped. */
export function redactSyncError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const api = /^(\w+ API \d{3})\b/.exec(msg);
  if (api) return api[1]!;
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

export async function runAcqSync(
  db: WarehouseDb,
  id: AcqSyncSourceId,
  opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike },
): Promise<AcqSyncOutcome> {
  const source = ACQ_SYNC_SOURCES[id];
  const token = (opts?.env ?? process.env)[source.tokenVar];
  if (!token) return { source, status: 'not-configured' };
  try {
    const result = await source.run(db, token, opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined);
    return { source, status: 'ok', result };
  } catch (err) {
    return { source, status: 'failed', error: redactSyncError(err) };
  }
}

/**
 * CLI exit code for a set of outcomes: 1 if any configured source failed or had row errors, or if no
 * source was configured at all (nothing ran); 0 otherwise. An unconfigured source alone is not a failure.
 */
export function acqSyncExitCode(outcomes: readonly AcqSyncOutcome[]): 0 | 1 {
  const ran = outcomes.filter((o) => o.status !== 'not-configured');
  if (ran.length === 0) return 1;
  return ran.some((o) => o.status === 'failed' || (o.status === 'ok' && o.result.errors.length > 0)) ? 1 : 0;
}
