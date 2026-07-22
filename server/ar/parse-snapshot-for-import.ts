// server/ar/parse-snapshot-for-import.ts
//
// Pure parse of the /api/snapshot response body, used by scripts/ar-import.ts. Extracted into its
// own module (rather than left inline in the CLI script) so it can be unit-tested directly — a CLI
// script's main() runs unconditionally at module load with no entry-point guard, so importing
// anything FROM scripts/ar-import.ts in a test would trigger main() and likely process.exit().
//
// Refute 2026-07-22 round 4 (HIGH — caught the prior version dead on arrival): server/index.ts's
// /api/snapshot route returns `{ snapshot: {...}, state }` — everything nested under `snapshot`
// (confirmed against the actual route handler and against src/data/client.ts, the real UI client,
// which correctly reads `json.snapshot`). The version this replaces read `leases` and `tenantArrears`
// off the TOP LEVEL of the response instead, so both were ALWAYS `[]`/`{}` against a real server —
// every guard built on top of that parse (round 2's interactive staleness guard, round 3's TOCTOU
// recheck) was a structural no-op that never once compared against a real persisted record. (The
// `leases` half of this bug pre-dates this PR's changes — the original fetchLeases had the identical
// flat-parse flaw — so lease auto-matching in the interactive script has likely never worked against
// a live server either; fixed here as part of the same parse.)
//
// Fails LOUDLY (throws) rather than silently defaulting to empty when the envelope itself is
// missing/malformed — an empty roster or arrears map must never be indistinguishable from "verified
// empty", since either would silently disable every safety guard this script has.

import type { LeaseLite } from './match-tenant';
import type { TenantArrears } from '../../src/contracts/index';

export interface SnapshotForImport {
  leases: LeaseLite[];
  /** Currently-persisted per-lease arrears — fetched alongside leases (one round-trip) so the
   *  interactive script's write step can guard against overwriting a fresher balance. */
  tenantArrears: Record<string, TenantArrears>;
}

export function parseSnapshotForImport(body: unknown): SnapshotForImport {
  const envelope = body as {
    snapshot?: {
      leases?: Array<{ id: string; tenantName: string; company: string | null }>;
      tenantArrears?: Record<string, TenantArrears>;
    };
  };
  if (!envelope || typeof envelope !== 'object' || !envelope.snapshot || typeof envelope.snapshot !== 'object') {
    throw new Error("/api/snapshot response is missing the expected 'snapshot' envelope — cannot verify the lease roster or persisted arrears. Refusing to proceed rather than silently treating everything as empty.");
  }
  const { leases, tenantArrears } = envelope.snapshot;
  return {
    leases: (leases ?? []).map((l) => ({ id: l.id, tenantName: l.tenantName, company: l.company ?? null })),
    tenantArrears: tenantArrears ?? {},
  };
}
