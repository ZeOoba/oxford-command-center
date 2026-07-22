// server/warehouse/acq-hubspot-sync.ts
//
// Phase 4 — HubSpot Acquisitions pipeline sync.
// Pulls all deals from HubSpot's "Acquisitions" pipeline (885606973) and upserts into
// acq_candidates (Spine C) — a second, independent feed alongside the Notion Acq Pipeline
// sync (acq-notion-sync.ts). HubSpot deals sourced via broker relationships never get
// re-keyed into Notion today; this closes that coverage gap.
//
// SPINE DISCIPLINE: writes ONLY to acq_candidates. Never touches ledger_entries or import_batches.
// ERROR HANDLING: a per-deal try/catch means one malformed deal never kills the entire sync.
//   First-page network/auth failure → throws (route returns 502).
//   Per-deal extraction/write error → pushed to errors[], sync continues.
// NO OUTER TRANSACTION: intentional — per-deal autocommit gives partial-success tolerance.
// STATUS NO-CLOBBER: UPDATE never downgrades a locally-advanced `acquired` or `passed` back to
//   `active`. This protects a human decision recorded via PATCH /acq/candidates/:id/status from
//   being silently reverted by a resync -- accepted deliberately, same tradeoff as the Notion sync.
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

/** Hash of the fields the upsert below actually writes (address, status), excluding id and
 *  the timestamp columns — so a resync with no real HubSpot-side change reseeds to an identical
 *  hash and doesn't bump updated_at. Mirrors migration 024's property_master content_hash fix.
 *  Reflects the INCOMING mapped status, not the status no-clobber CASE's persisted resolution
 *  (see STATUS NO-CLOBBER above) — an already-locked acquired/passed row can still see its hash
 *  change (and updated_at bump) if HubSpot's reported stage shifts, even though `status` itself
 *  stays locked; accepted, same tradeoff class as the no-clobber behavior it sits alongside. */
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

      const existing = db.prepare(
        'SELECT id FROM acq_candidates WHERE id = ?',
      ).get(candidateId) as { id: string } | undefined;

      const newHash = contentHash(dealName, status);

      if (existing) {
        db.prepare(`
          UPDATE acq_candidates
          SET address = ?,
              status = CASE WHEN status IN ('acquired','passed') THEN status ELSE ? END,
              content_hash = ?,
              updated_at = CASE WHEN content_hash IS ? THEN updated_at ELSE datetime('now') END
          WHERE id = ?
        `).run(dealName, status, newHash, newHash, candidateId);
        result.updated += 1;
      } else {
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
      result.errors.push(`deal ${deal.id}: ${String(e)}`);
    }
  }

  return result;
}
