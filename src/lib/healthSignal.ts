// src/lib/healthSignal.ts
//
// One-glance system-health signal for the TopBar dot (IA decongestion Phase 4a). Pure — derived
// from data the System Health module ALREADY reads (freshness + snapshot data-quality flags), using
// the same severity semantics as HealthModule: stale/offline data or an error-severity flag is an
// error; warn flags are a warning; a connecting feed is neutral.
//
// NOT included: HealthModule's `/api/health` fetch (AI key configured, daily-brief run). That is a
// module-local fetch with no shared hook; surfacing it here would add a new request to every page
// load, so the dot's tooltip points at the full module instead.
import type { DataQualityFlag } from '@contracts/index';
import type { Freshness } from './freshness';

export type HealthTone = 'ok' | 'warn' | 'error' | 'neutral';

export interface HealthSignal {
  tone: HealthTone;
  /** Short state word for the accessible name / tooltip. */
  label: string;
  /** One-line reason. */
  detail: string;
}

export function computeHealthSignal(freshness: Freshness, flags: readonly Pick<DataQualityFlag, 'severity'>[]): HealthSignal {
  const errors = flags.filter((f) => f.severity === 'error').length;
  const warns = flags.filter((f) => f.severity === 'warn').length;

  if (freshness.kind === 'offline' || freshness.kind === 'stale') {
    return { tone: 'error', label: 'Attention needed', detail: `Data ${freshness.label.toLowerCase()}${freshness.detail ? ` (${freshness.detail})` : ''}` };
  }
  if (errors > 0) {
    return { tone: 'error', label: 'Attention needed', detail: `${errors} data-quality error${errors === 1 ? '' : 's'}` };
  }
  if (warns > 0) {
    return { tone: 'warn', label: 'Warnings', detail: `${warns} data-quality warning${warns === 1 ? '' : 's'}` };
  }
  if (freshness.kind === 'connecting') {
    return { tone: 'neutral', label: 'Checking', detail: 'Connecting to the data source' };
  }
  return { tone: 'ok', label: 'Healthy', detail: `Data ${freshness.label.toLowerCase()}, no data-quality flags` };
}
