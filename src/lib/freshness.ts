import type { BrainState, FreshnessKind } from '@contracts/index';
import type { WarehouseMirrorMeta } from './warehouse-mirror';

/** A static bake older than this is considered stale. */
export const STALENESS_HOURS = 24;

export interface Freshness {
  kind: FreshnessKind;
  label: string;
  /** Human age string, e.g. "baked 6h ago" / "updated 12s ago"; null when unknown. */
  detail: string | null;
  /** Age of the baked snapshot in ms (static/stale only); null otherwise. */
  bakeAgeMs: number | null;
  isStale: boolean;
}

/** Compact relative-age string. */
export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Derive honest freshness from the brain state. The deployed mirror is a static bake
 * (source 'snapshot-fallback'); it must NEVER read as "Live". Staleness is computed at
 * render time against `now`, because a bake can age out while a tab stays open.
 */
export function computeFreshness(state: BrainState | null, now = Date.now()): Freshness {
  if (!state) {
    return { kind: 'connecting', label: 'Connecting', detail: null, bakeAgeMs: null, isStale: false };
  }
  if (state.status === 'refreshing') {
    return { kind: 'refreshing', label: 'Refreshing', detail: null, bakeAgeMs: null, isStale: false };
  }
  if (state.status === 'error') {
    return { kind: 'offline', label: 'Offline', detail: null, bakeAgeMs: null, isStale: false };
  }

  const t = state.lastUpdated ? new Date(state.lastUpdated).getTime() : NaN;
  const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;

  // Live = connected to the Brain Server reading the workbook directly.
  if (state.source === 'workbook') {
    return {
      kind: 'live',
      label: 'Live',
      detail: ageMs !== null ? `updated ${formatAge(ageMs)}` : null,
      bakeAgeMs: null,
      isStale: false,
    };
  }

  // Static bake (deployed mirror). Stale once older than STALENESS_HOURS.
  if (state.source === 'snapshot-fallback') {
    const stale = ageMs !== null && ageMs > STALENESS_HOURS * 3_600_000;
    return {
      kind: stale ? 'stale' : 'static',
      label: stale ? 'Stale' : 'Static',
      detail: ageMs !== null ? `baked ${formatAge(ageMs)}` : null,
      bakeAgeMs: ageMs,
      isStale: stale,
    };
  }

  return { kind: 'offline', label: 'Offline', detail: null, bakeAgeMs: ageMs, isStale: false };
}

/**
 * Per-spine freshness for the warehouse (PFI + Calibration) on the baked mirror. The warehouse data
 * is COMPUTED at bake time from the snapshot, so it must NEVER read as "Live": the label is
 * "Computed from snapshot" and the detail "baked Nh ago". A null meta (no mirror, or a schema-version
 * mismatch the loader fail-closed to null) renders as Offline — never as silently-stale data.
 */
export function computeWarehouseFreshness(meta: WarehouseMirrorMeta | null, now = Date.now()): Freshness {
  if (!meta) {
    return { kind: 'offline', label: 'Offline', detail: null, bakeAgeMs: null, isStale: false };
  }
  const t = Date.parse(meta.bakedAt);
  const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
  // An unparseable bakedAt yields an unknowable age — fail-closed to Offline, never a non-stale
  // snapshot (the loader's z.string().datetime() normally prevents this; this is defense-in-depth).
  if (ageMs === null) {
    return { kind: 'offline', label: 'Offline', detail: null, bakeAgeMs: null, isStale: false };
  }
  const stale = ageMs > STALENESS_HOURS * 3_600_000;
  return {
    kind: stale ? 'stale' : 'static',
    label: 'Computed from snapshot',
    detail: `baked ${formatAge(ageMs)}`,
    bakeAgeMs: ageMs,
    isStale: stale,
  };
}
