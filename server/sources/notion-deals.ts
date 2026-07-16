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
const dateProp = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { date?: { start?: string | null } | null } | undefined;
  return v?.date?.start ?? null;
};

export function mapNotionPage(page: NotionPage): Deal | null {
  const p = page.properties ?? {};
  const name = title(p, 'Deal Name');
  if (!name) return null;
  const rawStage = select(p, 'Stage');
  return {
    id: `notion-${slug(name)}`,
    name,
    shortName: null,
    location: text(p, 'Address'),
    market: mapMarket(select(p, 'Market')),
    sf: num(p, 'Total SF'),
    buildings: null,
    stage: mapStage(rawStage),
    estPrice: num(p, 'Purchase Price'),
    capRate: asRate(num(p, 'Going-In Cap Rate')),
    irr: asRate(num(p, 'Levered IRR')),
    equityMultiple: num(p, 'Equity Multiple'),
    holdYrs: null,
    lender: text(p, 'Lender'),
    status: select(p, 'PSA Status'),
    nextAction: text(p, 'Next Action'),
    owner: text(p, 'Deal Owner'),
    targetCloseDate: dateProp(p, 'Target Close Date'),
    // A stage-schema drift (unmapped Notion select option) no longer needs a special guard here:
    // mergeDeals defaults EVERY unmatched deal confidential regardless of stage (2026-07-16 policy
    // widening), which subsumes it — this mapper only needs the keyword-name guard.
    confidential: isConfidentialByName(name),
    estimatedFields: [],
  };
}

/**
 * Optional Notion→seed name aliases so a deal recorded under a different name in Notion still merges
 * into its seed record instead of double-listing. Format: "Notion Name=>Seed Name" pairs separated
 * by ';' or newlines. Configured via env so confidential deal names never live in the repo.
 * Exported + injectable for tests.
 */
export function parseNameAliases(raw: string = process.env.NOTION_DEALS_NAME_ALIASES ?? ''): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of raw.split(/[;\n]+/)) {
    const idx = pair.indexOf('=>');
    if (idx < 0) continue;
    const from = normName(pair.slice(0, idx));
    const to = normName(pair.slice(idx + 2));
    if (from && to) m.set(from, to);
  }
  return m;
}

/**
 * Merge live Notion deals onto the seed. The seed is the confidential-flag source of truth:
 * a Notion deal matched by name (or via an alias) enriches the seed record (live fields win) but
 * KEEPS the seed id, confidential flag, and shortName. Unmatched Notion deals are added (confidential
 * via keyword guard). Seed deals absent from Notion are retained (their flags intact).
 */
export function mergeDeals(seed: Deal[], notion: Deal[], aliases: Map<string, string> = parseNameAliases()): Deal[] {
  // A Notion deal's match key is its aliased seed name when an alias exists, else its own name.
  const keyOf = (name: string): string => aliases.get(normName(name)) ?? normName(name);
  const notionByKey = new Map(notion.map((d) => [keyOf(d.name), d]));
  const usedKeys = new Set<string>();
  // Staleness tripwire (policy item 3, 2026-07-16): a seed-matched deal keeps its seed
  // confidential:false forever (the intended escape hatch) even as the live stage advances into
  // an active acquisition stage — non-blocking, logs only, never flips the flag or throws.
  const ACTIVE_STAGES: ReadonlySet<Deal['stage']> = new Set(['LOI/PSA', 'Due Diligence', 'Closing']);
  const merged = seed.map((s) => {
    const k = normName(s.name);
    const live = notionByKey.get(k);
    if (!live) return s;
    usedKeys.add(k);
    if (!s.confidential && ACTIVE_STAGES.has(live.stage)) {
      console.warn(`[notion-deals] seed staleness: ${s.id} is confidential:false but live stage is now '${live.stage}' — re-confirm the seed flag is still correct.`);
    }
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
      targetCloseDate: pick(live.targetCloseDate, s.targetCloseDate),
      status: pick(live.status, s.status),
      // id, shortName, confidential, buildings, holdYrs preserved from the seed.
    };
  });
  // Fail-closed (I9, Hard Invariant 3 — widened 2026-07-16 policy review): EVERY unmatched
  // Notion-only deal defaults confidential, regardless of stage. A pre-LOI Candidate already
  // carries identifying data (address/price/lender) and an unmatched deal must not auto-publish
  // the moment it reaches 'Closed Won' (surviving NDA/price-confidentiality risk) — redaction must
  // not depend on the optional NOTION_CONFIDENTIAL_NAME_PATTERNS env being set. To make an
  // unmatched deal public, add it to seed-deals.ts with confidential: false (the seed stays the
  // flag's source of truth).
  const extras = notion
    .filter((d) => !usedKeys.has(keyOf(d.name)))
    .map((d) => (d.confidential ? d : { ...d, confidential: true }));
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
