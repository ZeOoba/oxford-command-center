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
// STATUS NO-CLOBBER: UPDATE never downgrades a locally-advanced `acquired` or `passed` back to `active`.
// NAMESPACE: id = 'deal:hubspot:<hubspotDealId>' — visibly distinct from Notion's 'deal:<notionPageId>'
//   so the two external systems can never collide on primary key. Cross-system reconciliation
//   (e.g. the same physical property listed in both Notion and HubSpot) is explicitly out of
//   scope for this sync — a separate human/process problem.
// TEST-DATA GUARD: any deal whose name starts with "_Preflight" or "_Test" is skipped outright.
// HUBSPOT_TOKEN must never be committed; callers source it from process.env.
import type { WarehouseDb } from './db';

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

function mapDealStage(stage: string | null | undefined): 'active' | 'acquired' | 'passed' {
  if (!stage) return 'active';
  return HUBSPOT_STAGE_STATUS[stage] ?? 'active';
}

/** Test/preflight noise guard — simple prefix match, case-sensitive. */
function isTestDeal(dealName: string | null): boolean {
  if (!dealName) return false;
  return dealName.startsWith('_Preflight') || dealName.startsWith('_Test');
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
  const allDeals: HubSpotDeal[] = [];
  do {
    const response = await searchHubSpotDeals(fetchImpl, hubspotToken, pipelineId, after);
    allDeals.push(...response.results);
    after = response.paging?.next?.after;
  } while (after !== undefined);

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
      const status = mapDealStage(props.dealstage);

      const existing = db.prepare(
        'SELECT id FROM acq_candidates WHERE id = ?',
      ).get(candidateId) as { id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE acq_candidates
          SET address = ?,
              status = CASE WHEN status IN ('acquired','passed') THEN status ELSE ? END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(dealName, status, candidateId);
        result.updated += 1;
      } else {
        // county/state/market/rentable_sf/year_built/owner_name: HubSpot's deal object in
        // this account has no structured equivalent of Notion's page properties for these —
        // dealname is the only descriptive text available, so it lands in `address` and the
        // rest stay NULL. Parsing city/state out of the free-text dealname is a follow-on
        // nice-to-have, not implemented here.
        db.prepare(`
          INSERT INTO acq_candidates
            (id, source, address, county, state, market, rentable_sf, year_built, owner_name, status)
          VALUES (?, 'hubspot-pipeline', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
        `).run(candidateId, dealName, status);
        result.inserted += 1;
      }
    } catch (e) {
      result.errors.push(`deal ${deal.id}: ${String(e)}`);
    }
  }

  return result;
}
