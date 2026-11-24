// server/warehouse/acq-hubspot-sync.ts
//
// Phase 4 — HubSpot Acquisitions pipeline sync.
// Pulls all deals from HubSpot's "Acquisitions" pipeline (885606973) and upserts into
// acq_candidates (Spine C) — a second, independent feed alongside the Notion Acq Pipeline
// sync (acq-notion-sync.ts). HubSpot deals sourced via broker relationships never get
// re-keyed into Notion today; this closes that coverage gap.
//
// SPINE DISCIPLINE: writes ONLY to acq_candidates (plus, via logAcqOutcome, calibration_outcome /
//   data_quality_issues on a terminal transition). Never touches ledger_entries or import_batches.
// ERROR HANDLING: a per-deal try/catch means one malformed deal never kills the entire sync.
//   First-page network/auth failure → throws (route returns 502).
//   Per-deal extraction/write error → pushed to errors[], sync continues.
// NO OUTER TRANSACTION: intentional — per-deal autocommit gives partial-success tolerance.
// OUTCOME LOGGING (2026-11-23): a write that moves a candidate into 'acquired' / 'passed' calls
//   logAcqOutcome (see terminalTransition), so pipeline resolutions reach calibration.
// STATUS NO-CLOBBER: UPDATE never downgrades a locally-advanced `acquired`, `passed` or
//   `archived` (see LOCAL_LOCKED_STATUSES) back to `active`. This protects a human decision
//   recorded via PATCH /acq/candidates/:id/status from being silently reverted by a resync --
//   accepted deliberately, same tradeoff as the Notion sync.
//   Adversarial review (2026-07-10) flagged that this also means a genuine HubSpot-side correction
//   (a fat-fingered "Closed Won" reopened back to active in HubSpot) can never flow through once
//   synced -- if that scenario needs to be supported, it requires an explicit manual status PATCH
//   in this app, not a silent auto-reconcile from either source feed.
// NAMESPACE: id = 'deal:hubspot:<hubspotDealId>' — visibly distinct from Notion's 'deal:<notionPageId>'
//   so the two external systems can never collide on primary key. Cross-system reconciliation
//   (e.g. the same physical property listed in both Notion and HubSpot) is explicitly out of
//   scope for this sync — a separate human/process problem.
// TEST-DATA GUARD: any deal whose name starts with "_Preflight" or "_Test" is skipped outright.
// HUBSPOT_TOKEN must never be committed; callers source it from process.env.
import { createHash } from 'node:crypto';
import type { WarehouseDb } from './db';
import { stableStringify } from './stable-stringify';
import { logAcqOutcome } from './acq-engine';

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** HubSpot pipeline id for the "Acquisitions" pipeline (label distinguishes it from "default" = Lease Renewals). */
export const HUBSPOT_ACQ_PIPELINE_ID = '885606973';

