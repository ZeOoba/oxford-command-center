// server/ai/egress-guards.ts
//
// The confidentiality guards the two Anthropic-API routes in server/index.ts hand to their engines,
// built here (server-only: they read the roster off disk) so tests can drive the EXACT production
// wiring. index.ts only spreads them in; tests/unit/egress-live-roster.test.ts pins that it overrides
// none of their keys (refute wf_fb398b02-494: regex pins on inline index.ts wiring let a one-token
// reversion through with the whole suite green).
//
// Every guard asks the LIVE roster at the moment of egress, never the served `Deal.confidential`
// flag alone, which lags a roster edit until Brain's debounced recheck runs (wf_e6ffdd97-245).
import type { DataQualityFlag, Deal } from '../../src/contracts/index';
import type { OmExtractOptions } from '../warehouse/om-extract';
import { rosterClaimChecker, syncPassRosterClaims, dealConfidentialForEgress, egressScan } from '../sources/deal-declassification';
import { hasDealsPipelineFailure } from '../sources/notion-deals';
import { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE, type AgentOptions } from './agent';
import { mentionsClaimedDeal } from './deal-name-gate';

/** POST /api/ai. `dealClaimed` drives runAgent's once-per-tool-turn tighten (taken after the turn's
 *  awaited tools) and its pre-request deal-name gate; `confidentialScan` is the layer-2 text scan,
 *  placeholder-aware via egressScan. */
export function agentEgressGuards(): Pick<AgentOptions, 'dealClaimed' | 'confidentialScan'> {
  return {
    // One roster read per synchronous pass over the served deals, not one per deal (#478).
    dealClaimed: syncPassRosterClaims(),
    // If the roster is absent/unreadable/placeholder the scan THROWS by design; runAgent's catch would
    // otherwise surface e.message, which embeds the roster's absolute path and the ALLOW_PLACEHOLDER
    // opt-out's name — fine on stderr, not in the browser's network tab. Log the detail server-side
    // and re-throw the generic message; still fails closed.
    confidentialScan: (value) => {
      try {
        return egressScan(value);
      } catch (err) {
        console.error('[ai] confidentiality guard unavailable:', err);
        throw new Error(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE); // runAgent passes exactly this through
      }
    },
  };
}

/** What the OM guards read from the served snapshot: its deals, and its dataQuality flags (to tell a
 *  complete deal list from a seed-only one served during a Notion outage). */
export type OmExtractSnapshot = { deals: readonly Deal[]; dataQuality?: readonly DataQualityFlag[] };

/** POST /api/actions/om-extract, end to end: resolves the client's raw `dealId` form value against the
 *  served snapshot and builds the guards from that resolution. The route calls only this, so tests
 *  drive the route's real resolution too (wf_2e3ce239-ef6: weakening an inline `deal`/`hasDealId` in
 *  index.ts passed every test). The resolved row is handed to the guard unmodified — the live roster
 *  check must see the FULL record, owner/lender included. `deal` is also returned for the route's
 *  save step. */
export function resolveOmExtractEgress(
  rawDealId: unknown,
  snapshot: OmExtractSnapshot | null | undefined,
): { deal: Deal | undefined; guards: ReturnType<typeof omExtractEgressGuards> } {
  const hasDealId = typeof rawDealId === 'string' && rawDealId !== '';
  const deal = hasDealId ? snapshot?.deals.find((d) => d.id === rawDealId) : undefined;
  return { deal, guards: omExtractEgressGuards(deal, hasDealId, snapshot) };
}

/** The guards for an already-resolved deal. `deal` is the row from the served snapshot (undefined for
 *  a blank-deal upload or an unresolved id); `hasDealId` says whether the client named one;
 *  `snapshot` is the served snapshot whose deals the OM text is checked against (#478 item 1). */
export function omExtractEgressGuards(
  deal: Deal | undefined,
  hasDealId: boolean,
  snapshot: OmExtractSnapshot | null | undefined,
): Pick<OmExtractOptions, 'dealConfidential' | 'dealLookupFailed' | 'confidentialScan' | 'mentionsConfidentialDeal'> {
  return {
    // A live predicate, re-evaluated by extractOmFields right before its network call.
    dealConfidential: deal ? () => dealConfidentialForEgress(deal) === true : undefined,
    dealLookupFailed: hasDealId && !deal,
    confidentialScan: egressScan,
    // The agent's deal-name rule over the OM body, against EVERY served deal: flagged ones, and ones
    // the live roster claims (rosterClaimChecker, asked at evaluation time — after the parse). With no
    // snapshot the names cannot be checked, so it throws and extractOmFields refuses. The same holds
    // for a snapshot whose deal list is known to be incomplete: during a Notion outage Brain serves
    // the seed-only pipeline with the deals/pipeline error flag, and a Notion-only confidential deal is
    // absent from it (independent refute wf_7e107bc5-f6c, MEDIUM). NOT covered: token-less mode
    // (`not-configured`, NOTION_TOKEN unset) serves the same seed-only list with no flag by design, so
    // a Notion-only deal is invisible here too; only the roster text scan applies there. Tracked on
    // #478 (the live server always carries the token).
    mentionsConfidentialDeal: (text) => {
      if (!snapshot) throw new Error('brain snapshot unavailable — deal names cannot be checked');
      if (hasDealsPipelineFailure(snapshot.dataQuality ?? [])) {
        throw new Error('Notion deals pipeline unavailable — the served deal list is incomplete, deal names cannot be checked');
      }
      return mentionsClaimedDeal(text, snapshot.deals, rosterClaimChecker()); // one roster read for every deal (#478)
    },
  };
}
