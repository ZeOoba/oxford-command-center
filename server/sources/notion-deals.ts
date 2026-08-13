import type { DataQualityFlag, Deal, DealStage, Market } from '../../src/contracts/index';
import { slug } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { dealJoinKey } from './deal-name';

import { isDeclassified } from './deal-declassification';

/**
 * A short, stable, NON-IDENTIFYING digest, for flag text that would otherwise carry a deal NAME.
 *
 * These flags flow into snapshot.dataQuality, which scripts/bake-mirror.ts publishes to the PUBLIC
 * brain.oxfordra.net payload (it gates only on `degraded`) and which redactConfidential explicitly
 * does NOT sweep. Naming a deal here would put it on an external surface: Hard Invariant 3. The
 * digest is enough to correlate a published flag with the console.warn beside it, which keeps the
 * real name LOCAL. FNV-1a rather than node:crypto so this module stays safe for any bundle that
 * reaches it. (Refute pass on the C1/H1 fix, 2026-08-11 — CRITICAL.)
 *
 * SCOPE NARROWED 2026-08-12. Under the name join, EVERY flag had to be digested, and the fourth
 * refute pass then found the operator could not resolve an 8-hex digest back to a deal without
 * hand-computing FNV-1a. A Notion Deal ID ("DEAL-7") is opaque and non-identifying by construction,
 * so id-keyed flags now name the id DIRECTLY and are actionable as published. This remains only for
 * the one flag keyed on something derived from a name: the seed side of the migration tripwire.
 */
function keyDigest(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

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
 * The Notion property holding the join key: a native Unique ID column on the Acquisition Pipeline
 * Tracker. Named via env so a rename in Notion is a config change rather than a code change — but
 * note that a rename still fails CLOSED (every row reads idless, every row is held out and defaults
 * confidential, and the aggregate error flag blocks the write), never silently.
 */
const DEAL_ID_PROP = process.env.NOTION_DEALS_ID_PROP ?? 'Deal ID';

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
/**
 * Notion's Unique ID value, rendered "<prefix>-<number>" (bare number when the column has no
 * prefix). Returns null when the property is absent or malformed — which means UNJOINABLE, and is
 * handled as a refusal by mergeDeals rather than as a licence to match on the name.
 */
const uniqueId = (p: Record<string, unknown>, k: string): string | null => {
  const v = p[k] as { unique_id?: { prefix?: string | null; number?: number | null } } | undefined;
  const n = v?.unique_id?.number;
  if (typeof n !== 'number') return null;
  const prefix = v?.unique_id?.prefix;
  return prefix ? `${prefix}-${n}` : String(n);
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
    notionDealId: uniqueId(p, DEAL_ID_PROP),
    // A stage-schema drift (unmapped Notion select option) no longer needs a special guard here:
    // mergeDeals defaults EVERY unmatched deal confidential regardless of stage (2026-07-16 policy
    // widening), which subsumes it — this mapper only needs the keyword-name guard.
    confidential: isConfidentialByName(name),
    estimatedFields: [],
  };
}

