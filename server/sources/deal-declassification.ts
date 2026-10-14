// server/sources/deal-declassification.ts
//
// Gates the PUBLIC_DEAL_IDS allowlist (Defect 1b, 2026-08-04). The fail-closed default in
// mergeDeals is unchanged: an unmatched Notion deal is confidential unless this module affirms
// BOTH that it was explicitly allowlisted AND that the live confidential-terms roster does not
// claim it. The roster is the source of record for Hard Invariant 3; the allowlist can only ever
// subtract from the default, never override the roster.

import type { Deal } from '../../src/contracts/index';
import { PUBLIC_DEAL_IDS } from '../../src/data/public-deals';
import { collectText, scanForConfidential } from '../briefing/confidential';

/**
 * The sentinel term carried by `confidential.ts`'s FALLBACK_TERMS — the placeholder roster returned
 * (instead of throwing) when CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 is set and the real file is
 * absent. Probing for it is how we detect that we are scanning against a roster with NO real terms.
 * `loadTerms` is not exported, so this probe is the available seam.
 */
const PLACEHOLDER_SENTINEL = '__ora_confidential_placeholder__';

/**
 * True only if this deal may be published. Returns false — keeping the deal confidential — for any
 * deal that is not allowlisted, that matches an active roster group, whose roster could not be read,
 * or whose roster is the placeholder stand-in.
 *
 * The catch is the fail-closed leg, not defensive noise: `scanForConfidential` loads
 * confidential-terms.json and THROWS when it is absent or unreadable, and a confidentiality gate
 * that treated an unreadable roster as "nothing is confidential" would invert the invariant.
 *
 * PLACEHOLDER REJECTION (review 2026-08-04, CRITICAL — this gate previously failed OPEN). The throw
 * is not the only way the roster can be missing. CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 makes
 * `loadTerms` return FALLBACK_TERMS instead of throwing, so the catch never fires, every real term
 * silently fails to match, and an allowlisted deal was declared publishable with the roster never
 * consulted. That env is a deliberate reduced-coverage concession for a briefing RENDER on a dev
 * box; it must not carry over to a PUBLICATION decision. Verified failing-open before this guard.
 *
 * The whole Deal is scanned, not a hand-picked field list. An earlier version scanned only
 * id/name/shortName/location/lender/owner and missed `status` and `nextAction` — the two long
 * free-text fields, which in real pipeline data carry addresses, brokers and counsel names, and
 * which bake-mirror publishes verbatim. `collectText` flattens objects, so passing the record is
 * both simpler and strictly more conservative.
 */
