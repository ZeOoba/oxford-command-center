import type { Deal, DealStage, Market } from '../../src/contracts/index';
import { slug } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';

/**
 * Live deals adapter (Phase 6) — Notion "Acquisition Pipeline Tracker" → Deal[].
 *
 * Behind the contract + graceful: with no NOTION_TOKEN (or on any error) it returns the seed
 * pipeline unchanged, so nothing breaks. When configured, it fetches Notion and MERGES onto the
 * seed by name.
 *
 * CONFIDENTIALITY (non-negotiable): the seed is the source of truth for the `confidential` flag.
 * Notion has no confidential property, so a matched deal inherits the seed flag (PRIMARY guard), and
 * a Notion-only deal is flagged if its name matches a configured pattern (secondary, defense in
 * depth — patterns come from env so no confidential identifier is hardcoded in the repo). The bake
 * redaction (deal.confidential) remains the final guard — a deal must never reach a public bake unflagged.
 */

// Verified via the Notion connection 2026-06-03: DB "Acquisition Pipeline Tracker".
const DEALS_DB_ID = process.env.NOTION_DEALS_DB ?? '46c8a5c6-8b37-4c53-a10d-0f55c97613e5';
// 2025-09-03 introduced multi-data-source databases; the old /databases/{id}/query 400s on them.
// We discover the DB's data source(s) and query /data_sources/{id}/query instead.
const NOTION_VERSION = process.env.NOTION_VERSION ?? '2025-09-03';

/**
 * Secondary safety net: a Notion-only deal whose name matches one of these (comma-separated,
 * case-insensitive) is flagged confidential. Configured via env so the identifier never lives in
 * source/VCS. Empty by default — the seed merge is the primary guard for known confidential deals.
 */
function isConfidentialByName(name: string): boolean {
  return (process.env.NOTION_CONFIDENTIAL_NAME_PATTERNS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => {
      try {
        return new RegExp(p, 'i').test(name);
      } catch {
        return false;
      }
    });
}

const MARKET_MAP: Record<string, Market> = {
  'Columbus OH': 'Columbus OH',
  'Indianapolis IN': 'Indianapolis IN',
  'Kansas City MO': 'Kansas City MO',
  'Mid-Atlantic': 'Mid-Atlantic',
  'Toledo OH': 'Toledo OH',
  'Cleveland OH': 'Cleveland MSA',
};
const STAGE_MAP: Record<string, DealStage> = {
  Candidate: 'Candidate',
  'LOI Pending': 'LOI/PSA',
  'LOI Executed': 'LOI/PSA',
  'Under Contract': 'Due Diligence',
  'Due Diligence': 'Due Diligence',
  Closing: 'Closing',
  'Closed Won': 'Closed',
  Passed: 'Dead',
};

const mapMarket = (s: string | null): Market | null => (s ? (MARKET_MAP[s] ?? 'Other') : null);
const mapStage = (s: string | null): DealStage => (s ? (STAGE_MAP[s] ?? 'Candidate') : 'Candidate');
/** Notion may store rates as 0.07 or 7 — normalize to a 0–1 decimal. */
const asRate = (n: number | null): number | null => (n === null ? null : n > 1.5 ? n / 100 : n);
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── Notion page → Deal (exported for tests) ────────────────────────────────────
interface NotionPage { properties?: Record<string, unknown> }
const title = (p: Record<string, unknown>, k: string): string => {
  const v = p[k] as { title?: Array<{ plain_text?: string }> } | undefined;
  return (v?.title ?? []).map((t) => t.plain_text ?? '').join('').trim();
};
const text = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  const s = (v?.rich_text ?? []).map((t) => t.plain_text ?? '').join('').trim();
  return s || null;
};
const num = (p: Record<string, unknown>, k: string): number | null => {
  const v = p[k] as { number?: number | null } | undefined;
  return typeof v?.number === 'number' ? v.number : null;
};
const select = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { select?: { name?: string } | null } | undefined;
  return v?.select?.name ?? null;
};

