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
import type { Deal } from '../../src/contracts/index';
import type { OmExtractOptions } from '../warehouse/om-extract';
import { rosterClaimsDeal, dealConfidentialForEgress, egressScan } from '../sources/deal-declassification';
import { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE, type AgentOptions } from './agent';

/** POST /api/ai. `dealClaimed` drives the per-tool-call tighten and the pre-request egress gate in
 *  runAgent; `confidentialScan` is the layer-2 text scan, placeholder-aware via egressScan. */
export function agentEgressGuards(): Pick<AgentOptions, 'dealClaimed' | 'confidentialScan'> {
  return {
    dealClaimed: rosterClaimsDeal,
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

/** POST /api/actions/om-extract, end to end: resolves the client's raw `dealId` form value against the
 *  served snapshot and builds the guards from that resolution. The route calls only this, so tests
 *  drive the route's real resolution too (wf_2e3ce239-ef6: weakening an inline `deal`/`hasDealId` in
 *  index.ts passed every test). The resolved row is handed to the guard unmodified — the live roster
 *  check must see the FULL record, owner/lender included. `deal` is also returned for the route's
 *  save step. */
export function resolveOmExtractEgress(
  rawDealId: unknown,
  snapshot: { deals: readonly Deal[] } | null | undefined,
): { deal: Deal | undefined; guards: ReturnType<typeof omExtractEgressGuards> } {
  const hasDealId = typeof rawDealId === 'string' && rawDealId !== '';
  const deal = hasDealId ? snapshot?.deals.find((d) => d.id === rawDealId) : undefined;
  return { deal, guards: omExtractEgressGuards(deal, hasDealId) };
}

/** The guards for an already-resolved deal. `deal` is the row from the served snapshot (undefined for
 *  a blank-deal upload or an unresolved id); `hasDealId` says whether the client named one. */
export function omExtractEgressGuards(
  deal: Deal | undefined,
  hasDealId: boolean,
): Pick<OmExtractOptions, 'dealConfidential' | 'dealLookupFailed' | 'confidentialScan'> {
  return {
    // A live predicate, re-evaluated by extractOmFields right before its network call.
    dealConfidential: deal ? () => dealConfidentialForEgress(deal) === true : undefined,
    dealLookupFailed: hasDealId && !deal,
    confidentialScan: egressScan,
  };
}
