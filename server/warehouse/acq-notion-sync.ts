// server/warehouse/acq-notion-sync.ts
//
// Phase 4 Step 5 — Notion Acquisition Pipeline sync.
// Pulls all pages from the Notion Acq Pipeline DB and upserts into acq_candidates (Spine C).
//
// SPINE DISCIPLINE: writes ONLY to acq_candidates (plus, via logAcqOutcome on a terminal status
//   transition, calibration_outcome / data_quality_issues). Never touches ledger_entries or import_batches.
// ERROR HANDLING: a per-page try/catch means one malformed page never kills the entire sync.
//   First-page network/auth failure → throws (route returns 502).
//   Per-page extraction/write error → pushed to errors[], sync continues.
// NO OUTER TRANSACTION: intentional — per-page autocommit gives partial-success tolerance.
// STATUS NO-CLOBBER: UPDATE never downgrades a locally-advanced `acquired`, `passed` or
//   `archived` (LOCAL_LOCKED_STATUSES, shared with acq-hubspot-sync.ts) back to `active`.
// NOTION_TOKEN must never be committed; callers source it from process.env.
import type { WarehouseDb } from './db';
// LOCAL_LOCKED_STATUSES is defined once in acq-hubspot-sync.ts (Notion and HubSpot are the two
// independent writers to acq_candidates and must never diverge on which statuses are locked
// against a resync — see the constant's doc comment for the 2026-07-24 incident this closes).
import { LOCAL_LOCKED_STATUSES, terminalTransition } from './acq-hubspot-sync';
import { logAcqOutcome } from './acq-engine';

/**
 * Full UUID for the Acquisition Pipeline Tracker Notion *data source* (short id bcfe4a03).
 * Queried via /v1/data_sources/{id}/query — the legacy /v1/databases/{id}/query 404s for it.
 */
export const ACQ_PIPELINE_DB_ID = 'bcfe4a03-7e61-4ac1-a0bb-c44174fa138b';

export interface AcqSyncResult {
  inserted: number;
  updated: number;
  errors: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Internal Notion type stubs ──────────────────────────────────────────────

type NotionRichText = { plain_text: string };
type NotionSelectOption = { name: string };

interface NotionProperty {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: NotionSelectOption | null;
  number?: number | null;
  status?: NotionSelectOption | null;
  people?: { name?: string }[];
}

interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_CLUSTER_TIERS = new Set([
  'owned-submarket', 'established', 'entry', 'satellite', 'none',
] as const);

function propText(props: Record<string, NotionProperty>, ...aliases: string[]): string | null {
  for (const alias of aliases) {
    const key = Object.keys(props).find(
      (k) => k.toLowerCase() === alias.toLowerCase(),
    );
    if (!key) continue;
    const prop = props[key];
    if (!prop) continue;
    if (prop.type === 'title' && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join('').trim() || null;
    }
    if (prop.type === 'rich_text' && prop.rich_text?.length) {
      return prop.rich_text.map((t) => t.plain_text).join('').trim() || null;
    }
    if ((prop.type === 'select' || prop.type === 'status') && prop.select?.name) {
      return prop.select.name;
    }
    if (prop.type === 'status' && prop.status?.name) {
      return prop.status.name;
    }
    if (prop.type === 'people' && prop.people?.length) {
      return prop.people.map((p) => p.name ?? '').join(', ').trim() || null;
    }
  }
  return null;
}

function propNumber(props: Record<string, NotionProperty>, ...aliases: string[]): number | null {
  for (const alias of aliases) {
    const key = Object.keys(props).find(
      (k) => k.toLowerCase() === alias.toLowerCase(),
    );
    if (!key) continue;
    const prop = props[key];
    if (prop?.type === 'number' && prop.number !== null && prop.number !== undefined) {
      return prop.number;
    }
  }
  return null;
}

function mapMarket(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\s+/g, '-');
  if ((VALID_CLUSTER_TIERS as Set<string>).has(lower)) return lower;
  return null;
}