export function mapNotionPage(page: NotionPage): Deal | null {
  const p = page.properties ?? {};
  const name = title(p, 'Deal Name');
  if (!name) return null;
  return {
    id: `notion-${slug(name)}`,
    name,
    shortName: null,
    location: text(p, 'Address'),
    market: mapMarket(select(p, 'Market')),
    sf: num(p, 'Total SF'),
    buildings: null,
    stage: mapStage(select(p, 'Stage')),
    estPrice: num(p, 'Purchase Price'),
    capRate: asRate(num(p, 'Going-In Cap Rate')),
    irr: asRate(num(p, 'Levered IRR')),
    equityMultiple: num(p, 'Equity Multiple'),
    holdYrs: null,
    lender: text(p, 'Lender'),
    status: select(p, 'PSA Status'),
    nextAction: text(p, 'Next Action'),
    owner: text(p, 'Deal Owner'),
    confidential: isConfidentialByName(name),
    estimatedFields: [],
  };
}

/**
 * Merge live Notion deals onto the seed. The seed is the confidential-flag source of truth:
 * a Notion deal matched by name enriches the seed record (live fields win) but KEEPS the seed id,
 * confidential flag, and shortName. Unmatched Notion deals are added (confidential via keyword
 * guard). Seed deals absent from Notion are retained (their flags intact).
 */
export function mergeDeals(seed: Deal[], notion: Deal[]): Deal[] {
  const notionByName = new Map(notion.map((d) => [normName(d.name), d]));
  const used = new Set<string>();
  const merged = seed.map((s) => {
    const live = notionByName.get(normName(s.name));
    if (!live) return s;
    used.add(normName(s.name));
    const pick = <T>(a: T, b: T): T => (a !== null && a !== undefined ? a : b);
    return {
      ...s,
      location: pick(live.location, s.location),
      market: pick(live.market, s.market),
      sf: pick(live.sf, s.sf),
      stage: live.stage,
      estPrice: pick(live.estPrice, s.estPrice),
      capRate: pick(live.capRate, s.capRate),
      irr: pick(live.irr, s.irr),
      equityMultiple: pick(live.equityMultiple, s.equityMultiple),
      lender: pick(live.lender, s.lender),
      nextAction: pick(live.nextAction, s.nextAction),
      owner: pick(live.owner, s.owner),
      status: pick(live.status, s.status),
      // id, shortName, confidential, buildings, holdYrs preserved from the seed.
    };
  });
  const extras = notion.filter((d) => !used.has(normName(d.name)));
  return [...merged, ...extras];
}

const NOTION = 'https://api.notion.com/v1';
const notionHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'notion-version': NOTION_VERSION,
  'content-type': 'application/json',
});

/** Resolve the deals database's data source id(s). Env override skips the discovery call. */
async function resolveDataSourceIds(token: string): Promise<string[]> {
  const override = process.env.NOTION_DEALS_DATA_SOURCE;
  if (override) return override.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch(`${NOTION}/databases/${DEALS_DB_ID}`, { headers: notionHeaders(token) });
  if (!res.ok) throw new Error(`Notion db ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const db = (await res.json()) as { data_sources?: Array<{ id?: string }> };
  return (db.data_sources ?? []).map((d) => d.id).filter((x): x is string => !!x);
}

/**
 * Fetch the Notion deals DB (all pages across its data sources). Throws on non-ok so callers can
 * fall back. Non-deal rows (no "Deal Name" title) map to null and are skipped, so querying every
 * data source is safe; results are de-duplicated by id.
 */
async function fetchNotionDeals(token: string): Promise<Deal[]> {
  const dataSourceIds = await resolveDataSourceIds(token);
  if (!dataSourceIds.length) throw new Error('Notion: no data sources on deals database');
  const byId = new Map<string, Deal>();
  for (const dsId of dataSourceIds) {
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${NOTION}/data_sources/${dsId}/query`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
      });
      if (!res.ok) throw new Error(`Notion ds ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = (await res.json()) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string };
      for (const page of data.results ?? []) {
        const d = mapNotionPage(page);
        if (d) byId.set(d.id, d);
      }
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  return [...byId.values()];
}

/** The deals source: live Notion (merged onto seed) when configured, else the seed pipeline. */
export async function loadDeals(): Promise<Deal[]> {
  const token = process.env.NOTION_TOKEN;
  if (!token) return SEED_DEALS;
  try {
    const notion = await fetchNotionDeals(token);
    return notion.length ? mergeDeals(SEED_DEALS, notion) : SEED_DEALS;
  } catch (e) {
    console.warn(`[notion-deals] live fetch failed, using seed: ${e instanceof Error ? e.message : String(e)}`);
    return SEED_DEALS;
  }
}
