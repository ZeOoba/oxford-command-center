import type { Deal } from '@contracts/index';

/**
 * Acquisitions pipeline seed — sourced from the prototype + firm memory.
 * Live source later = HubSpot + Notion Acquisition Pipeline Tracker (same shape).
 *
 * CONFIDENTIAL FLAG: this file is the source of truth for `Deal.confidential` on seed-matched deals
 * (server/sources/notion-deals.ts preserves the seed flag through the Notion merge), so a flag here
 * that goes stale can never be corrected downstream. Keep each row's flag reconciled against the
 * active-deal roster in ~/.claude/hooks/confidential-terms.json — a deal set `active: false` there
 * is declassified and must be cleared here too.
 *
 * `notionDealId` IS THE JOIN KEY — names are not (changed 2026-08-12). It mirrors the "Deal ID"
 * Unique ID column on Notion's Acquisition Pipeline Tracker, which Notion assigns and keeps
 * read-only. To link a seed row to its live pipeline row, copy that row's Deal ID here; `null` means
 * "not in the live pipeline" and the row simply publishes its seed values.
 *
 * Names are free to differ from Notion's in spelling, abbreviation, or locality suffix without
 * consequence. Until this date `name` WAS the join key, which cost a CRITICAL cross-side wrong merge
 * and three further defects across four adversarial passes — see server/sources/deal-name.ts.
 *
 * If a seed row and a live row are obviously the same deal but carry no shared id, mergeDeals raises
 * a migration-gap warning naming the live Deal ID to copy here. It will NOT merge them: matching
 * names are grounds to warn, never to merge.
 */
