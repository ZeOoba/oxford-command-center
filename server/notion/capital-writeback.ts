// server/notion/capital-writeback.ts
//
// Direction 1 — Notion Writeback for the Capital Allocation engine.
//
// Pushes per-property capital decisions (allocation action + priorityScore) back to the Notion
// 🏢 Property Register so they surface in the operational workflow.
//
// ADVISORY (ruling 2026-11-13): an advisoryOnly verdict is written as "<action> (advisory)", never as
// the bare action, so the register never shows a verdict resting on an unratified constant as final.
//
// VOCABULARY (audit 2026-10-13 G5): the action written is the 5-way allocation-engine verdict
// (buildPortfolioAllocation → AllocationVerdict.action: buy | hold | sell | refinance | improve) —
// the SAME source the Capital page and the IC memo render. It previously wrote the legacy 4-way
// scores.ts capitalAction (invest | hold | monitor | disposition-candidate), so Notion could say
// "invest" while the IC memo said "hold". priorityScore still comes from the CapitalAllocationReport.
// The "Capital Action" select keeps the legacy option names declared alongside the 5-way ones, so
// existing rows holding a legacy value are not invalidated. A row is overwritten ONLY when its
// property gets an allocation verdict on a sync. A matched property with NO allocation verdict is
// not written (no guessed value), so its Notion page KEEPS its prior — possibly legacy, now stale —
// Capital Action and Priority Score; the sync result counts those in `skippedNoVerdict` (refute H5)
// so the caller can see how many Notion rows are stale rather than assuming every row was refreshed. Read-from-Notion (query pages) + write-to-Notion (PATCH pages) only —
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

import type { AllocationAction, PortfolioAllocation } from '../../src/contracts/capital';
import type { CapitalAllocationEntry } from '../../src/contracts/capital-allocation';

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

/** One property's writeback row: the 5-way allocation action + the report's priorityScore.
 *  allocationAction is null when the allocation engine produced no verdict for the property —
 *  such an entry is SKIPPED (never written with a guessed or legacy value). */
export interface CapitalActionInput {
  propertyName: string | null;
  allocationAction: AllocationAction | null;
  priorityScore: number;
  /** The verdict is advisoryOnly (it rests on an unratified constant, or the hurdle is proposed).
   *  Written as "<action> (advisory)" so the register never shows it as a final Capital Action
   *  (ruling 2026-11-13; refute wf_c69b93c5-c15). Absent = false. */
  advisory?: boolean;
}

/** 5-way allocation vocabulary (src/contracts/capital.ts AllocationAction) — what this writeback writes. */
const ALLOCATION_OPTIONS: ReadonlyArray<{ name: AllocationAction; color: string }> = [
  { name: 'buy', color: 'blue' },
  { name: 'hold', color: 'default' },
  { name: 'sell', color: 'red' },
  { name: 'refinance', color: 'purple' },
  { name: 'improve', color: 'green' },
];
/** Advisory twin of each 5-way value: what an advisoryOnly verdict is written as (ruling 2026-11-13). */
const ADVISORY_SUFFIX = ' (advisory)';
const ADVISORY_OPTIONS: ReadonlyArray<{ name: string; color: string }> = ALLOCATION_OPTIONS.map((o) => ({
  name: `${o.name}${ADVISORY_SUFFIX}`,
  color: 'yellow',
}));
/** Legacy 4-way values ('hold' is shared) — still DECLARED so existing rows keep a valid option until
 *  their next sync overwrites them. Never written by this module any more. */
const LEGACY_OPTIONS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'invest', color: 'green' },
  { name: 'monitor', color: 'yellow' },
  { name: 'disposition-candidate', color: 'red' },
];

/**
 * Build the writeback rows from the 5-way allocation engine (single source of the action) joined by
 * propertyId to the CapitalAllocationReport (property name + priorityScore). The portfolio-level
 * pipeline buy verdict (propertyId 'pipeline:<candidateId>') is not an owned property and never
 * matches a report entry. A report entry with no allocation verdict gets allocationAction = null.
 */
export function buildCapitalWritebackEntries(
  portfolio: { verdicts: ReadonlyArray<Pick<PortfolioAllocation['verdicts'][number], 'propertyId' | 'action' | 'advisoryOnly'>> },
  entries: ReadonlyArray<Pick<CapitalAllocationEntry, 'propertyId' | 'propertyName' | 'priorityScore'>>,
): CapitalActionInput[] {
  const byProperty = new Map<string, { action: AllocationAction; advisory: boolean }>();
  for (const v of portfolio.verdicts) {
    if (v.propertyId.startsWith('pipeline:')) continue;
    byProperty.set(v.propertyId, { action: v.action, advisory: v.advisoryOnly === true });
  }
  return entries.map((e) => {
    const hit = byProperty.get(e.propertyId);
    return {
      propertyName: e.propertyName,
      allocationAction: hit?.action ?? null,
      priorityScore: e.priorityScore,
      advisory: hit?.advisory ?? false,
    };
  });
}

export interface SyncResult {
  synced: number;
  /** No matching Notion page (or a blank property name) — nothing in Notion for this property. */
  skipped: number;
  /** Matched a Notion page but the allocation engine had no verdict: NOT written, so that page's
   *  prior Capital Action / Priority Score remain in Notion and are stale (refute H5). */
  skippedNoVerdict: number;
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
              // 5-way values first, then the legacy ones retained (see module header).
              options: [...ALLOCATION_OPTIONS, ...ADVISORY_OPTIONS, ...LEGACY_OPTIONS],
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
  entry: CapitalActionInput & { allocationAction: AllocationAction },
): Promise<void> {
  const res = await notionFetch(fetchImpl, `${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        [ACTION_PROP]: { select: { name: entry.advisory ? `${entry.allocationAction}${ADVISORY_SUFFIX}` : entry.allocationAction } },
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
 * @param entries  per-property 5-way allocationAction + priorityScore (see buildCapitalWritebackEntries)
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

  const result: SyncResult = { synced: 0, skipped: 0, skippedNoVerdict: 0, errors: [], asOf: opts.asOf };

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
    const allocationAction = entry.allocationAction;
    if (allocationAction === null) {
      // Never write a guessed value — but the page's prior values are now stale; count it apart.
      result.skippedNoVerdict += 1;
      continue;
    }
    try {
      await writePage(fetchImpl, notionToken, pageId, { ...entry, allocationAction });
      result.synced += 1;
    } catch (e) {
      const label = entry.propertyName ?? pageId;
      result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
