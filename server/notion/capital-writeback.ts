// server/notion/capital-writeback.ts
//
// Direction 1 — Notion Writeback for the Capital Allocation engine.
//
// Pushes per-property capital decisions (capitalAction + priorityScore) from the
// CapitalAllocationReport back to the Notion 🏢 Property Register so they surface in the
// operational workflow. Read-from-Notion (query pages) + write-to-Notion (PATCH pages) only —
// it NEVER touches the warehouse or any Spine. Mirrors the patterns in acq-notion-sync.ts.
//
// TARGET: 🏢 Property Register (DB 24d6a531-f4b7-4c38-87fb-3b1be4a4f1f3, the per-property DB
//   under the Notion Operations Hub). Title property is "Property Name". This is the
//   operational per-property register — NOT the deal-level Acquisition Pipeline.
//
// MATCHING: by title, case-insensitive and whitespace-trimmed (normalizeTitle). One Notion
//   page may carry many warehouse propertyNames only if titles collide — first page wins;
//   the rest are deterministic by Notion's query order.
//
// FAIL-OPEN (hard requirement): a per-property mismatch is `skipped`, never an error. A single
//   page write failure (Notion non-2xx / timeout / thrown fetch) lands in errors[] and the loop
//   continues. The function only THROWS for a missing token (a configuration error the route
//   surfaces as 400) — every other failure is tallied and returned.
//
// PROPERTY CREATION: "Capital Action" (select) and "Priority Score" (number) may not exist on
//   the Property Register yet. ensureProperties() PATCHes the database schema to create them
//   (idempotent — re-PATCHing existing properties is a no-op on Notion's side). A failure here
//   is recorded as an error but does not abort: the page writes below will then simply fail and
//   be tallied too.
//
// NOTION_TOKEN must never be committed; callers source it from process.env.

/** Full UUID for the 🏢 Property Register Notion database (short id 24d6a531). */
export const PROPERTY_REGISTER_DB_ID = '24d6a531-f4b7-4c38-87fb-3b1be4a4f1f3';

/** Notion title property on the Property Register. */
const TITLE_PROP = 'Property Name';
/** Writeback target properties (created if absent). */
const ACTION_PROP = 'Capital Action';
const PRIORITY_PROP = 'Priority Score';

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_TIMEOUT_MS = 10_000;