/**
 * Merge live Notion deals onto the seed, joining on the Notion Deal ID.
 *
 * A matched deal enriches the seed record (live fields win) but KEEPS the seed id, confidential
 * flag, and shortName. Unmatched Notion deals are added, defaulting confidential. Seed deals absent
 * from Notion are retained with their flags intact.
 *
 * WHY AN OPAQUE ID AND NOT A NAME (2026-08-12). This join used to key on `dealJoinKey`: strip
 * Notion's "<Name> — <City>, <ST>" tail, lowercase, collapse punctuation. That tail exists PRECISELY
 * because bare street names repeat across metros, so the key deleted its own disambiguator — and
 * confidentiality rides on this join, because a wrong merge folds an unmatched (fail-closed
 * confidential) row into a public seed record: Hard Invariant 3.
 *
 * Four adversarial passes over 2026-08-11/12 found, in this subsystem alone, a CRITICAL cross-side
 * wrong merge with executed repros, an alias path that bypassed the guard written to contain it,
 * corroboration inert for the MAJORITY of live rows, and a degenerate acceptance key that
 * grandfathered every future collision. Each fix bolted on another corroboration signal (mapped
 * market → locality tail → literal equality). That is the signature of a wrong primitive, not of
 * unlucky bugs: three of those defects shared one shape — a guard stated over a MECHANISM rather
 * than the INVARIANT — which kept recurring because "same deal" has no ground truth in a name.
 *
 * Notion's Unique ID is that ground truth. It is assigned by Notion, READ-ONLY at the source, and
 * unaffected by renames, locality suffixes, aliases, and punctuation. So there is nothing left to
 * corroborate, and the corroboration machinery (MARKET_STATES, isRealMarket, localityStateOf,
 * exactNameMatch) is gone rather than merely satisfied.
 *
 * FAIL CLOSED. A missing or duplicated id REFUSES; it never falls back to matching on the name. A
 * refusal leaves the seed unenriched and lets the live row fall through to `extras`, where the
 * fail-closed confidential default applies — nothing is destroyed in either direction, and the
 * error-severity flag blocks the write until a human adjudicates.
 */
