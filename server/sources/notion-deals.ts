import type { DataQualityFlag, Deal, DealStage, Market } from '../../src/contracts/index';
import { slug } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import {
  dealJoinKey,
  parseNameAliases,
  acceptedCollisionKey,
  parseAcceptedCollisions,
  localityStateOf,
} from './deal-name';

import { isDeclassified } from './deal-declassification';

/**
 * A short, stable, NON-IDENTIFYING digest of a join key, for flag text.
 *
 * These flags flow into snapshot.dataQuality, which scripts/bake-mirror.ts publishes to the PUBLIC
 * brain.oxfordra.net payload (it gates only on `degraded`) and which redactConfidential explicitly
 * does NOT sweep. Embedding the key -- which IS the deal name, normalized -- would put a duplicated
 * confidential deal's name on an external surface: Hard Invariant 3. The digest is enough to
 * correlate a published flag with the console.warn beside it, which keeps the real name LOCAL.
 * FNV-1a rather than node:crypto so this module stays safe for any bundle that reaches it.
 * (Refute pass on the C1/H1 fix, 2026-08-11 — CRITICAL.)
 */
function keyDigest(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Market values that carry no real information: mapMarket's fallbacks, not evidence of location. */
const LOSSY_MARKETS: ReadonlySet<string> = new Set(['Other', 'Unknown']);
const isRealMarket = (m: Market | null | undefined): boolean =>
  m !== null && m !== undefined && !LOSSY_MARKETS.has(m);

/**
 * The US states each Market covers, for checking a name's locality tail against a seed's market.
 *
 * This is the SECOND corroboration signal, and the one that actually covers the pipeline. MARKET_MAP
 * spans 6 metros while the live pipeline spans about ten, so 11 of 20 live rows map to 'Other' and
 * carry no usable market — leaving the corroboration guard inert for the MAJORITY of rows, not the
 * "1 of 20" an earlier comment of mine claimed. Worse, in that zone the relaxation was a REGRESSION:
 * a cross-metro wrong merge proceeded where the previous revision refused. The tail is present on
 * every conventionally-named Notion row, so it closes the hole without depending on select coverage.
 * (Fourth refute pass, 2026-08-12 — the HIGH.)
 */
const MARKET_STATES: Partial<Record<Market, ReadonlySet<string>>> = {
  'Columbus OH': new Set(['OH']),
  'Toledo OH': new Set(['OH']),
  'Cleveland MSA': new Set(['OH']),
  'Indianapolis IN': new Set(['IN']),
  'Kansas City MO': new Set(['MO', 'KS']),
  'Mid-Atlantic': new Set(['MD', 'VA', 'DC', 'DE', 'PA', 'WV']),
};

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
 * Optional Notion→seed name aliases. MOVED to ./deal-name 2026-08-11 (catch-up sweep, H1): while the
 * map lived here privately, findNearDuplicateNames could not see it and keyed on the raw name, so the
 * joiner and the detector disagreed about what "same deal" means. It now lives beside the key
 * function it modifies and is applied by default in both. Re-exported so existing importers and
 * tests are unaffected.
 */
export { parseNameAliases };

/**
 * Merge live Notion deals onto the seed. The seed is the confidential-flag source of truth:
 * a Notion deal matched by name (or via an alias) enriches the seed record (live fields win) but
 * KEEPS the seed id, confidential flag, and shortName. Unmatched Notion deals are added (confidential
 * via keyword guard). Seed deals absent from Notion are retained (their flags intact).
 */
export function mergeDeals(
  seed: Deal[],
  notion: Deal[],
  aliases: Map<string, string> = parseNameAliases(),
  flags: DataQualityFlag[] = [],
  acceptedCollisions: ReadonlySet<string> = parseAcceptedCollisions(),
): Deal[] {
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
  // Two SEED rows normalizing to one join key made both look up the same live row: one merged it and
  // the other "refused" it, with the refusal flag asserting the live row had been kept separate when it
  // had in fact been merged. Ambiguous on the seed side is unmergeable on the seed side -- fail closed
  // for every seed sharing the key. (Fourth refute pass, 2026-08-12.)
  const seedKeyCounts = new Map<string, number>();
  for (const s of seed) {
    const sk = normName(s.name);
    seedKeyCounts.set(sk, (seedKeyCounts.get(sk) ?? 0) + 1);
  }
  const ambiguousSeedKeys = new Set([...seedKeyCounts.entries()].filter(([, n]) => n > 1).map(([sk]) => sk));
  for (const sk of ambiguousSeedKeys) {
    console.warn(
      `[notion-deals] ${seedKeyCounts.get(sk)} seed rows normalize to join key '${sk}' — none can claim a live row.`,
    );
    flags.push({
      entity: 'deals',
      field: 'joinKey',
      issue:
        `${seedKeyCounts.get(sk)} seed deal records normalize to the same join key (${keyDigest(sk)}), ` +
        `so no live Notion row can be attributed to one of them unambiguously. All of them are left ` +
        `unenriched rather than guessing. Disambiguate the seed names in src/data/seed-deals.ts. ` +
        `Names are in the server log.`,
      rawValue: keyDigest(sk),
      severity: 'error',
    });
  }

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
        `key. All of them are held out of the seed merge and default confidential.`,
    );
    // Honor the documented NOTION_DEALS_ACCEPTED_NEAR_DUPES steady state. Two genuinely-different
    // same-bare-name assets across metros are the case deal-name.ts directs the operator to ACCEPT
    // rather than rename ("Accept such a pair via NOTION_DEALS_ACCEPTED_NEAR_DUPES rather than
    // renaming the asset"). An unconditional error flag removed that exit and blocked the gate on
    // every run with no config remedy -- and for two Notion-ONLY rows the alias remedy is impossible,
    // since there is no seed record to alias to. Accepted pairs degrade to warn; unaccepted stay
    // error. (Refute pass on the C1/H1 fix.)
    const colliding = notion.filter((d) => keyOf(d.name) === k).map((d) => d.name);
    // Keyed on FULL names, not join keys: in a collision the join keys are equal by definition, so
    // acceptedPairKey yields "k||k" for every pair and one historical acceptance grandfathered every
    // future collision on that bare name — including a third row the operator had never seen.
    let allAccepted = colliding.length > 1;
    for (let i = 0; i < colliding.length && allAccepted; i++) {
      for (let j = i + 1; j < colliding.length && allAccepted; j++) {
        if (!acceptedCollisions.has(acceptedCollisionKey(colliding[i]!, colliding[j]!))) allAccepted = false;
      }
    }
    // The degrade was justified by "two Notion-ONLY rows, so there is no seed record to alias to".
    // With a seed sharing the key, accepting the pair leaves 3 published rows for 2 assets and the
    // seed's live economics permanently suppressed — so the error must stand there.
    if (seedKeyCounts.has(k)) allAccepted = false;
    // Emit the flag HERE rather than delegating detection to findNearDuplicateNames. The old code
    // detected the collision itself and then discarded that knowledge as a console.warn, trusting a
    // downstream detector that was keyed differently (raw name, no aliases) -- so an alias-mediated
    // collision produced withheld rows, an unenriched seed presenting null economics as the live
    // pipeline, and NO gate flag at all. A detector that can miss what the joiner already knows is
    // worse than no detector; the joiner should just say so. The alias-awareness gap is fixed too,
    // but this flag no longer depends on it. (Catch-up sweep 2026-07-28..08-04, H1.)
    flags.push({
      entity: 'deals',
      field: 'joinKey',
      issue:
        `join-key collision (key ${keyDigest(k)}): ${colliding.length} Notion pipeline rows normalize ` +
        `to the same match key, so none could be joined to a seed record. All were held out of the ` +
        `merge and default confidential — nothing was dropped, but any seed row for this key is ` +
        `presenting SEED values rather than live ones. Names are in the server log, not here (these ` +
        `flags reach the public mirror). Remedies: disambiguate the Notion names; if a seed record ` +
        `exists, add a NOTION_DEALS_NAME_ALIASES entry mapping exactly ONE of them to the seed name; ` +
        `if these are genuinely different assets, accept the pair via ` +
        `NOTION_DEALS_ACCEPTED_NEAR_DUPES.`,
      rawValue: keyDigest(k),
      severity: allAccepted ? 'warn' : 'error',
    });
  }
  const usedKeys = new Set<string>();
  // Staleness tripwire (policy item 3, 2026-07-16): a seed-matched deal keeps its seed
  // confidential:false forever (the intended escape hatch) even as the live stage advances into
  // an active acquisition stage — non-blocking, logs only, never flips the flag or throws.
  const ACTIVE_STAGES: ReadonlySet<Deal['stage']> = new Set(['LOI/PSA', 'Due Diligence', 'Closing']);
  const merged = seed.map((s) => {
    const k = normName(s.name);
    if (ambiguousSeedKeys.has(k)) return s; // flagged above; nobody claims the live row
    const live = notionByKey.get(k);
    if (!live) return s;

    // ── C1: a locality-strip match requires CORROBORATION, not just key equality ──────────────
    // The collision guard above only sees Notion↔Notion collisions. The cross-side case — ONE Notion
    // row whose locality-stripped name coincides with an unrelated seed's bare name — reached this
    // merge unguarded and folded a DIFFERENT deal's economics (price, cap, IRR, lender, and the
    // free-text status/nextAction fields that carry broker and counsel names) into the seed row,
    // which keeps the seed's confidential flag. That bypasses the fail-closed "unmatched Notion rows
    // default confidential" invariant, and the near-duplicate detector is structurally blind to it:
    // after the merge only ONE row carries the key, so no pair exists to flag.
    //
    // Notion's locality suffix exists PRECISELY because bare street names repeat across metros, so
    // stripping it deletes the one disambiguator the join had. When the strip was load-bearing and
    // the two sides name contradictory markets, that is not the naming convention — it is two
    // different assets. Refuse: leave the seed unenriched and let the live row fall through to
    // `extras`, where it takes the fail-closed confidential default. Nothing is destroyed, and the
    // error flag blocks the write until a human adjudicates.
    //
    // Scoped deliberately to the load-bearing case. An EXACT name match needs no corroboration —
    // identical names are their own — and a missing market on either side cannot contradict, so the
    // ordinary convention keeps merging untouched. Market only, never the free-text address: the
    // Market select is normalized, addresses are not, and comparing them would refuse good merges.
    // (Catch-up sweep 2026-07-28..08-04, C1 — CRITICAL, 2 lenses, both with executed repros.)
    // Corroboration is required whenever ANY normalization did the matching -- a locality strip OR
    // an alias. Keying this on the strip alone (the first version of this fix) left the alias path
    // wide open: an alias that reached the seed key with no locality tail merged contradicting
    // markets and raised no flag at all. An alias asserts that two NAMES denote one deal; it is not
    // an assertion about markets, so a contradiction still has to surface. Only a literally exact
    // name match is self-corroborating.
    // Exact on BOTH sides. Testing the strip on the live name only left a suffix-bearing SEED name
    // plus a bare Notion name looking "exact", so the wrong deal's economics still merged silently.
    // Literal equality FIRST. Requiring strip-idempotence on both sides classified two LITERALLY
    // IDENTICAL suffix-bearing names as non-exact and demanded corroboration of them — the inverse
    // error, and another instance of testing the mechanism instead of the invariant. Identical names
    // are self-corroborating whatever suffix they carry.
    // LITERAL equality (whitespace/case only) is the whole test. The previous formulation accepted
    // dealJoinKey-equality plus strip-idempotence, but dealJoinKey also collapses punctuation and
    // case, so two DIFFERENT names ('X / Y Refi' vs 'X Y Refi') read as "exact" and skipped
    // corroboration — testing the mechanism again instead of the invariant. Requiring literal equality
    // is safe now that the locality tail corroborates conventionally-named rows: a punctuation variant
    // simply gets checked rather than waved through. (Fourth refute pass, 2026-08-12.)
    const canon = (n: string): string => n.trim().toLowerCase().replace(/\s+/g, ' ');
    const exactNameMatch = canon(s.name) === canon(live.name);

    // Corroboration needs REAL markets on both sides. mapMarket collapses any Notion select outside
    // MARKET_MAP to 'Other', so treating that sentinel as evidence meant one cosmetic select rename
    // false-refused every conventionally-named row at once -- and because these joinKey flags fall
    // through Brain.persist's pipeline-only check, the live server would then publish a DOUBLE-COUNTED
    // deal (unenriched seed + confidential extra) to the auto-committed mirror. Bricking every
    // portfolio write, and corrupting the one path that isn't gated, is far worse than the defect.
    // Corollary: where either side lacks a real market the merge proceeds UNCORROBORATED, so C1 is
    // closed only as far as market coverage reaches (1 of 6 seeds and 1 of 20 live rows carry none
    // today). That is reported at warn rather than left silent, so the gap is visible and erosion is
    // detectable. (Refute pass on the C1/H1 fix.)
    // TWO independent signals, either of which can corroborate or contradict. The mapped Market is
    // the narrow one; the locality tail in the live name is the one that actually covers the pipeline.
    const marketCorroborable = isRealMarket(s.market) && isRealMarket(live.market);
    const marketContradicts = marketCorroborable && s.market !== live.market;
    const liveState = localityStateOf(live.name);
    const seedStates = s.market ? MARKET_STATES[s.market] : undefined;
    const stateCorroborable = liveState !== null && seedStates !== undefined;
    const stateContradicts = stateCorroborable && !seedStates.has(liveState);

    const corroborable = marketCorroborable || stateCorroborable;
    const contradicts = marketContradicts || stateContradicts;

    if (!exactNameMatch && !corroborable) {
      // Log the NAMES locally. The flag can only carry the digest (it reaches the public mirror), and
      // an earlier revision asserted in the flag text that "names are in the server log" while writing
      // no log line at either this site or the refusal site below -- only the collision path logged.
      // A gate-blocking diagnostic the operator cannot resolve to a deal is not a diagnostic.
      console.warn(
        `[notion-deals] uncorroborated merge (key ${keyDigest(k)}): seed '${s.name}' <- live ` +
          `'${live.name}'. Neither a mapped Market on both sides nor a locality tail was available.`,
      );
      flags.push({
        entity: 'deals',
        field: 'joinKey',
        issue:
          `merged a seed↔Notion pair that matched only after name normalization (key ` +
          `${keyDigest(k)}), and the match could not be corroborated: neither side offers checkable ` +
          `location evidence (no mapped Market on both sides, and the live name carries no ` +
          `"— City, ST" tail). If these are two different assets sharing a bare name, this merge ` +
          `attributes one deal's economics to the other. Add the locality tail to the Notion name, or ` +
          `set a mapped Market on both sides, to make this checkable. Names are in the server log.`,
        rawValue: keyDigest(k),
        severity: 'warn',
      });
    }
    if (!exactNameMatch && contradicts) {
      const because = marketContradicts
        ? `the seed record is in market '${s.market}' but the live pipeline row is in '${live.market}'`
        : `the seed record's market '${s.market}' does not cover state '${liveState}', which the live ` +
          `row's own name gives as its locality`;
      console.warn(
        `[notion-deals] REFUSED merge (key ${keyDigest(k)}): seed '${s.name}' vs live '${live.name}' — ${because}.`,
      );
      flags.push({
        entity: 'deals',
        field: 'joinKey',
        issue:
          `refused a seed↔Notion merge (key ${keyDigest(k)}) that matched only after name ` +
          `normalization rather than exactly: ${because}. A shared bare name across two markets is far more ` +
          `likely to be two different assets than one — merging would attribute one deal's economics ` +
          `to the other and publish it under the seed's confidential flag. Both rows are kept and the ` +
          `live one defaults to confidential. Names are in the server log, not here (these flags reach ` +
          `the public mirror). Remedies: correct whichever market is wrong, rename one side, or — if ` +
          `an alias is what joined them and they really are one deal — remove the alias and fix the ` +
          `names. Adding an alias will NOT clear this: the check runs after aliases are applied.`,
        rawValue: keyDigest(k),
        severity: 'error',
      });
      return s;
    }

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
   * Data-quality flags raised by the MERGE itself (join-key collisions, refused locality-strip
   * merges). Separate from `degraded`, which describes the FETCH. These are error-severity, so
   * evaluateReconciliationGate refuses the write until a human disambiguates the names — the same
   * doctrine findNearDuplicateNames already follows. Previously the joiner logged these to the
   * console and relied on a downstream detector keyed differently, which could miss them entirely.
   * (Catch-up sweep 2026-07-28..08-04, C1 + H1.)
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
    const deals = mergeDeals(SEED_DEALS, notion, parseNameAliases(), flags, parseAcceptedCollisions());
    return { deals, degraded: null, flags };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[notion-deals] live fetch failed, using seed: ${detail}`);
    return { deals: SEED_DEALS, degraded: { reason: 'fetch-failed', detail }, flags: [] };
  }
}
