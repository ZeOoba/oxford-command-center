// server/warehouse/acq-notion-sync.ts
//
// Phase 4 Step 5 — Notion Acquisition Pipeline sync.
// Pulls all pages from the Notion Acq Pipeline DB and upserts into acq_candidates (Spine C).
//
// SPINE DISCIPLINE: writes ONLY to acq_candidates. Never touches ledger_entries or import_batches.
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
import { LOCAL_LOCKED_STATUSES } from './acq-hubspot-sync';

/** Full UUID for the Acquisition Pipeline Tracker Notion database (short id bcfe4a03). */
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
  if (lower.includes('closed') || lower.includes('won')) return 'acquired';
  if (lower.includes('dead') || lower.includes('lost') || lower.includes('passed')) return 'passed';
  if (lower.includes('archiv')) return 'archived';
  return 'active';
}

const NOTION_TIMEOUT_MS = 15_000;

async function queryNotionPage(
  fetchImpl: FetchLike,
  token: string,
  dbId: string,
  cursor?: string,
): Promise<NotionQueryResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS);
  const res = await fetchImpl(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
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
      const rentableSf = propNumber(props, 'sf', 'rentable sf', 'building sf');
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
      const isExistingCandidate = db.transaction((): boolean => {
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
        if (existing === undefined) return false;

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
        return true;
      })();

      if (isExistingCandidate) {
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
      result.errors.push(`page ${page.id}: ${String(e)}`);
    }
  }

  return result;
}
