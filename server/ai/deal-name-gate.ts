// server/ai/deal-name-gate.ts
//
// The deal-name egress gate shared by the AI agent (server/ai/agent.ts, before every request) and
// OM extract (server/warehouse/om-extract.ts via server/ai/egress-guards.ts, before the fetch):
// "does this outbound text name a deal that is confidential right now?" It catches claims anchored
// on fields the text never carries (owner, lender), which a roster-term text scan cannot see.
//
// Runtime-agnostic on purpose (no node builtins): agent.ts also runs in the Cloudflare Pages
// Function. The live roster verdict is INJECTED as `dealClaimed`.
import type { Deal } from '../../src/contracts/index';
import { mentionsAnyTerm, scanTexts } from '../briefing/confidential-normalize';

/** The deals as the live roster sees them: a deal `dealClaimed` returns true for (or throws on —
 *  fail closed) is tightened to `confidential:true`. Never loosens a flag and never mutates input. */
export function tightenDeals(deals: readonly Deal[], dealClaimed: ((deal: Deal) => boolean) | undefined): Deal[] {
  if (!dealClaimed) return [...deals];
  const claimed = (d: Deal): boolean => {
    try {
      return dealClaimed(d);
    } catch {
      return true;
    }
  };
  return deals.map((d) => (d.confidential || !claimed(d) ? d : { ...d, confidential: true }));
}

/** The names the gate looks for.
 *
 *  - FULL name: every confidential deal, flagged or live-claimed (a throw counts as claimed).
 *  - shortName: only deals the live roster claims but whose served flag is still false — the
 *    stale-flag window this gate exists for. A FLAGGED deal's shortName is deliberately not checked:
 *    the ratified tools.ts rule tolerates a shortName landing inside unrelated public data ("Easton"
 *    inside "…, Easton MD"), and the flag-keyed tool filters already redact real residue. Gabriel,
 *    2026-10-15, on refute wf_9509d62d-325. */
export function confidentialDealNames(deals: readonly Deal[], dealClaimed: (deal: Deal) => boolean): string[] {
  const live = tightenDeals(deals, dealClaimed);
  const names: string[] = [];
  live.forEach((d, i) => {
    if (!d.confidential) return;
    if (d.name) names.push(d.name);
    if (d.shortName && !deals[i]!.confidential) names.push(d.shortName);
  });
  return names;
}

/** True when `payload` names a deal that is confidential right now (see confidentialDealNames).
 *  A caller treats a hit as a refusal. `payload` must be the real strings that egress (the agent's
 *  egressView, the OM body), never a JSON serialization: JSON.stringify turns a newline inside a name
 *  into a literal backslash-n the normalizer cannot fold (wf_9509d62d-325, HIGH). */
export function mentionsClaimedDeal(payload: unknown, deals: readonly Deal[], dealClaimed: (deal: Deal) => boolean): boolean {
  return mentionsAnyName(payload, confidentialDealNames(deals, dealClaimed));
}

/** The matcher itself: any of `names` in any string inside `payload`, whitespace-, separator-,
 *  case-, accent- and percent-encoding-insensitive. */
export function mentionsAnyName(payload: unknown, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  // Both fold variants of every name, with and without the camelCase split, matched against both
  // variants of the haystack: a split applied to only one side ("McZob" -> "mc zob" vs an all-caps
  // or lowercase "MCZOB-RD") would otherwise miss (independent refute wf_63d61f49-653).
  const folded = [...new Set(names.flatMap((n) => [foldSeparators(n, true), foldSeparators(n, false)]))].filter((n) => n.length > 0);
  return scanTexts(payload).flatMap(withPercentDecoded).some((t) => {
    if (mentionsAnyTerm(t, names)) return true;
    // Separator-insensitive pass (wf_2e3ce239-ef6): mentionsAnyTerm folds only whitespace, so a name
    // joined by '_' '-' '.' '/' — a deal-document path, ORA's own [DocType]_[Property]_[date] file
    // names, a slug — or broken by a hyphenated line wrap slipped through. Local to this gate on
    // purpose: the shared normalizer has a pinned Python twin.
    return [foldSeparators(t, true), foldSeparators(t, false)].some((hay) => {
      const hayCompact = hay.replace(/ /g, '');
      return folded.some((n) => {
        if (` ${hay} `.includes(` ${n} `)) return true;
        const compact = n.replace(/ /g, '');
        return compact.length >= FOLDED_COMPACT_MIN && hayCompact.includes(compact);
      });
    });
  });
}

