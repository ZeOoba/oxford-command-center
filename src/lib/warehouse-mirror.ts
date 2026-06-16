// src/lib/warehouse-mirror.ts
//
// The "Fat Mirror" client contract (Eric Live Phase 1b). The deployed Cloudflare Pages mirror
// has NO Brain Server, so `/api/warehouse/*` is absent (the SPA index.html is served for those
// paths → non-JSON → WarehouseUnavailableError). The bake (`scripts/bake-warehouse.ts`) writes
// the COMPUTED route payloads into `public/warehouse.json`, keyed by the exact request path the
// client fetches; on the mirror the warehouse hooks read those precomputed payloads instead
// (mirroring the existing `/snapshot.json` fallback in src/data/client.ts).
//
// HONESTY GUARDRAILS:
//   • A `schemaVersion` stamp that FAIL-CLOSES the client (parse → null ⇒ "offline", never stale
//     data) when the baked shape predates the running client. Bump on any payload-shape change.
//   • The freshness badge (src/lib/freshness.ts → computeWarehouseFreshness) reads `bakedAt` so the
//     UI shows "Computed from snapshot baked Nh ago" — NEVER "Live".
//   • The mirror is READ-ONLY: writes (calibration resolve, lease-run assumptions, import/mapping
//     actions) have no edge home; the UI hides them when the live warehouse is unreachable.
import { z } from 'zod';

/** Bump whenever the baked payload shapes change so an older bake fail-closes a newer client. */
export const WAREHOUSE_MIRROR_SCHEMA_VERSION = 'wh-v1';

export const WarehouseSource = z.enum(['live-server', 'checkpoint-read']);
export type WarehouseSource = z.infer<typeof WarehouseSource>;

/** Provenance + age stamp (no endpoint payloads) — what the freshness badge needs. */
export interface WarehouseMirrorMeta {
  schemaVersion: string;
  bakedAt: string; // ISO 8601
  warehouseSource: WarehouseSource;
}

export const WarehouseMirrorEnvelopeSchema = z.object({
  schemaVersion: z.string(),
  bakedAt: z.string(),
  warehouseSource: WarehouseSource,
  // key = the exact client request path (incl. query string); value = that route's JSON payload.
  endpoints: z.record(z.unknown()),
});
export type WarehouseMirrorEnvelope = z.infer<typeof WarehouseMirrorEnvelopeSchema>;

/**
 * Validate a raw `/warehouse.json` body. FAIL-CLOSED: returns null on any structural failure OR a
 * schema-version mismatch — the caller then degrades to the honest offline state rather than
 * rendering a payload shaped for a different client.
 */
export function parseWarehouseMirror(raw: unknown): WarehouseMirrorEnvelope | null {
  const parsed = WarehouseMirrorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.schemaVersion !== WAREHOUSE_MIRROR_SCHEMA_VERSION) return null;
  return parsed.data;
}

/** The precomputed payload for an exact request path, or undefined when it was not baked. */
export function getMirrorEndpoint(env: WarehouseMirrorEnvelope, url: string): unknown {
  return env.endpoints[url];
}

export interface CalibrationLogFilterQuery {
  subject?: string | null;
  kind?: string | null;
  status?: 'open' | 'resolved' | null;
}

/**
 * The mirror bakes the UNFILTERED calibration log; this re-applies the server's WHERE client-side
 * (pure row selection — NOT engine math). Mirrors server/warehouse/calibration.ts `calibrationLog`:
 *   subject → subject_id =, kind → verdict_kind =, status open → no resolution / resolved → resolved.
 */
export function filterCalibrationLogRows<T extends { subjectId: string; verdictKind: string; resolved: boolean }>(
  rows: T[],
  query: CalibrationLogFilterQuery = {},
): T[] {
  const { subject = null, kind = null, status = null } = query;
  return rows.filter((r) => {
    if (subject && r.subjectId !== subject) return false;
    if (kind && r.verdictKind !== kind) return false;
    if (status === 'open' && r.resolved) return false;
    if (status === 'resolved' && !r.resolved) return false;
    return true;
  });
}

// Memoized loader: the baked mirror never changes within a page load, so fetch `/warehouse.json`
// at most once. Fail-closed to null (treated as "no mirror") on any error or version mismatch.
let mirrorPromise: Promise<WarehouseMirrorEnvelope | null> | null = null;

export function loadWarehouseMirror(): Promise<WarehouseMirrorEnvelope | null> {
  if (!mirrorPromise) {
    mirrorPromise = (async () => {
      try {
        const res = await fetch('/warehouse.json');
        if (!res.ok) return null;
        return parseWarehouseMirror(await res.json());
      } catch {
        return null;
      }
    })();
  }
  return mirrorPromise;
}

/** Test-only: drop the memoized envelope so a fresh fetch runs next call. */
export function __resetWarehouseMirrorCache(): void {
  mirrorPromise = null;
}
