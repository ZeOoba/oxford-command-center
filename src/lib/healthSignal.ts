// src/lib/healthSignal.ts
//
// One-glance system-health signal for the TopBar dot (IA decongestion Phase 4a). Pure — derived
// from data the System Health module ALREADY reads (freshness + snapshot data-quality flags), using
// the same severity semantics as HealthModule: stale/offline data or an error-severity flag is an
// error; warn flags are a warning; a connecting feed is neutral.
//
// Feed fold-in (2026-09-23 review, gap #2): the `/api/health` `feeds[]` (fresh/stale/missing per
// feed) used to surface ONLY on the System Health module, which left the nav rail in IA
// decongestion Phase 4a — so a silently-stale feed never reached the always-visible dot. `feeds` is
// now a third input, shared with HealthModule via the `useHealth()` query (src/data/health.ts) so
// there is one poll, not two uncoordinated ones. A stale/missing feed floors the tone at 'warn' but
// NEVER downgrades an existing 'error' from freshness or a data-quality error flag.
import type { DataQualityFlag } from '@contracts/index';
import type { Freshness } from './freshness';
import type { FeedHealth } from './feed-health';

export type HealthTone = 'ok' | 'warn' | 'error' | 'neutral';

export interface HealthSignal {
  tone: HealthTone;
  /** Short state word for the accessible name / tooltip. */
  label: string;
  /** One-line reason. */
  detail: string;
}

export function computeHealthSignal(
  freshness: Freshness,
  flags: readonly Pick<DataQualityFlag, 'severity'>[],
  feeds: readonly Pick<FeedHealth, 'status'>[] = [],
): HealthSignal {
  const errors = flags.filter((f) => f.severity === 'error').length;
  const warns = flags.filter((f) => f.severity === 'warn').length;
  // "missing" reads as stale for the dot — a feed that never ran and one that's merely overdue
  // both mean the same thing at a glance: something needs a look.
  const staleFeeds = feeds.filter((f) => f.status === 'stale' || f.status === 'missing').length;

  if (freshness.kind === 'offline' || freshness.kind === 'stale') {
    return { tone: 'error', label: 'Attention needed', detail: `Data ${freshness.label.toLowerCase()}${freshness.detail ? ` (${freshness.detail})` : ''}` };
  }
  if (errors > 0) {
    return { tone: 'error', label: 'Attention needed', detail: `${errors} data-quality error${errors === 1 ? '' : 's'}` };
  }
  if (warns > 0 || staleFeeds > 0) {
    // Both reasons can coexist (a data-quality warning and a stale feed are independent signals) —
    // keep both in the detail rather than letting one silently win, joined in the same order the
    // checks run: data-quality first, feed reason second.
    const parts: string[] = [];
    if (warns > 0) parts.push(`${warns} data-quality warning${warns === 1 ? '' : 's'}`);
    if (staleFeeds > 0) parts.push(`${staleFeeds} feed${staleFeeds === 1 ? '' : 's'} stale`);
    return { tone: 'warn', label: 'Warnings', detail: parts.join(' · ') };
  }
  if (freshness.kind === 'connecting') {
    return { tone: 'neutral', label: 'Checking', detail: 'Connecting to the data source' };
  }
  return { tone: 'ok', label: 'Healthy', detail: `Data ${freshness.label.toLowerCase()}, no data-quality flags` };
}
