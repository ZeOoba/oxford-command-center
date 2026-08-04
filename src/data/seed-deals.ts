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
 * NAMES ARE JOIN KEYS: `name` is what matches a row to its Notion counterpart
 * (server/sources/deal-name.ts). Notion's convention is "<Deal Name> — <City>, <ST>"; the locality
 * tail is stripped automatically, but the remaining name must otherwise match Notion's, or the deal
 * double-lists. checkSnapshot's near-duplicate detector fails the gate if it ever does.
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
    // ECONOMICS DELIBERATELY NULL (scrubbed 2026-08-04, Gabriel's sign-off). This row previously
    // committed the live underwriting — $18,500,000 basis, 8.91% cap, 21% IRR, 2.57x EM, stage
    // LOI/PSA — plus named outside counsel and the environmental consultant, to an off-machine
    // remote. Every one of those figures was stale (the acquisition terminated; the live pipeline
    // carries a $4M basis and status "Terminated") and, since `e_fulton` went active:false on
    // 2026-07-09, they are no longer covered by the confidentiality egress guard either. They are
    // null rather than refreshed on purpose: the seed's job is to be a join key, the confidential
    // -flag carrier, and a DEGRADED fallback when Notion is unreachable — not a second, silently
    // diverging copy of deal economics. The live values come from the Notion merge.
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
    confidential: false,
    estimatedFields: ['sf'],
  },
  {
    id: '2146-enterprise-twinsburg',
    // Named to match Notion's "2146 Enterprise Pkwy — Twinsburg, OH" once the locality tail is
    // stripped. The bare "2146 Enterprise" did not match, so this deal double-listed (2026-08-04).
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
    confidential: false,
    estimatedFields: ['sf'],
  },
];