function mapStatus(raw: string | null): 'active' | 'archived' | 'acquired' | 'passed' {
  if (!raw) return 'active';
  const lower = raw.toLowerCase();
  // Negative terms FIRST (refute wf_c51f7c6a-65b): 'Closed Lost' / 'Closed - Dead' used to match 'closed'
  // and map to 'acquired'. Harmless while only the status label read it; wrong-signed once a status
  // move writes a calibration outcome. 'won' is matched as a whole word so "Won't Pursue" is not a close —
  // straight, curly (U+2019) or backtick apostrophe alike (merge gate PR #591, C-4: Notion autocorrects to
  // the curly one, and "Won’t Pursue" used to lock the deal as 'acquired').
  if (lower.includes('dead') || lower.includes('lost') || lower.includes('passed') || lower.includes('killed')) return 'passed';
  if (lower.includes('closed') || /\bwon\b(?!['’`])/.test(lower)) return 'acquired';
  if (lower.includes('archiv')) return 'archived';
  return 'active';
}

/**
 * Notion stage names whose status move may write a calibration OUTCOME (refute wf_c51f7c6a-65b). mapStatus
 * is substring-based so an unforeseen label still lands on a sensible candidate status, but a calibration
 * outcome is permanent (logAcqOutcome's deal-level idempotency blocks any later auto-correction), so it is
 * written only for the exact terminal options of the live Stage select (server/sources/notion-deals.ts
 * STAGE_MAP), compared case-insensitively. Any other terminal-looking label still moves the status but
 * logs no outcome — resolve that deal via resolveManualOutcome.
 */
export const NOTION_OUTCOME_STAGES: Readonly<Record<string, 'acquired' | 'passed'>> = {
  'closed won': 'acquired',
  passed: 'passed',
  killed: 'passed',
};

const NOTION_TIMEOUT_MS = 15_000;

async function queryNotionPage(
  fetchImpl: FetchLike,
  token: string,
  dbId: string,
  cursor?: string,
): Promise<NotionQueryResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS);
  const res = await fetchImpl(`https://api.notion.com/v1/data_sources/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as NotionQueryResponse;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function syncNotionPipeline(
  db: WarehouseDb,
  notionToken: string,
  opts?: { databaseId?: string; fetchImpl?: FetchLike },
): Promise<AcqSyncResult> {
  if (!notionToken) throw new Error('notionToken is required');
  const dbId = opts?.databaseId ?? ACQ_PIPELINE_DB_ID;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);

  const result: AcqSyncResult = { inserted: 0, updated: 0, errors: [] };

  // Drain all Notion pages (pagination). First-page failure throws (callers → 502).
  let cursor: string | undefined;
  const allPages: NotionPage[] = [];
  do {
    const response = await queryNotionPage(fetchImpl, notionToken, dbId, cursor);
    allPages.push(...response.results);
    cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
  } while (cursor !== undefined);

  // Upsert each page. Per-page errors → errors[], continue (no outer transaction).
  for (const page of allPages) {
    try {
      const notionPageId = page.id;
      const candidateId = `deal:${notionPageId}`;
      const props = page.properties;

      const address = propText(props, 'property', 'address', 'name');
      const county = propText(props, 'county');
      const state = propText(props, 'state');
      const market = mapMarket(propText(props, 'market', 'cluster'));
      const rentableSf = propNumber(props, 'sf', 'rentable sf', 'building sf', 'total sf');
      const yearBuilt = (() => {
        const n = propNumber(props, 'year built');
        return n !== null ? Math.trunc(n) : null;
      })();
      const ownerName = propText(props, 'owner', 'seller');
      const statusRaw = propText(props, 'status', 'stage');
      const status = mapStatus(statusRaw);

      // SELECT-then-UPDATE, wrapped atomically (2026-07-24, round-2 refute-review): mirrors
      // acq-hubspot-sync.ts's identical fix — see that module's comment on the same pattern
      // for the full rationale. Not reachable in-process today (no await between the read and
      // write), but this closes the twin-writer asymmetry the L1 fix below was itself meant to
      // eliminate: fixing HubSpot's TOCTOU exposure while leaving Notion's freshly-rewritten
      // SELECT+UPDATE pair unwrapped would have recreated exactly that drift.
      const upsert = db.transaction((): { candidateId: string | null; resolvedTo: 'acquired' | 'passed' | null } => {
        const existing = db.prepare(
          'SELECT id, address, county, state, market, rentable_sf, year_built, owner_name, status FROM acq_candidates WHERE notion_deal_id = ?',
        ).get(notionPageId) as
          | {
              id: string;
              address: string | null;
              county: string | null;
              state: string | null;
              market: string | null;
              rentable_sf: number | null;
              year_built: number | null;
              owner_name: string | null;
              status: string;
            }
          | undefined;
        if (existing === undefined) return { candidateId: null, resolvedTo: null };

        // 2026-07-24 (integrity sweep M1/L1, applied to this writer on refute-review): mirrors
        // acq-hubspot-sync.ts's fix. Two changes from the prior UPDATE:
        //   (1) status no-clobber now uses the SHARED LOCAL_LOCKED_STATUSES (adds 'archived' —
        //       previously only acquired/passed were protected here, so an archived candidate
        //       was silently reactivated by the next Notion resync).
        //   (2) updated_at is gated on whether this UPDATE genuinely changes a PERSISTED column,
        //       not bumped unconditionally on every sync. The old unconditional
        //       `updated_at = datetime('now')` bumped every synced row's timestamp on every
        //       resync regardless of whether anything changed — worse than the pre-fix HubSpot
        //       gate (which at least compared a hash), and meant a PATCH-driven status/edit
        //       timestamp was overwritten by the very next scheduled sync even with no real
        //       Notion-side change.
        const resolvedStatus = LOCAL_LOCKED_STATUSES.has(existing.status) ? existing.status : status;
        const persistedChanged =
          existing.address !== address ||
          existing.county !== county ||
          existing.state !== state ||
          existing.market !== market ||
          existing.rentable_sf !== rentableSf ||
          existing.year_built !== yearBuilt ||
          existing.owner_name !== ownerName ||
          existing.status !== resolvedStatus;
        db.prepare(`
          UPDATE acq_candidates
          SET address = ?, county = ?, state = ?, market = ?, rentable_sf = ?,
              year_built = ?, owner_name = ?,
              status = ?,
              updated_at = CASE WHEN ? THEN datetime('now') ELSE updated_at END
          WHERE notion_deal_id = ?
        `).run(
          address, county, state, market, rentableSf, yearBuilt, ownerName,
          resolvedStatus, persistedChanged ? 1 : 0, notionPageId,
        );
        const moved = terminalTransition(existing.status, resolvedStatus);
        const key = statusRaw === null ? '' : statusRaw.trim().toLowerCase();
        const exact = Object.hasOwn(NOTION_OUTCOME_STAGES, key) ? NOTION_OUTCOME_STAGES[key] : undefined;
        const resolvedTo = moved !== null && exact === moved ? moved : null;
        // Resolved in Notion: record the calibration outcome against the stored row's own id (matched by
        // notion_deal_id), as PATCH /acq/candidates/:id/status does. INSIDE this transaction (merge gate
        // PR #591, R-3), so no other writer can move the current-score pointer between the status move and
        // the outcome binding. Fail-open, idempotent per deal.
        if (resolvedTo !== null) logAcqOutcome(db, existing.id, resolvedTo);
        return { candidateId: existing.id, resolvedTo };
      })();

      if (upsert.candidateId !== null) {
        result.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO acq_candidates
            (id, source, address, county, state, market, rentable_sf, year_built,
             owner_name, status, notion_deal_id)
          VALUES (?, 'notion-pipeline', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(candidateId, address, county, state, market, rentableSf, yearBuilt, ownerName, status, notionPageId);
        result.inserted += 1;
      }
    } catch (e) {
      // Raw exception text (SQLite table/constraint names) goes to the server log, not the 200 body.
      console.error(`[acq-notion-sync] page ${page.id} failed:`, e);
      result.errors.push(`page ${page.id}: could not be processed (see server log)`);
    }
  }

  return result;
}
