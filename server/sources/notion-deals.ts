import type { DataQualityFlag, Deal, DealStage, Market } from '../../src/contracts/index';
import { slug } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { dealJoinKey, findDuplicateDealRows, keyDigest } from './deal-name';

import { isDeclassified, rosterClaimsDeal } from './deal-declassification';
import { PUBLIC_DEAL_IDS } from '../../src/data/public-deals';

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

/**
 * Notion "Market" select value → the Market enum. KEYS MUST BE STRINGS NOTION CAN ACTUALLY EMIT;
 * anything else falls through to 'Other', which is not evidence of location, only of a missing entry.
 *
 * Re-derived 2026-08-12 against the live select's 12 options, because three of the six keys here
 * were strings Notion could NOT produce and had therefore never matched anything:
 *   'Kansas City MO'  — the live option is 'Kansas City MO/KS'
 *   'Mid-Atlantic'    — the live option is 'Maryland (Baltimore/DC)'
 *   'Toledo OH'       — not an option on the select at all
 * The effect was mis-recorded as "6 of ~10 metros covered": only 3 keys were live, so 12 of 20 rows
 * resolved to 'Other'/null. The two renamed keys also cost those deals their RCT coverage, since
 * 'Kansas City MO' and 'Mid-Atlantic' ARE priced in RCT_V03 while 'Other' is not — no live row
 * carries either value today, so this restores coverage prospectively rather than changing a
 * published number.
 */
const MARKET_MAP: Record<string, Market> = {
  'Columbus OH': 'Columbus OH',
  'Cincinnati OH': 'Cincinnati OH',
  'Cleveland OH': 'Cleveland MSA',
  'Indianapolis IN': 'Indianapolis IN',
  'Kansas City MO/KS': 'Kansas City MO',
  'Maryland (Baltimore/DC)': 'Mid-Atlantic',
  'Madison WI': 'Madison WI',
  'Grand Rapids MI': 'Grand Rapids MI',
  'Richmond VA': 'Richmond VA',
  'Des Moines IA': 'Des Moines IA',
  'Louisville KY': 'Louisville KY',
  Other: 'Other',
  // Not currently an option on the Notion select — kept because the enum member is live for OWNED
  // properties (inferMarket returns it), so a future select option would map correctly rather than
  // silently landing in 'Other'.
  'Toledo OH': 'Toledo OH',
};
/**
 * Notion "Stage" select value → DealStage. Same discipline as MARKET_MAP: keys must be strings the
 * live select can actually emit, and an unmapped value falls through to 'Candidate'.
 *
 * 'Killed' added 2026-08-13, found by the live cutover verification rather than by review. The
 * select offers 9 options and this map covered 8, so a Killed deal resolved to the DEFAULT — and the
 * default is 'Candidate', which is not a neutral fallback but an active early-stage claim. One live
 * row was affected, and because it is seed-matched and public it was publishing to the mirror as an
 * active Candidate while Notion said Killed.
 */
const STAGE_MAP: Record<string, DealStage> = {
  Candidate: 'Candidate',
  'LOI Pending': 'LOI/PSA',
  'LOI Executed': 'LOI/PSA',
  'Under Contract': 'Due Diligence',
  'Due Diligence': 'Due Diligence',
  Closing: 'Closing',
  'Closed Won': 'Closed',
  Passed: 'Dead',
  Killed: 'Dead',
};

// Object.hasOwn, not `MAP[s] ?? fallback`: a select option literally named 'constructor' or
// 'toString' resolves the inherited Object.prototype member on a plain-object lookup — truthy, so
// `??` never fires — and the caller gets a Function where it expects a Market/DealStage string.
// Not reachable from live data today, but one line closes it for both maps at once.
// (Refute pass 2026-08-13, determinism lens, LOW.)
const mapMarket = (s: string | null): Market | null =>
  s ? (Object.hasOwn(MARKET_MAP, s) ? MARKET_MAP[s]! : 'Other') : null;