export function mergeDeals(seed: Deal[], notion: Deal[], flags: DataQualityFlag[] = []): Deal[] {
  // ── Seed-side ambiguity ───────────────────────────────────────────────────────────────────────
  // Two seed rows claiming one live row made one of them merge it while the other "refused" it,
  // with the refusal text asserting the live row had been kept separate when it had been merged.
  // Ambiguous on the seed side is unmergeable on the seed side. (PR #271, fourth pass.)
  const seedIdCounts = new Map<string, number>();
  for (const s of seed) {
    if (s.notionDealId) seedIdCounts.set(s.notionDealId, (seedIdCounts.get(s.notionDealId) ?? 0) + 1);
  }
  const ambiguousSeedIds = new Set([...seedIdCounts].filter(([, n]) => n > 1).map(([id]) => id));
  for (const id of ambiguousSeedIds) {
    console.warn(
      `[notion-deals] ${seedIdCounts.get(id)} seed rows claim Deal ID '${id}': ` +
        seed.filter((s) => s.notionDealId === id).map((s) => `'${s.name}'`).join(', ') +
        ' — none can claim the live row.',
    );
    flags.push({
      entity: 'deals',
      field: 'notionDealId',
      issue:
        `${seedIdCounts.get(id)} seed deal records carry Deal ID ${id}, so no live pipeline row can ` +
        `be attributed to one of them unambiguously. All of them are left unenriched rather than ` +
        `guessing. Fix the duplicated notionDealId in src/data/seed-deals.ts.`,
      rawValue: id,
      severity: 'error',
    });
  }

  // ── Live-side ambiguity and absence ───────────────────────────────────────────────────────────
  // Notion's Unique ID cannot duplicate, so a duplicate here means the seed mirror or a fixture is
  // wrong — still refused rather than trusted. An idless row means the Deal ID property is missing,
  // renamed, or not shared with the integration: refuse, never name-match.
  const liveById = new Map<string, Deal>();
  const collidingIds = new Set<string>();
  const idless: Deal[] = [];
  for (const d of notion) {
    if (!d.notionDealId) {
      idless.push(d);
      continue;
    }
    if (liveById.has(d.notionDealId)) collidingIds.add(d.notionDealId);
    else liveById.set(d.notionDealId, d);
  }
  for (const id of collidingIds) {
    liveById.delete(id);
    console.warn(
      `[notion-deals] Deal ID collision on '${id}': ` +
        notion.filter((d) => d.notionDealId === id).map((d) => `'${d.name}'`).join(', ') +
        ' — all held out of the seed merge and defaulting confidential.',
    );
    flags.push({
      entity: 'deals',
      field: 'notionDealId',
      issue:
        `${notion.filter((d) => d.notionDealId === id).length} live pipeline rows carry Deal ID ${id}. ` +
        `Notion assigns Unique IDs and never repeats one, so this is a data defect rather than an ` +
        `operator choice — no acceptance escape hatch is offered. Every row carrying it is held out ` +
        `of the merge and defaults confidential; nothing was dropped, but any seed row for this id ` +
        `is presenting SEED values rather than live ones.`,
      rawValue: id,
      severity: 'error',
    });
  }
  if (idless.length > 0) {
    // ONE flag, not one per row: a deleted or renamed Deal ID property makes every row idless at
    // once, and twenty identical flags bury the cause. The count IS the diagnostic.
    console.warn(
      `[notion-deals] ${idless.length} live pipeline row(s) carry no Deal ID: ` +
        idless.map((d) => `'${d.name}'`).join(', '),
    );
    flags.push({
      entity: 'deals',
      field: 'notionDealId',
      issue:
        `${idless.length} live pipeline row(s) carry no "${DEAL_ID_PROP}" value, so they cannot be ` +
        `joined to a seed record. They are held out of the merge and default confidential — the ` +
        `join REFUSES rather than falling back to matching on the deal name, which is the defect ` +
        `class this key replaced. If every row is listed, the "${DEAL_ID_PROP}" property has been ` +
        `renamed, deleted, or is not shared with the integration.`,
      rawValue: String(idless.length),
      severity: 'error',
    });
  }

  // Staleness tripwire (policy item 3, 2026-07-16): a seed-matched deal keeps its seed
  // confidential:false forever (the intended escape hatch) even as the live stage advances into
  // an active acquisition stage — non-blocking, logs only, never flips the flag or throws.
  const ACTIVE_STAGES: ReadonlySet<Deal['stage']> = new Set(['LOI/PSA', 'Due Diligence', 'Closing']);
  const usedIds = new Set<string>();
  const unjoinedSeeds: Deal[] = [];
  const merged = seed.map((s) => {
    if (!s.notionDealId || ambiguousSeedIds.has(s.notionDealId)) {
      if (!s.notionDealId) unjoinedSeeds.push(s);
      return s;
    }
    const live = liveById.get(s.notionDealId);
    if (!live) {
      // Legitimate steady state — a seed deal that is not in the live pipeline (closed, dead, or
      // never tracked there). Erroring here would block every write with no remedy short of
      // deleting the seed row; the tripwire below catches the case that is actually a mistake.
      unjoinedSeeds.push(s);
      return s;
    }

    usedIds.add(s.notionDealId);
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
      // id, name, shortName, confidential, notionDealId, buildings, holdYrs preserved from the seed.
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
    .filter((d) => !d.notionDealId || !usedIds.has(d.notionDealId))
    .map((d) => (d.confidential ? d : { ...d, confidential: !isDeclassified(d) }));

  // ── Migration tripwire ────────────────────────────────────────────────────────────────────────
  // The one job names still have, and it is DETECTION ONLY — a name never causes a merge here.
  //
  // Without this, forgetting to mirror one Deal ID into seed-deals.ts degrades SILENTLY: the seed
  // publishes its own stale economics as if they were the live pipeline (post-847a17c seeds carry
  // null economics and a hand-set stage), while the live row quietly becomes a confidential extra.
  // That is the same silent-unenrichment failure PR #271 called out, reached by a new route.
  //
  // It runs HERE rather than in reconcile-runtime's near-duplicate check, which it replaces: that
  // check ran over the MERGED output, where a wrong merge leaves exactly one row and is therefore
  // structurally invisible to it. This runs inside the joiner, which knows precisely which rows
  // failed to join — the "a detector that can miss what the joiner already knows is worse than no
  // detector" lesson from the H1 fix, applied one layer earlier.
  for (const s of unjoinedSeeds) {
    const key = dealJoinKey(s.name);
    if (!key) continue;
    for (const live of extras) {
      if (dealJoinKey(live.name) !== key) continue;
      console.warn(
        `[notion-deals] MIGRATION GAP: seed '${s.name}' and live row '${live.name}' look like one ` +
          `deal, but they are not joined (seed Deal ID ${s.notionDealId ?? 'unset'}, live ` +
          `${live.notionDealId ?? 'unset'}).`,
      );
      flags.push({
        entity: 'deals',
        field: 'notionDealId',
        issue:
          `a seed record and live pipeline row ${live.notionDealId ?? '(no Deal ID)'} have matching ` +
          `names but no shared Deal ID, so they published as TWO rows for what looks like one deal ` +
          `— the seed showing its own stale figures rather than the live ones. They were NOT merged: ` +
          `names are evidence that something needs attention here, never grounds for a merge. Set ` +
          `notionDealId on the matching row in src/data/seed-deals.ts (seed digest ` +
          `${keyDigest(key)}; the names are in the server log, not here — these flags reach the ` +
          `public mirror).`,
        rawValue: live.notionDealId ?? keyDigest(key),
        severity: 'warn',
      });
    }
  }

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

const QUERY_PAGE_SIZE = 100;
/** Page-walk bound. Hitting it with `has_more` still true is a truncation, and is thrown, not
 *  silently accepted -- see the check at the end of the per-data-source loop. */
const MAX_QUERY_PAGES = 5;

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
    let exhausted = false;
    for (let i = 0; i < MAX_QUERY_PAGES; i++) {
      const res = await fetch(`${NOTION}/data_sources/${dsId}/query`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify(
          cursor
            ? { page_size: QUERY_PAGE_SIZE, start_cursor: cursor }
            : { page_size: QUERY_PAGE_SIZE },
        ),
      });
      if (!res.ok) throw new Error(`Notion ds ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const data = (await res.json()) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string };
      for (const page of data.results ?? []) {
        const d = mapNotionPage(page);
        if (d) byId.set(d.id, d);
      }
      if (!data.has_more || !data.next_cursor) {
        exhausted = true;
        break;
      }
      cursor = data.next_cursor;
    }
    // Falling out of the loop with Notion still saying `has_more` means the page cap truncated the
    // result. Throwing (rather than returning the partial set) routes this into loadDeals' catch as
    // a `fetch-failed` degradation, which raises an error-severity flag both CLI gates and
    // Brain.persist refuse to write on. Returning a partial set instead would reproduce the
    // 2026-08-09 movement-gate false signal at smaller amplitude -- a shrunken deal set, no
    // degradation, exit 0. A truncated fetch loses live data, so it degrades like one.
    // (2026-08-11 integrity sweep, L5.)
    if (!exhausted) {
      throw new Error(
        `Notion deals pagination cap reached (${MAX_QUERY_PAGES} pages x ${QUERY_PAGE_SIZE} rows) on ` +
          `data source ${dsId} while has_more was still true — the result would be silently truncated`,
      );
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

export type DealsLoad = {
  deals: Deal[];
  degraded: DealsDegradation | null;
  /**
   * Data-quality flags raised by the MERGE itself: duplicated or missing Deal IDs (error, the join
   * refused) and migration gaps (warn). Separate from `degraded`, which describes the FETCH.
   *
   * The error-severity ones make evaluateReconciliationGate refuse the write until a human fixes
   * the ids. The joiner raises them itself rather than logging to the console and delegating to a
   * downstream detector — a detector that can miss what the joiner already knows is worse than no
   * detector. (Catch-up sweep 2026-07-28..08-04, C1 + H1; carried through the id join 2026-08-12.)
   */
  flags: DataQualityFlag[];
};

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
    return { deals: SEED_DEALS, degraded: { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' }, flags: [] };
  }
  try {
    const notion = await fetchNotionDeals(token);
    if (!notion.length) {
      // A configured token returning zero deals is anomalous, not a legitimately empty pipeline:
      // it wipes the live set exactly like a thrown fetch does, so it degrades identically.
      console.warn('[notion-deals] live fetch returned 0 deals, using seed');
      return { deals: SEED_DEALS, degraded: { reason: 'empty-result', detail: 'Notion returned 0 deals for a configured token' }, flags: [] };
    }
    const flags: DataQualityFlag[] = [];
    const deals = mergeDeals(SEED_DEALS, notion, flags);
    return { deals, degraded: null, flags };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[notion-deals] live fetch failed, using seed: ${detail}`);
    return { deals: SEED_DEALS, degraded: { reason: 'fetch-failed', detail }, flags: [] };
  }
}