export const SEED_DEALS: Deal[] = [
  {
    id: 'fvc-11153',
    name: 'Fairground Village Center',
    shortName: 'FVC',
    location: 'Columbus, OH',
    market: 'Columbus OH',
    sf: null,
    buildings: null,
    stage: 'Closing',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: null,
    lender: 'Symetra',
    status: 'ACH outstanding · lender review in progress · articles filed',
    nextAction: 'Resolve ACH; confirm Symetra lender review complete',
    owner: 'Tamara',
    targetCloseDate: null,
    // NOT IN THE ACQUISITION PIPELINE TRACKER, deliberately: FVC is a closing on an asset ORA is
    // acquiring/owns, not a sourcing candidate, so it has no row there to carry a Deal ID. Listed in
    // tests/unit/seed-deal-ids.test.ts's NOT_IN_PIPELINE so the cutover gate accepts the null.
    notionDealId: null,
    confidential: false,
    estimatedFields: [],
  },
  {
    id: 'e-fulton-street',
    name: 'E. Fulton Street Industrial',
    shortName: 'E Fulton',
    location: 'Columbus, OH',
    market: 'Columbus OH',
    sf: 202703,
    buildings: 5,
    // ECONOMICS DELIBERATELY NULL (scrubbed 2026-08-04, Gabriel's sign-off — see PR #258 for the
    // figures this replaced and why). They are null rather than refreshed on purpose: the seed's job
    // is to be a join key, the confidential-flag carrier, and a DEGRADED fallback when Notion is
    // unreachable — not a second, silently diverging copy of deal economics.
    //
    // NOTE — this nulls the SEED, not the output. mergeDeals' pick(live, seed) means the live Notion
    // values still flow onto every surface this deal reaches, and since confidential is now false
    // that includes the public mirror. Scrubbing here narrows what the REPO commits; it does not
    // narrow what gets published. Those are separate decisions.
    stage: 'Dead',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: 5,
    lender: null,
    status: 'Acquisition terminated — see the live pipeline record for current state',
    nextAction: null,
    owner: 'Gabriel Goldberg',
    targetCloseDate: null,
    notionDealId: 'DEAL-3', // "E Fulton Street Portfolio — Columbus, OH" (Killed)
    // DECLASSIFIED 2026-07-09 by Gabriel's in-turn directive; `e_fulton` was set active:false in
    // confidential-terms.json the same day. This flag stayed true until 2026-08-04, so the deal was
    // still being redacted from the mirror, hidden from the AI agent, and blocked from comps almost
    // a month after declassification. Cleared per Gabriel's 2026-08-04 sign-off.
    confidential: false,
    estimatedFields: [],
  },
  {
    id: 'banwick-morrison-refi',
    name: 'Banwick / Morrison Refi',
    shortName: 'Banwick/Morrison',
    location: 'Columbus, OH',
    market: 'Columbus OH',
    sf: 153000,
    buildings: 3,
    stage: 'Refinance',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: null,
    lender: 'Symetra',
    status: 'Estoppels collected · third-party reports + insurance pending',
    nextAction: 'Third-party + insurance; target close early May',
    owner: 'Symetra · Morrissey',
    targetCloseDate: null,
    // NOT IN THE ACQUISITION PIPELINE TRACKER, deliberately: this is a REFINANCE of an owned asset,
    // not an acquisition candidate. Listed in NOT_IN_PIPELINE (tests/unit/seed-deal-ids.test.ts).
    notionDealId: null,
    confidential: false,
    estimatedFields: ['sf'],
  },
  {
    id: '2146-enterprise-twinsburg',
    // This name was chosen to survive the old locality-strip join — bare "2146 Enterprise" did not
    // match Notion's "2146 Enterprise Pkwy — Twinsburg, OH", so the deal double-listed (2026-08-04).
    // The name no longer has to match anything (the join is notionDealId as of 2026-08-12); it is
    // kept because it is the correct name, not because the joiner needs it.
    name: '2146 Enterprise Pkwy',
    shortName: 'Twinsburg',
    location: 'Twinsburg, OH (Cleveland MSA)',
    market: 'Cleveland MSA',
    sf: 24000,
    buildings: 1,
    stage: 'Candidate',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: 5,
    lender: null,
    status: 'IRR model built · no recent activity',
    nextAction: 'Revisit or shelve',
    owner: 'Internal',
    targetCloseDate: null,
    notionDealId: 'DEAL-4', // "2146 Enterprise Pkwy — Twinsburg, OH" (Passed)
    confidential: false,
    estimatedFields: ['sf'],
  },
  {
    id: '1333-research-road',
    name: '1333 Research Road',
    shortName: '1333 Research',
    location: 'TBD',
    market: null,
    sf: null,
    buildings: 1,
    stage: 'Candidate',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: 5,
    lender: null,
    status: 'Seller +$100K above offer (David Ludwig)',
    nextAction: 'Counter, walk, or hold',
    owner: 'David Ludwig',
    targetCloseDate: null,
    notionDealId: 'DEAL-2', // "1333 Research Road" (Candidate)
    // PUBLIC BY DELIBERATE CHOICE (Gabriel, 2026-08-13, in-turn — same posture as e-fulton-street
    // above). The Deal ID mirror lets this row enrich with LIVE negotiating economics from Notion
    // (price/cap/IRR), which then publish to the brain.oxfordra.net mirror since confidential:false.
    // Flagged by the id-join cutover's adversarial refute pass (2nd round, wf_850e84c0-73b) as a
    // disclosure question rather than a defect — the numbers are correct, the question was whether
    // an active mid-negotiation deal should be public. Confirmed yes.
    confidential: false,
    estimatedFields: [],
  },
  {
    id: 'pendleton-trade-center',
    name: 'Pendleton Trade Center',
    shortName: 'Pendleton TC',
    location: '3849 N Richardt, Indianapolis, IN',
    market: 'Indianapolis IN',
    sf: 35000,
    buildings: 1,
    stage: 'Candidate',
    estPrice: null,
    capRate: null,
    irr: null,
    equityMultiple: null,
    holdYrs: 5,
    lender: null,
    status: 'IRR model + acquisition scorecard complete',
    nextAction: 'LOI decision required',
    owner: 'Internal',
    targetCloseDate: null,
    notionDealId: 'DEAL-1', // "Pendleton Trade Center — Indianapolis, IN" (Passed)
    confidential: false,
    estimatedFields: ['sf'],
  },
];