export function isDeclassified(deal: Deal, allowlist: readonly string[] = PUBLIC_DEAL_IDS): boolean {
  if (!allowlist.includes(deal.id)) return false;
  try {
    if (scanForConfidential(PLACEHOLDER_SENTINEL)) {
      console.warn(
        `[deal-declassification] the confidential roster is the PLACEHOLDER stand-in ` +
          `(CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER is set and the real file is unreadable) — refusing ` +
          `to declassify ${deal.id}. A publication decision must never run against a disabled roster.`,
      );
      return false;
    }
    const hit = scanForConfidential(deal);
    if (hit) {
      console.warn(
        `[deal-declassification] ${deal.id} is on PUBLIC_DEAL_IDS but still matches the ACTIVE ` +
          `confidential roster (${hit.dealLabel}) — keeping it confidential. The roster wins; ` +
          `remove the allowlist entry or retire the roster group (active:false), not both blindly.`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[deal-declassification] confidential roster unreadable (${e instanceof Error ? e.message : String(e)}) ` +
        `— allowlist ignored, ${deal.id} stays confidential.`,
    );
    return false;
  }
}

/**
 * True when the live confidential-terms roster claims this deal — or when that cannot be ruled out.
 * The mirror image of isDeclassified for deals whose flag is already `false` (seed-matched deals,
 * whose seed flag is otherwise authoritative): the roster is the source of record for Hard
 * Invariant 3, so a seed `confidential:false` can never outrank an ACTIVE roster hit. Fails CLOSED
 * on an unreadable roster and on the placeholder stand-in, exactly as isDeclassified does.
 */
export function rosterClaimsDeal(deal: Deal): boolean {
  try {
    if (scanForConfidential(PLACEHOLDER_SENTINEL)) return true;
    return scanForConfidential(deal) !== null;
  } catch {
    return true;
  }
}

/**
 * True when the confidential roster cannot be relied on at all: unreadable/absent (the scan throws)
 * or the placeholder stand-in (CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 with no real file). The
 * publication-boundary counterpart of the per-deal checks above -- used by writers that must refuse
 * outright rather than decide per deal, and by the aggregate `deals / confidential-roster` flag.
 */
export function rosterUnavailable(): boolean {
  try {
    return scanForConfidential(PLACEHOLDER_SENTINEL) !== null;
  } catch {
    return true;
  }
}

/**
 * Roster scan of a payload about to be published to a redacted PUBLIC surface (PR #457 refute
 * wf_d42a89c6-fe5). Redaction is flag- and name-only, so text naming an ACTIVE roster deal by an
 * `always` term (e.g. an M365 task carrying its address) survives whenever the Notion name differs;
 * the roster is the source of record for Hard Invariant 3 and gets the last word. Returns the
 * refusal text, or null when the payload may publish.
 *
 * Fails CLOSED three ways: a hit, a throw (unreadable roster), and the placeholder stand-in. The
 * message never carries a matched term or deal label -- this text reaches logs.
 *
 * Scans the flattened values (collectText, the egress hook's semantics), every object KEY (collectText
 * walks Object.values and never sees keys -- yet tenantNotes / dealComps / marketRents are keyed by free
 * text), AND the serialized bytes. Keys are walked raw, not via the bytes, because JSON.stringify
 * escapes quotes and backslashes and would hide a term containing one.
 * Callers must not use this for FULL (Access-gated) bakes, where confidential content is the point.
 */
/** Every object key in the value, space-joined, for scanning (collectText skips keys). */
function collectKeys(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(collectKeys).join(' ');
  return Object.entries(value).map(([k, v]) => `${k} ${collectKeys(v)}`).join(' ');
}

export function serializeForPublication(payload: unknown): { json: string | null; refusal: string | null } {
  const tail = 'Leaving the last good public output in place.';
  const refuse = (why: string) => ({ json: null, refusal: `\u2717 refusing to publish \u2014 ${why} ${tail}` });
  try {
    if (rosterUnavailable()) {
      return refuse('the confidential-terms roster is unreadable or the placeholder stand-in, so this publicly served payload cannot be verified against it.');
    }
    // Serialize ONCE and scan exactly what will be written. Scanning the live object and then
    // re-serializing it let a getter / toJSON return different content on the second pass (review round 4,
    // C1b/C1c); the parse below is the bytes' own value+key view, so toJSON rewrites are covered too.
    const json = JSON.stringify(payload);
    if (typeof json !== 'string') return refuse('the payload does not serialize.');
    const parsed: unknown = JSON.parse(json);
    // ONE combined text for values + keys: a context term and its anchor may be split between a key and a
    // value, and a per-text scan would see only one half of the pair (review round 3, C1b). The raw
    // serialized text is scanned as well, as a backstop for anything the structured walk misses.
    const hit = scanForConfidential(`${collectText(parsed)} ${collectKeys(parsed)}`) || scanForConfidential(json);
    // The roster is re-read on every scan; if it vanished between the check above and the scans, they ran
    // against the placeholder and a clean result means nothing (review round 3, C1d).
    if (rosterUnavailable()) {
      return refuse('the confidential-terms roster became unreadable during the scan, so this payload cannot be verified.');
    }
    if (hit) {
      return refuse('the redacted payload still matches an ACTIVE confidential roster term. Find and remove the leaking field at its source (term withheld from this log).');
    }
    return { json, refusal: null };
  } catch {
    return refuse('the confidential roster scan threw, so the payload cannot be verified.');
  }
}

/** Refusal text only (null = may publish). Writers should prefer serializeForPublication and write its `json`. */
export function publicPayloadRosterRefusal(payload: unknown): string | null {
  return serializeForPublication(payload).refusal;
}