/** Shortest alnum-only name the compact (no-separator) pass may match; below this a bare substring
 *  hit inside unrelated alphanumerics is too likely. */
const FOLDED_COMPACT_MIN = 8;

/** NFKD with combining marks stripped (accent-insensitive), optionally camelCase boundaries split
 *  ("ElmPark" -> "Elm Park", for CamelCase file-name tokens), lowercase, then every run of
 *  non-letter/non-digit characters folded to one space. Callers try BOTH split variants on names and
 *  haystack. (wf_b777d74a-3c4, wf_63d61f49-653) */
function foldSeparators(s: string, splitCamel: boolean): string {
  const unmarked = s.normalize('NFKD').replace(/\p{M}/gu, '');
  return (splitCamel ? unmarked.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2') : unmarked)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Max percent-decode passes: one per nesting level of URL-in-URL encoding (Outlook Safe Links wraps
 *  a SharePoint link, so spaces arrive as %2520), bounded so a pathological input cannot loop. */
const PERCENT_DECODE_PASSES = 3;

/** Every form of the text the gate must check: the text itself, each successive percent-decoded form
 *  (SharePoint/OneDrive links, %20 download names, Safe Links' %2520 — the hex digits otherwise
 *  survive separator folding; wf_b777d74a-3c4, wf_0ac4e51b-97a), in two decodings — UTF-8, and a
 *  Latin-1 fallback for bytes that are not valid UTF-8 (JS `escape()` / legacy encoders write é as
 *  %E9; #478) — and for each, a de-hyphenated form that rejoins a word split by a hyphenated line
 *  wrap ("Zor-\nvane"). */
function withPercentDecoded(t: string): string[] {
  const out = [t];
  for (const latin1 of [false, true]) {
    let cur = t;
    for (let i = 0; i < PERCENT_DECODE_PASSES && /%[0-9A-Fa-f]{2}/.test(cur); i++) {
      const next = cur.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => decodeEscapeRun(run, latin1));
      if (next === cur) break;
      if (!out.includes(next)) out.push(next);
      cur = next;
    }
  }
  for (const v of [...out]) {
    const joined = v.replace(/(\p{L})-\s+(\p{L})/gu, '$1$2');
    if (joined !== v) out.push(joined);
  }
  return out;
}

/** Decodes one run of %XX escapes. Valid UTF-8 sequences decode; a byte that cannot (a stray %FF)
 *  becomes a space — a separator — so it can never glue itself onto a neighboring word and hide it,
 *  or, with `latin1`, the Latin-1 character for that byte (%E9 -> é, which the accent fold reads as
 *  e). Both forms are checked. */
function decodeEscapeRun(run: string, latin1: boolean): string {
  try {
    return decodeURIComponent(run);
  } catch {
    const esc = run.match(/%[0-9A-Fa-f]{2}/g) ?? [];
    let s = '';
    for (let i = 0; i < esc.length; ) {
      let took = 0;
      for (let n = Math.min(4, esc.length - i); n >= 1 && !took; n--) {
        try {
          s += decodeURIComponent(esc.slice(i, i + n).join(''));
          took = n;
        } catch {
          /* try a shorter sequence */
        }
      }
      if (!took) {
        s += latin1 ? String.fromCharCode(parseInt(esc[i]!.slice(1), 16)) : ' ';
        took = 1;
      }
      i += took;
    }
    return s;
  }
}