/** The capital-allocation fields this writeback needs — a structural subset of CapitalAllocationEntry. */
export interface CapitalActionInput {
  propertyName: string | null;
  capitalAction: 'invest' | 'hold' | 'monitor' | 'disposition-candidate';
  priorityScore: number;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  asOf: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SyncOptions {
  asOf: string;
  databaseId?: string;
  fetchImpl?: FetchLike;
}

// ─── Internal Notion type stubs ──────────────────────────────────────────────

type NotionRichText = { plain_text: string };

interface NotionPage {
  id: string;
  properties: Record<string, { type?: string; title?: NotionRichText[] } | undefined> | null;
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const notionHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

/** Case-insensitive, whitespace-collapsed title key for matching. Empty string when blank. */
function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Extract the plain-text title from a Notion page's title property. */
function pageTitle(page: NotionPage): string | null {
  const props = page.properties;
  if (!props) return null;
  const titleProp = props[TITLE_PROP];
  if (titleProp?.type === 'title' && titleProp.title?.length) {
    return titleProp.title.map((t) => t.plain_text).join('').trim() || null;
  }
  return null;
}

/** fetch with a hard timeout (AbortController) — mirrors fred.ts / acq-notion-sync.ts. */
async function notionFetch(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS);
  return fetchImpl(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/**
 * Ensure "Capital Action" (select) and "Priority Score" (number) exist on the database.
 * Idempotent: PATCHing an already-present property is a Notion no-op. Returns an error string
 * on failure (caller records it but continues — page writes will then fail and be tallied too).
 */
async function ensureProperties(
  fetchImpl: FetchLike,
  token: string,
  dbId: string,
): Promise<string | null> {
  try {
    const res = await notionFetch(fetchImpl, `${NOTION_BASE}/databases/${dbId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: {
          [ACTION_PROP]: {
            select: {
              options: [
                { name: 'invest', color: 'green' },
                { name: 'hold', color: 'default' },
                { name: 'monitor', color: 'yellow' },
                { name: 'disposition-candidate', color: 'red' },
              ],
            },
          },
          [PRIORITY_PROP]: { number: { format: 'number' } },
        },
      }),
    });
    if (!res.ok) {
      return `ensure-properties: Notion API ${res.status}: ${await res.text().catch(() => '')}`;
    }
    return null;
  } catch (e) {
    return `ensure-properties: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Drain every page of the Property Register and build a normalized-title → pageId map.
 * Throws on a query failure so the caller can record ONE query-stage error and stop
 * (without a page map there is nothing to match against).
 */
async function buildTitleIndex(
  fetchImpl: FetchLike,
  token: string,
  dbId: string,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const res = await notionFetch(fetchImpl, `${NOTION_BASE}/databases/${dbId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) {
      throw new Error(`query: Notion API ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const data = (await res.json()) as NotionQueryResponse;
    for (const page of data.results) {
      const key = normalizeTitle(pageTitle(page));
      if (key && !index.has(key)) index.set(key, page.id);
    }
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
  } while (cursor !== undefined);
  return index;
}

/** PATCH one page with the capital action + priority score. Throws on non-2xx. */
async function writePage(
  fetchImpl: FetchLike,
  token: string,
  pageId: string,
  entry: CapitalActionInput,
): Promise<void> {
  const res = await notionFetch(fetchImpl, `${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        [ACTION_PROP]: { select: { name: entry.capitalAction } },
        [PRIORITY_PROP]: { number: Math.round(entry.priorityScore) },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${await res.text().catch(() => '')}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sync per-property capital decisions to the Notion Property Register.
 *
 * @param entries  per-property capitalAction + priorityScore (subset of CapitalAllocationEntry)
 * @param notionToken  Notion integration token (process.env.NOTION_TOKEN); empty → throws
 * @param opts.asOf  snapshot asOf the decisions were computed from (echoed in the result)
 * @param opts.databaseId  override the target DB (tests); defaults to the Property Register
 * @param opts.fetchImpl  injectable fetch (tests); defaults to globalThis.fetch
 * @returns { synced, skipped, errors, asOf } — never rejects except on a missing token
 */
export async function syncCapitalActionsToNotion(
  entries: CapitalActionInput[],
  notionToken: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  if (!notionToken) throw new Error('notionToken is required');
  const dbId = opts.databaseId ?? PROPERTY_REGISTER_DB_ID;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  const result: SyncResult = { synced: 0, skipped: 0, errors: [], asOf: opts.asOf };

  // 1. Ensure the writeback properties exist (idempotent). A failure here is recorded but
  //    non-fatal — subsequent page writes would fail too and be tallied.
  const ensureErr = await ensureProperties(fetchImpl, notionToken, dbId);
  if (ensureErr) result.errors.push(ensureErr);

  // Nothing to write → return early (also avoids an unnecessary page query).
  if (entries.length === 0) return result;

  // 2. Build the title → pageId index. A query-stage failure is fail-open: every entry is
  //    then skipped (no page could be matched) and the error is recorded once.
  let index: Map<string, string>;
  try {
    index = await buildTitleIndex(fetchImpl, notionToken, dbId);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    result.skipped += entries.length;
    return result;
  }

  // 3. Match + write each entry. Per-page errors are isolated.
  for (const entry of entries) {
    const key = normalizeTitle(entry.propertyName);
    if (!key) {
      result.skipped += 1; // null/blank propertyName — cannot match
      continue;
    }
    const pageId = index.get(key);
    if (!pageId) {
      result.skipped += 1; // no Notion page with this title — fail-open, not an error
      continue;
    }
    try {
      await writePage(fetchImpl, notionToken, pageId, entry);
      result.synced += 1;
    } catch (e) {
      const label = entry.propertyName ?? pageId;
      result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