const mapStage = (s: string | null): DealStage =>
  s && Object.hasOwn(STAGE_MAP, s) ? STAGE_MAP[s]! : 'Candidate';
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
interface NotionPage { id?: string; properties?: Record<string, unknown> }
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
    // The Notion page UUID when available — always, on real API traffic. `notion-${slug(name)}`
    // is the FALLBACK, for hand-built fixtures with no page.id, not the live default.
    //
    // A slug-derived id is unsafe for an UNMATCHED (extras) row: it is a live Deal's OWN
    // identifier, and two different live rows sharing a name (or agreeing on slug()'s first 64
    // truncated characters — exactly the "Phase One"/"Phase Two" scenario the second refute round
    // cited) collide on it. That id then feeds two Hard-Invariant-3-adjacent consumers directly:
    // isDeclassified() gates purely on `allowlist.includes(deal.id)` (server/sources/
    // deal-declassification.ts) — a collision between an allowlisted deal and an unrelated,
    // currently-confidential one sharing the same slug would pass that check and CAN publish the
    // wrong deal; and scripts/bake-mirror.ts's redactConfidential strips counterparty↔deal links
    // by `removedIds = new Set(confidential.map(d => d.id))`, so a legitimate, non-confidential
    // deal sharing the id loses its link too. (A MATCHED/seed-joined row is unaffected either way
    // — mergeDeals always keeps the SEED's own `.id`, never the live row's.)
    // (Code review, 2026-08-13, HIGH.)
    // `||`, not `??`: an empty-string page.id (constructible only from a hand-built fixture — the
    // live API never returns one) must fall through to the slug the same as an absent id, or two
    // such fixtures would collide on the empty string. (Refute pass 2026-08-13, all 3 lenses.)
    id: page.id || `notion-${slug(name)}`,
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
 * Roster wins over a seed `confidential:false` (Hard Invariant 3). The seed flag is the intended
 * escape hatch, but only while no ACTIVE roster group claims the deal — checked on the whole record
 * (live location/price/nextAction included) and fail-closed on an unreadable or placeholder roster.
 * Applied on EVERY path that returns seed deals, including loadDeals' degraded fallbacks.
 */
