import type { DataQualityFlag, Deal, DealStage, Market } from '../../src/contracts/index';
import { slug } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { dealJoinKey } from './deal-name';
import { isDeclassified } from './deal-declassification';

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
/**
 * The seed↔Notion match key. Notion names rows "<Deal Name> — <City>, <ST>" while the seed uses the
 * bare name; dealJoinKey normalizes that anchored suffix away so the two sides join instead of
 * double-listing (2026-08-04 — see server/sources/deal-name.ts for why this is deterministic and
 * not a similarity match).
 */
const normName = dealJoinKey;

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
  // COLLISION GUARD (review 2026-08-04, CRITICAL). `new Map(notion.map(...))` is a silent-drop
  // primitive: two Notion rows sharing a key keep only the LAST, and if a seed row also matches that
  // key both collide into `usedKeys` and neither reaches `extras` — one real deal disappears from
  // the snapshot with no flag, wearing the other's economics under the seed's (possibly public)
  // confidential flag. Because dealJoinKey strips the locality tail, and the locality is exactly how
  // Notion disambiguates same-named assets across metros ("X — Columbus, OH" vs "X — Louisville,
  // KY"), this collision is reachable in normal operation rather than exotic.
  //
  // A colliding key is therefore treated as UNMERGEABLE: every row carrying it is withheld from the
  // seed join and falls through to `extras`, where the fail-closed confidential default applies.
  // Nothing is dropped, and the surviving rows share a join key, so findNearDuplicateNames pairs
  // them and checkSnapshot blocks the gate — a loud duplicate instead of silent data loss.
  const notionByKey = new Map<string, Deal>();
  const collidingKeys = new Set<string>();
  for (const d of notion) {
    const k = keyOf(d.name);
    if (notionByKey.has(k)) collidingKeys.add(k);
    else notionByKey.set(k, d);
  }
  for (const k of collidingKeys) {
    notionByKey.delete(k);
    console.warn(
      `[notion-deals] join-key collision on '${k}' — multiple Notion deals normalize to the same ` +
        `key. All of them are held out of the seed merge and default confidential; ` +
        `checkSnapshot's near-duplicate flag will block the gate until the names are disambiguated.`,
    );
  }
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
  // unmatched deal public, either add it to seed-deals.ts with confidential: false (the seed stays
  // the flag's source of truth for seed-matched deals) or, for a deal that never needs a seed row,
  // add its id to src/data/public-deals.ts — see below.
  // The ONE exit from that default (Defect 1b, 2026-08-04): an id explicitly listed in
  // src/data/public-deals.ts AND cleared by the live confidential-terms roster. isDeclassified
  // fails closed on an unreadable roster, so the default above still holds in every ambiguous case.
  const extras = notion
    .filter((d) => !usedKeys.has(keyOf(d.name)))
    .map((d) => (d.confidential ? d : { ...d, confidential: !isDeclassified(d) }));
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

/**
 * Why the seed fallback has to be REPORTED, not just logged (2026-08-09 regression):
 *
 * This function degrading to SEED_DEALS is correct for a live server (the UI keeps rendering), but
 * catastrophic for a snapshot WRITER -- the seed is ~6 placeholder deals against a ~20-deal live
 * pipeline, so a silent fallback rewrites portfolio.json's deals/counterparties with placeholders
 * (estPrice → null, location → "TBD", stage flips) while the run still exits 0. That happened on
 * 2026-08-09 07:40 ET: one transient `fetch failed` produced deals 20 → 6 and counterparties 15 → 14,
 * which ora-lease-snapshot-refresh's material-change gate read as genuine portfolio movement and,
 * under that morning's auto-push directive, would have published to origin/main unattended and
 * unalarmed (Exit 0 suppresses both the Notion post and the email).
 *
 * The old signature (`Promise<Deal[]>`) made that unrepresentable: callers could not distinguish
 * "Notion is genuinely seed-only" from "the fetch blew up". Callers now get the reason, and
 * parse.ts turns the data-losing reasons into an error-severity dataQuality flag -- which
 * evaluateReconciliationGate (PR #252) already refuses to write on, in BOTH CLI writers. That
 * converts a silent Exit-0 corruption into a loud Exit-1 alarm on the existing routing.
 */
export type DealsDegradation = {
  /** `not-configured` is intentional (no token); the other two are failures that lose live data. */
  reason: 'not-configured' | 'fetch-failed' | 'empty-result';
  detail: string;
};

export type DealsLoad = { deals: Deal[]; degraded: DealsDegradation | null };

/**
 * Maps a degradation to the dataQuality flag the reconciliation gate acts on, or null when there is
 * nothing to raise. `not-configured` returns null deliberately: a developer running without a
 * NOTION_TOKEN is a supported mode, and flagging it would make the dev server permanently "dirty".
 * The snapshot writers close that hole separately (see requireLiveDealsSource) -- writer policy
 * belongs in the writers, not in a source adapter shared with the live server.
 */
export function dealsDegradationFlag(
  degraded: DealsDegradation | null,
  seedCount: number,
): DataQualityFlag | null {
  if (!degraded || degraded.reason === 'not-configured') return null;
  return {
    entity: 'deals',
    field: 'pipeline',
    issue:
      `Notion deals pipeline unavailable (${degraded.reason}) — the deals/counterparties sections ` +
      `would be written from the ${seedCount}-deal seed placeholder set, wiping the live pipeline. ` +
      `Refusing rather than publishing placeholders. Cause: ${degraded.detail}`,
    severity: 'error',
  };
}

/**
 * True when a snapshot's flags carry the data-losing deals degradation above. Used by the live
 * server's mirror write (Brain.persist), which is a THIRD writer of portfolio.json and deliberately
 * does NOT run evaluateReconciliationGate -- it appends flags and keeps serving, correct for a UI
 * but not for the shared git-tracked mirror. Without this, a server refreshing during a Notion
 * outage would write the seed placeholders straight past both CLI writers' gates.
 */
export function hasDealsPipelineFailure(flags: readonly DataQualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'error' && f.entity === 'deals' && f.field === 'pipeline');
}

/** The deals source: live Notion (merged onto seed) when configured, else the seed pipeline. */
export async function loadDeals(): Promise<DealsLoad> {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return { deals: SEED_DEALS, degraded: { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' } };
  }
  try {
    const notion = await fetchNotionDeals(token);
    if (!notion.length) {
      // A configured token returning zero deals is anomalous, not a legitimately empty pipeline:
      // it wipes the live set exactly like a thrown fetch does, so it degrades identically.
      console.warn('[notion-deals] live fetch returned 0 deals, using seed');
      return { deals: SEED_DEALS, degraded: { reason: 'empty-result', detail: 'Notion returned 0 deals for a configured token' } };
    }
    return { deals: mergeDeals(SEED_DEALS, notion), degraded: null };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[notion-deals] live fetch failed, using seed: ${detail}`);
    return { deals: SEED_DEALS, degraded: { reason: 'fetch-failed', detail } };
  }
}