export interface AcqSyncResult {
  inserted: number;
  updated: number;
  errors: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Internal HubSpot type stubs ─────────────────────────────────────────────

interface HubSpotDealProperties {
  dealname?: string | null;
  dealstage?: string | null;
  pipeline?: string | null;
  createdate?: string | null;
  hs_lastmodifieddate?: string | null;
}

interface HubSpotDeal {
  id: string;
  properties: HubSpotDealProperties;
}

interface HubSpotSearchResponse {
  results: HubSpotDeal[];
  paging?: { next?: { after?: string } };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * dealstage → acq_candidates.status. Only Closed Won / Closed Lost resolve out of 'active';
 * every other stage in the Acquisitions pipeline (Sourced/Screened/LOI Submitted/Under
 * Contract/Due Diligence/Closing) is still an open, in-flight deal.
 */
const HUBSPOT_STAGE_STATUS: Record<string, 'active' | 'acquired' | 'passed'> = {
  '1331037317': 'active',   // Sourced
  '1331037318': 'active',   // Screened
  '1331037319': 'active',   // LOI Submitted
  '1331037321': 'active',   // Under Contract
  '1331037320': 'active',   // Due Diligence
  '1331048767': 'active',   // Closing
  '1331037322': 'acquired', // Closed Won
  '1331037323': 'passed',   // Closed Lost
};

// Adversarial review (2026-07-10) finding: HubSpot pipelines are user-editable, so a NEW
// terminal stage (e.g. a "lost-reason"/dead stage) gets a fresh numeric id this map has never
// seen. Falling through to 'active' silently marked a dead deal as a live candidate forever, with
// no observability -- a real regression vs. acq-notion-sync.ts's mapStatus(), which pattern-matches
// human-readable label substrings and so stays resilient to a newly-named Notion stage. Returns
// both the mapped status AND whether the code was recognized, so callers can surface an unmapped
// code as an anomaly instead of silently trusting the safe-looking default.
function mapDealStage(stage: string | null | undefined): { status: 'active' | 'acquired' | 'passed'; recognized: boolean } {
  if (!stage) return { status: 'active', recognized: true };
  const mapped = HUBSPOT_STAGE_STATUS[stage];
  return mapped === undefined ? { status: 'active', recognized: false } : { status: mapped, recognized: true };
}

/** Test/preflight noise guard — simple prefix match, case-sensitive. */
function isTestDeal(dealName: string | null): boolean {
  if (!dealName) return false;
  return dealName.startsWith('_Preflight') || dealName.startsWith('_Test');
}

/**
 * Statuses that represent a LOCAL human decision and must never be overwritten by a resync.
 *
 * 'archived' was added 2026-07-24 (integrity sweep, M1). PATCH /acq/candidates/:id/status
 * accepts active|archived|acquired|passed, but the no-clobber list only covered the two terminal
 * ones — so archiving a candidate was silently undone by the next sync, which reverted status to
 * the HubSpot-mapped value. Combined with the hash-based updated_at gate (also fixed), the revert
 * left NO trace: the row ended up asserting 'active' while carrying the timestamp of the moment
 * a human archived it. Archiving is a local lifecycle decision exactly like acquired/passed and
 * gets the same protection.
 *
 * Exported so acq-notion-sync.ts's UPDATE branch imports THIS set rather than maintaining its
 * own copy. Refute-lens finding (2026-07-24 gov-ltv-hardening review): this fix originally only
 * touched the HubSpot writer, leaving acq_candidates' SECOND sync writer (Notion) with the old
 * two-status no-clobber list -- an archived-via-Notion-resync candidate was still silently
 * reactivated. One shared set means the two writers cannot drift apart on this again.
 */
export const LOCAL_LOCKED_STATUSES: ReadonlySet<string> = new Set(['acquired', 'passed', 'archived']);

/**
 * The lifecycle outcome a sync write just produced: 'acquired' / 'passed' when the stored status moved
 * INTO that terminal status on this write, else null. Both sync writers call logAcqOutcome on it, so a
 * deal closed or lost in HubSpot / Notion reaches the calibration record the same way a PATCH does
 * (before 2026-11-23 the syncs set the status and never logged the outcome). A locked status never moves
 * (LOCAL_LOCKED_STATUSES), so a re-sync of an already-resolved deal is never a transition; a candidate
 * INSERTED already terminal has no score yet, so it has nothing to resolve and is not one either.
 */
export function terminalTransition(before: string, after: string): 'acquired' | 'passed' | null {
  if (before === after) return null;
  return after === 'acquired' || after === 'passed' ? after : null;
}

/**
 * Fingerprint of the values the row actually PERSISTS (address + resolved status).
 *
 * 2026-07-24 (M1/L1): this now hashes the RESOLVED status — the value the row will really hold
 * after the no-clobber CASE — not the raw incoming one. Previously a status-locked row whose
 * HubSpot stage merely shifted between two non-terminal stages produced a different hash on every
 * sync and bumped updated_at with nothing persisted changed: the exact phantom-edit signal
 * migration 025 existed to remove, reintroduced for locked rows.
 *
 * NOTE: content_hash is now a DEBUG/AUDIT fingerprint only. It is NOT the authority for
 * change detection — updated_at is gated on a direct persisted-column comparison instead,
 * because any out-of-band writer (e.g. the PATCH status route) can leave this column stale.
 */
function contentHash(address: string | null, status: string): string {
  return sha16(stableStringify({ address, status }));
}

const HUBSPOT_TIMEOUT_MS = 15_000;
const HUBSPOT_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/deals/search';

async function searchHubSpotDeals(
  fetchImpl: FetchLike,
  token: string,
  pipelineId: string,
  after?: string,
): Promise<HubSpotSearchResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HUBSPOT_TIMEOUT_MS);
  const body: Record<string, unknown> = {
    filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }] }],
    properties: ['dealname', 'dealstage', 'pipeline', 'createdate', 'hs_lastmodifieddate'],
    // Adversarial review (2026-07-10) finding: without a stable sort, HubSpot's `after`
    // pagination is a plain numeric OFFSET (not a snapshot cursor like Notion's start_cursor),
    // so a deal modified mid-drain can slide across a page boundary and be returned twice (or
    // dropped) across a multi-page sync. Sorting on the immutable hs_object_id makes pagination
    // stable regardless of concurrent edits.
    sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
    limit: 100,
  };
  if (after !== undefined) body['after'] = after;
  const res = await fetchImpl(HUBSPOT_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) {
    throw new Error(`HubSpot API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as HubSpotSearchResponse;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function syncHubSpotPipeline(
  db: WarehouseDb,
  hubspotToken: string,
  opts?: { pipelineId?: string; fetchImpl?: FetchLike },
): Promise<AcqSyncResult> {
  if (!hubspotToken) throw new Error('hubspotToken is required');
  const pipelineId = opts?.pipelineId ?? HUBSPOT_ACQ_PIPELINE_ID;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);

  const result: AcqSyncResult = { inserted: 0, updated: 0, errors: [] };

  // Drain all HubSpot deal pages (pagination). First-page failure throws (callers → 502).
  let after: string | undefined;
  const allDealsRaw: HubSpotDeal[] = [];
  do {
    const response = await searchHubSpotDeals(fetchImpl, hubspotToken, pipelineId, after);
    allDealsRaw.push(...response.results);
    after = response.paging?.next?.after;
  } while (after !== undefined);

  // Adversarial review (2026-07-10) finding: even with a stable sort (above), dedupe defensively
  // by id before upserting -- a deal appearing twice in one drain previously took BOTH the INSERT
  // and UPDATE branch for the same physical deal, over-counting inserted+updated in the returned
  // telemetry, and (worse) resolved status/address from whichever occurrence happened to land
  // last -- a non-deterministic merge for the exact same input set, permuted. Map-dedup (last
  // occurrence wins) makes each distinct deal id processed exactly once.
  const allDeals = [...new Map(allDealsRaw.map((d) => [d.id, d])).values()];

  // Upsert each deal. Per-deal errors → errors[], continue (no outer transaction).
  for (const deal of allDeals) {
    try {
      // Direct property access (not optional-chained past this point) so a malformed
      // deal (e.g. properties: null) throws here and is captured below, per-deal —
      // mirrors the Notion sync's per-page error-isolation contract.
      const props = deal.properties;
      const dealName = props.dealname ?? null;

      if (isTestDeal(dealName)) continue;

      const hubspotDealId = deal.id;
      const candidateId = `deal:hubspot:${hubspotDealId}`;
      const { status, recognized } = mapDealStage(props.dealstage);
      if (!recognized) {
        result.errors.push(
          `deal ${hubspotDealId}: unrecognized dealstage '${props.dealstage}' -- defaulted to 'active'; add it to HUBSPOT_STAGE_STATUS`,
        );
      }

      // SELECT-then-UPDATE, wrapped atomically (2026-07-24, refute-review): resolving
      // resolvedStatus/persistedChanged in TypeScript happens BETWEEN a read and a write — a
      // read-then-write pair that a concurrent writer to the SAME SQLite file (a second OS
      // process, e.g. a CLI/scheduled-task run overlapping this one) could interleave with,
      // landing a PATCH between the SELECT and UPDATE and having it silently overwritten by
      // this sync's stale-read resolution. Not reachable in-process today (no await between
      // them), but financial-decision code should not depend on process topology for its
      // no-clobber invariant. db.transaction() makes the SELECT+UPDATE pair atomic without
      // touching the "NO OUTER TRANSACTION" per-deal isolation contract above — this
      // transaction is scoped to one deal, same partial-success tolerance as before.
      const upsert = db.transaction((): { existing: boolean; resolvedTo: 'acquired' | 'passed' | null } => {
        const existingRow = db.prepare(
          'SELECT id, address, status FROM acq_candidates WHERE id = ?',
        ).get(candidateId) as { id: string; address: string | null; status: string } | undefined;
        if (existingRow === undefined) return { existing: false, resolvedTo: null };

        // The status the row will ACTUALLY hold after this UPDATE, resolved in TS so the
        // change-detection below compares persisted-vs-persisted (see M1 note above).
        const resolvedStatus = LOCAL_LOCKED_STATUSES.has(existingRow.status) ? existingRow.status : status;
        // M1: gate updated_at on whether this UPDATE genuinely changes a PERSISTED column —
        // not on whether the incoming hash matches a stored one. The stored hash records the
        // last sync's INPUT; a third writer (PATCH /acq/candidates/:id/status) changes status
        // without touching it, so a matching hash never proved the row was unchanged. It could
        // and did mean "revert the human's edit and freeze updated_at at their timestamp".
        const persistedChanged =
          existingRow.address !== dealName || existingRow.status !== resolvedStatus;
        db.prepare(`
          UPDATE acq_candidates
          SET address = ?,
              status = ?,
              content_hash = ?,
              updated_at = CASE WHEN ? THEN datetime('now') ELSE updated_at END
          WHERE id = ?
        `).run(dealName, resolvedStatus, contentHash(dealName, resolvedStatus), persistedChanged ? 1 : 0, candidateId);
        const resolvedTo = terminalTransition(existingRow.status, resolvedStatus);
        // The deal just resolved in HubSpot (Closed Won / Closed Lost): record the calibration outcome, as
        // PATCH /acq/candidates/:id/status does. INSIDE this transaction (merge gate PR #591, R-3): run after
        // the commit, another writer (an importer) could move the current-score pointer in between and the
        // permanent outcome would bind to a screen made after the decision. Fail-open (logAcqOutcome never
        // throws) and idempotent per deal; it nests as plain statements under this transaction.
        if (resolvedTo !== null) logAcqOutcome(db, candidateId, resolvedTo);
        return { existing: true, resolvedTo };
      })();

      if (upsert.existing) {
        result.updated += 1;
      } else {
        const newHash = contentHash(dealName, status);
        // county/state/market/rentable_sf/year_built/owner_name: HubSpot's deal object in
        // this account has no structured equivalent of Notion's page properties for these —
        // dealname is the only descriptive text available, so it lands in `address` and the
        // rest stay NULL. Parsing city/state out of the free-text dealname is a follow-on
        // nice-to-have, not implemented here.
        db.prepare(`
          INSERT INTO acq_candidates
            (id, source, address, county, state, market, rentable_sf, year_built, owner_name, status, content_hash)
          VALUES (?, 'hubspot-pipeline', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(candidateId, dealName, status, newHash);
        result.inserted += 1;
      }
    } catch (e) {
      // Raw exception text (SQLite table/constraint names) goes to the server log, not the 200 body.
      console.error(`[acq-hubspot-sync] deal ${deal.id} failed:`, e);
      result.errors.push(`deal ${deal.id}: could not be processed (see server log)`);
    }
  }

  return result;
}