export function applyRosterOverride(deals: readonly Deal[]): Deal[] {
  return deals.map((d) => {
    if (d.confidential || !rosterClaimsDeal(d)) return d;
    console.warn(`[notion-deals] ${d.id} is confidential:false but the active confidential roster claims it (or the roster could not be verified) — forcing confidential.`);
    return { ...d, confidential: true };
  });
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
/**
 * Roster wins over a seed `confidential:false` (Hard Invariant 3). The seed flag is the intended
 * escape hatch, but only while no ACTIVE roster group claims the deal — checked on the whole record
 * (live location/price/nextAction included) and fail-closed on an unreadable or placeholder roster.
 * Applied on EVERY path that returns seed deals, including loadDeals' degraded fallbacks.
 */
export function applyRosterOverride(deals: readonly Deal[]): Deal[] {
  return deals.map((d) => {
    if (d.confidential || !rosterClaimsDeal(d)) return d;
    console.warn(`[notion-deals] ${d.id} is confidential:false but the active confidential roster claims it (or the roster could not be verified) — forcing confidential.`);
    return { ...d, confidential: true };
  });
}

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
    // A field named in the seed's estimatedFields stops being an estimate the moment a REAL live
    // value replaces it — pick() already does that replacement, but estimatedFields was carried
    // through untouched, so a live number could publish under an "Estimated" provenance label.
    //
    // GENERALIZED, not just sf/estPrice: the first version of this fix hardcoded those two fields,
    // which was itself latent-incomplete in the same way it was fixing — a seed author adding
    // `estimatedFields: ['capRate']` (nothing in the Deal type stops that) would have hit the exact
    // defect again. This checks every field the live row can replace, generically, driven by one
    // list rather than a second, independently-maintained one that can drift from `pick()`/`stage`.
    //
    // `stage` is included even though it is not itself `pick()`'d two lines below — it is taken
    // from `live.stage` UNCONDITIONALLY, which makes it MORE definitively live-sourced than a
    // pick()'d field, not less. The second review round's own generalization missed exactly this
    // field and reproduced the bug it was fixing, for the one field seeds are most likely to
    // hand-set (post-847a17c seeds carry "null economics and a hand-set stage").
    // Object.hasOwn, not `f in pickedFromLive`: matches the hardening already applied to
    // MARKET_MAP/STAGE_MAP above, for the same reason (a field literally named 'constructor' or
    // 'toString' must not resolve an inherited Object.prototype member).
    // (Refute pass 2026-08-13, correctness lens, LOW; generalized and corrected in code review, 2026-08-13.)
    const pickedFromLive: Record<string, unknown> = {
      location: live.location, market: live.market, sf: live.sf, estPrice: live.estPrice,
      capRate: live.capRate, irr: live.irr, equityMultiple: live.equityMultiple, lender: live.lender,
      nextAction: live.nextAction, owner: live.owner, targetCloseDate: live.targetCloseDate,
      status: live.status, stage: live.stage,
    };
    const estimatedFields = s.estimatedFields.filter(
      (f) => !Object.hasOwn(pickedFromLive, f) || pickedFromLive[f] === null || pickedFromLive[f] === undefined,
    );
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
      estimatedFields,
      // A live row the pipeline already marks confidential (name patterns) is never un-flagged by
      // the seed merge; the roster check below then covers the case where neither flag fires.
      confidential: (() => {
        if (!s.confidential && live.confidential) {
          console.warn(`[notion-deals] ${s.id}: live row is confidential (name pattern) — overriding the seed's confidential:false.`);
        }
        return s.confidential || live.confidential;
      })(),
      // id, name, shortName, notionDealId, buildings, holdYrs preserved from the seed.
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

  const rosterChecked = applyRosterOverride(merged);

  const published = [...rosterChecked, ...extras];

  // ── Dangling PUBLIC_DEAL_IDS entries ───────────────────────────────────────────────────────────
  // isDeclassified()'s not-in-allowlist path returns false SILENTLY — no warn, no flag — because
  // that is the correct behavior for the common case (an id that was never meant to be there).
  // But it makes the OPPOSITE failure invisible: an entry that WAS meant to match but no longer
  // does (public-deals.ts's id format changed under it, or the Notion page was deleted and
  // re-created, which mints a new page UUID) silently reverts a Gabriel-ratified publication
  // decision to confidential with nothing anywhere reporting it. Same "verified null vs inferred
  // null" shape as the reverse seed-id tripwire above, one list over. (Code review, 2026-08-13.)
  for (const id of PUBLIC_DEAL_IDS) {
    if (published.some((d) => d.id === id)) continue;
    // The dangling entry itself might be the STALE "notion-<slug>" format this tripwire exists to
    // catch — i.e. name-derived — so it goes to the local log only, never into the published flag.
    console.warn(`[notion-deals] DANGLING PUBLIC_DEAL_IDS entry '${id}' — no published deal carries it.`);
    flags.push({
      entity: 'deals',
      field: 'publicDealIds',
      issue:
        `src/data/public-deals.ts lists a deal id that matches no published deal, so the ` +
        `declassification decision it represents is silently not taking effect. Likely causes: ` +
        `the id was authored in the retired "notion-<slug>" format (extras ids are now the Notion ` +
        `page UUID) or the Notion row was deleted and re-created, which assigns a new UUID. The ` +
        `entry is in the server log, not here (these flags reach the public mirror). Verify it ` +
        `against the deal's current id and correct it.`,
      rawValue: keyDigest(id),
      severity: 'warn',
    });
  }

  // ── Migration tripwire: an unjoined seed that looks like an unjoined live row ─────────────────
  // The one job names still have here, and it is DETECTION ONLY — a name never causes a merge.
  //
  // Without it, forgetting to mirror one Deal ID degrades SILENTLY: the seed publishes its own
  // stale economics as if they were the live pipeline (post-847a17c seeds carry null economics and
  // a hand-set stage) while the live row quietly becomes a confidential extra.
  //
  // AGGREGATED per seed. One flag per matching PAIR meant a single seed name matching three extras
  // published three near-identical flags, and a colliding id produced the collision error plus a
  // tripwire warn for the same underlying rows. (Refute pass 2026-08-12, edge lens, LOW.)
  for (const s of unjoinedSeeds) {
    const key = dealJoinKey(s.name);
    if (!key) continue;
    const matches = extras.filter((live) => dealJoinKey(live.name) === key);
    if (!matches.length) continue;
    console.warn(
      `[notion-deals] MIGRATION GAP: seed '${s.name}' (Deal ID ${s.notionDealId ?? 'unset'}) looks like ` +
        matches.map((m) => `'${m.name}' (${m.notionDealId ?? 'no id'})`).join(', ') +
        ` — but they are not joined.`,
    );
    flags.push({
      entity: 'deals',
      field: 'notionDealId',
      issue:
        `a seed record and ${matches.length} live pipeline row(s) — ` +
        `${matches.map((m) => m.notionDealId ?? '(no Deal ID)').join(', ')} — have matching names ` +
        `but share no Deal ID, so they published separately for what may be one deal, the seed ` +
        `showing its own stale figures rather than the live ones. They were NOT merged: matching ` +
        `names are grounds to warn, never to merge. CONFIRM the rows are the same asset before ` +
        `acting — a bare street name repeats across metros, and copying an id for a false match ` +
        `creates exactly the wrong merge this key exists to prevent. Both names are in the server ` +
        `log, not here (these flags reach the public mirror). If they are the same asset, set ` +
        `notionDealId on the matching row in src/data/seed-deals.ts (seed digest ${keyDigest(key)}).`,
      rawValue: matches[0]!.notionDealId ?? keyDigest(key),
      severity: 'warn',
    });
  }

  // ── Reverse tripwire: a seed id that resolves to NOTHING ──────────────────────────────────────
  // The seed side of this join is a HAND-COPIED mirror, so it is the one place the "Notion assigns
  // it, nothing can perturb it" guarantee does not reach. A transposed digit ('DEAL-13' for
  // 'DEAL-31') that lands on no live row leaves the seed publishing hand-set figures as live, and
  // the name tripwire above cannot see it — a seed carrying a non-null id is not "unjoined" for any
  // reason a name would explain. (Refute pass 2026-08-12, correctness + edge lenses, MEDIUM.)
  //
  // A seed at an ACTIVE stage that is absent from the live pipeline is far more likely a broken
  // link than a departed deal, so that case is an error; a Dead/Closed/Candidate seed genuinely
  // leaves the pipeline all the time and stays a warning.
  for (const s of seed) {
    if (!s.notionDealId || ambiguousSeedIds.has(s.notionDealId) || usedIds.has(s.notionDealId)) continue;
    const active = ACTIVE_STAGES.has(s.stage);
    console.warn(
      `[notion-deals] DANGLING seed Deal ID ${s.notionDealId} on '${s.name}' (stage ${s.stage}) — ` +
        `no live pipeline row carries it.`,
    );
    flags.push({
      entity: 'deals',
      field: 'notionDealId',
      issue:
        `a seed record carries Deal ID ${s.notionDealId}, but no live pipeline row has it, so the ` +
        `record is publishing its own hand-set figures where a reader expects live ones. Either the ` +
        `id is mistyped, or the Notion row was deleted and re-created (which assigns a NEW id). ` +
        (active
          ? `The seed is at stage '${s.stage}', which a deal absent from the live pipeline should not ` +
            `be — treated as a broken link rather than a departure.`
          : `The seed is at stage '${s.stage}', so this may simply be a deal that left the pipeline.`),
      rawValue: s.notionDealId,
      severity: active ? 'error' : 'warn',
    });
  }

  // ── Published-duplicate detector: the always-on backstop, restored ────────────────────────────
  // RESTORED after the refute pass REFUTED my claim that the migration tripwire dominates the
  // findNearDuplicateNames call deleted from checkSnapshot. It does not: the tripwire compares only
  // unjoinedSeeds x extras, leaving three pair classes invisible that the old check caught —
  // joinedSeed x extra, extra x extra, and seed x seed. The dangerous one was executed: delete and
  // re-create a Notion row (Notion assigns a FRESH Unique ID, so no id collision fires), the team
  // updates the new row while a seed keeps enriching from the abandoned one, and the public record
  // publishes stale price/stage/cap-rate as if live — gate green, where the old code raised a
  // blocking error. That is the 2026-08-04 Pendleton/2146 incident class the deleted check was
  // built from. (Refute pass 2026-08-12, edge lens, HIGH.)
  //
  // Two deliberate improvements over what it replaces, both possible only from inside the joiner:
  //  - EXACT key equality, not the old leading-token-PREFIX match, so phased assets ("Fairground
  //    Village" vs "Fairground Village Center") no longer false-positive and need no acceptance
  //    hatch — which is why NOTION_DEALS_ACCEPTED_NEAR_DUPES stays retired.
  //  - Cross-metro namesakes are SUPPRESSED via the locality tail: two different assets sharing a
  //    bare street name in different states are the documented steady state, not a defect.
  //
  // The detector itself lives in deal-name.ts, shared with checkSnapshot (server/reconcile-runtime.ts)
  // — code review 2026-08-13 found the restoration above was reachable only from a fresh Notion
  // fetch, leaving the COMMITTED-snapshot CI path (npm run gate:ci, zero Notion I/O) with no
  // independent duplicate-deal check at all. One function, two callers, so "same deal" is judged
  // identically in both and cannot drift the way the old joiner/detector split did.
  for (const { key, rows } of findDuplicateDealRows(published)) {
    console.warn(
      `[notion-deals] DUPLICATE published rows for one name: ` +
        rows.map((r) => `'${r.name}' (${r.notionDealId ?? 'no id'}, ${r.id})`).join(' | '),
    );
    flags.push({
      entity: 'deals',
      field: 'deals.name',
      issue:
        `${rows.length} published deal rows share one normalized name but were not joined ` +
        `(Deal IDs: ${rows.map((r) => r.notionDealId ?? '(none)').join(', ')}). One deal is being ` +
        `presented twice, and the copies can disagree about economics AND about redaction. The ` +
        `usual cause is a Notion row deleted and re-created — which assigns a NEW Deal ID, leaving ` +
        `any seed record enriching from the ABANDONED row and publishing stale figures as if live. ` +
        `Fix the ids so the rows join; or, if these really are different assets sharing a bare ` +
        `street name, give each a "— City, ST" locality tail naming a DIFFERENT STATE in Notion — ` +
        `same-state tails do not distinguish them here. Names are in the server log, not here ` +
        `(these flags reach the public mirror).`,
      rawValue: keyDigest(key),
      severity: 'error',
    });
  }

  return published;
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
/**
 * Distinct raw Notion "Stage" select values seen that are NOT keys of STAGE_MAP — populated by
 * fetchNotionDeals, read by loadDeals to raise one aggregate flag.
 *
 * mapStage silently resolves an unmapped (or cleared) Stage to 'Candidate', and 'Candidate' is not
 * a neutral fallback the way mapMarket's 'Other' is — it is an ACTIVE-DEAL claim. STAGE_MAP missing
 * 'Killed' let exactly this happen to a public, seed-matched deal (found by the 2026-08-13 live
 * cutover, not by review): it published as an active Candidate while Notion said Killed, zero flags.
 * Adding 'Killed' fixed that ONE value; a select rename or a new option tomorrow reproduces the
 * identical incident with the fix in place, because the point-fix does not touch the fallback
 * mechanism. Reported here rather than fixed inline in mapStage because mapNotionPage's signature
 * (Deal | null) has no channel for "this field's mapping is untrustworthy" — that has to reach
 * `loadDeals`, which already owns the DealsLoad.flags channel this reuses.
 * (Refute pass 2026-08-13, edge-case lens, MEDIUM.)
 */
function collectStageDrift(rawStage: string | null, seen: Set<string>): void {
  if (rawStage !== null && !(rawStage in STAGE_MAP)) seen.add(rawStage);
}

async function fetchNotionDeals(token: string, stageDrift: Set<string>): Promise<Deal[]> {
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
        collectStageDrift(select(page.properties ?? {}, 'Stage'), stageDrift);
        // Key on the Notion PAGE id FIRST — never on notionDealId alone. This map's only job is
        // "have I already seen this exact page" (pagination overlap, or the same page returned by
        // more than one data source query); a genuine notionDealId COLLISION across two DIFFERENT
        // pages must reach mergeDeals, which already has an exhaustively tested collision detector
        // for exactly that (server/sources/notion-deals.ts:279-309), and must not be resolved
        // silently up here.
        //
        // Two things this replaced, both of the same shape: destroying data BEFORE mergeDeals'
        // guards ever see it.
        //  (a) The ORIGINAL code keyed on `d.id` (`notion-${slug(name)}`), making row EXISTENCE a
        //      function of the NAME, last-write-wins over API return order — fixed 2026-08-13 for
        //      idless rows by falling back to page.id.
        //  (b) That fix's own PRIMARY key was still `d.notionDealId` — so two DIFFERENT pages
        //      sharing a colliding Deal ID (a data defect the mergeDeals comment above explicitly
        //      anticipates, and structurally reachable here since this function already loops over
        //      MULTIPLE data sources: a "Deal ID" column added independently to the second data
        //      source would auto-number from DEAL-1 on its own, guaranteed to collide with the
        //      first) silently overwrote one another in THIS Map before mergeDeals' collision
        //      detector ever received more than one row to compare — an id-carrying live deal
        //      destroyed with zero flags, the exact "nothing is destroyed" invariant this whole
        //      redesign is built on, violated one layer upstream of where it was being enforced.
        //
        // page.id is ALWAYS present on a real Notion API page object, so live traffic always keys
        // on it and both (a) and (b) stay fixed. notionDealId stays as the SECOND preference only
        // for hand-built fixtures that omit page.id (page.id is optional in the NotionPage
        // interface for exactly that reason) — without it, two synthetic rows with distinct
        // notionDealId but no page.id would collide on the identical d.id name-slug fallback,
        // reintroducing bug (a) for that narrow case. d.id (the slug) is the last resort, for a
        // row with neither.
        // (Code review, 2026-08-13, HIGH.) `||`, not `??`, for the same empty-string reason as
        // mapNotionPage's id construction above (adversarial pass, 2026-08-13, all 3 lenses).
        if (d) byId.set(page.id || d.notionDealId || d.id, d);
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
 * Aggregate error flag for an unreadable or placeholder confidential roster (PR #457 refute). With no
 * usable roster, mergeDeals forces every seed deal confidential and applyRosterOverride cannot vouch
 * for anything -- but that was only a server-log warn, so CLI writers and Brain.persist wrote a
 * snapshot whose confidentiality calls were made blind. Same policy as dealsDegradationFlag: ERROR
 * severity so evaluateReconciliationGate refuses. One flag for the whole roster, never per deal, and
 * deliberately no rawValue -- it must not carry a matched term or deal name.
 */
export function confidentialRosterFlag(rosterUnavailable: boolean): DataQualityFlag | null {
  if (!rosterUnavailable) return null;
  return {
    entity: 'deals',
    field: 'confidential-roster',
    issue:
      'The confidential-terms roster is unreadable or the placeholder stand-in, so deal confidentiality ' +
      'could not be verified against the source of record (Hard Invariant 3). Refusing rather than ' +
      'publishing a snapshot whose confidential flags were set blind.',
    severity: 'error',
  };
}

/** True when a snapshot's flags carry the confidential-roster refusal above (Brain.persist's check). */
export function hasConfidentialRosterFailure(flags: readonly DataQualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'error' && f.entity === 'deals' && f.field === 'confidential-roster');
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
    return { deals: applyRosterOverride(SEED_DEALS), degraded: { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' }, flags: [] };
  }
  try {
    const stageDrift = new Set<string>();
    const notion = await fetchNotionDeals(token, stageDrift);
    if (!notion.length) {
      // A configured token returning zero deals is anomalous, not a legitimately empty pipeline:
      // it wipes the live set exactly like a thrown fetch does, so it degrades identically.
      console.warn('[notion-deals] live fetch returned 0 deals, using seed');
      return { deals: applyRosterOverride(SEED_DEALS), degraded: { reason: 'empty-result', detail: 'Notion returned 0 deals for a configured token' }, flags: [] };
    }
    const flags: DataQualityFlag[] = [];
    if (stageDrift.size) {
      // Aggregated (one flag naming every drifted value), matching the idless-row pattern: N
      // near-identical flags bury the cause. WARN, not error — mapStage's 'Candidate' fallback still
      // returns something the schema accepts, so a drifted row does not fail the write, only the
      // redaction/staleness judgment built on stage. See collectStageDrift for why this can't be
      // reported closer to the source.
      console.warn(`[notion-deals] Stage drift: unmapped Notion Stage value(s) resolved to the 'Candidate' default: ${[...stageDrift].join(', ')}`);
      flags.push({
        entity: 'deals',
        field: 'stage',
        issue:
          `${stageDrift.size} live pipeline row(s) carry a Stage value not in STAGE_MAP, so they ` +
          `resolved to 'Candidate' — an active-deal claim, not a neutral default. A dead or closed ` +
          `deal presenting as an active Candidate is the incident this flag exists to catch (found ` +
          `2026-08-13: STAGE_MAP was missing 'Killed'). Add the missing Stage value(s) to STAGE_MAP ` +
          `in server/sources/notion-deals.ts. Values are in the server log, not here (these flags ` +
          `reach the public mirror).`,
        rawValue: String(stageDrift.size),
        severity: 'warn',
      });
    }
    const deals = mergeDeals(SEED_DEALS, notion, flags);
    return { deals, degraded: null, flags };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[notion-deals] live fetch failed, using seed: ${detail}`);
    return { deals: applyRosterOverride(SEED_DEALS), degraded: { reason: 'fetch-failed', detail }, flags: [] };
  }
}
