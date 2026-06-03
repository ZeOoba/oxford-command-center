import type { Counterparty } from '@contracts/index';

/**
 * People-layer seed — grounded in firm memory (people_team.md), not the workbook.
 * Lenders & carriers are derived from workbook data; these are the humans behind the
 * deals. Links are filled in by deriveCounterparties() (owner/firm matching). Live
 * source later = HubSpot contacts + Notion People DB (same shape).
 *
 * Confidentiality: notes are role-based and never name confidential deals (E. Fulton).
 * Deal links carry only ids; the confidential flag travels with the deal record itself.
 */
export const SEED_PEOPLE: Counterparty[] = [
  {
    id: 'cp-philip-collins',
    name: 'Philip Collins',
    kind: 'counsel',
    firm: 'Collins Real Estate Law',
    role: 'Transaction counsel — PSA drafting & negotiation, lease review, entity formation, closing coordination',
    email: 'philip@collinsrelaw.com',
    phone: null,
    market: 'Columbus OH',
    notes: 'Engaged per-deal (not on retainer). Precise, clause-level — reference specific sections.',
    source: 'memory',
    links: { properties: [], loans: [], deals: [], insurance: [] },
  },
  {
    id: 'cp-tamara-lucas',
    name: 'Tamara Lucas',
    kind: 'title',
    firm: 'Symetra',
    role: 'Title & closing coordination',
    email: 'tamara.lucas@symetra.com',
    phone: null,
    market: 'Columbus OH',
    notes: 'Title/closing on active deals.',
    source: 'memory',
    links: { properties: [], loans: [], deals: [], insurance: [] },
  },
  {
    id: 'cp-eric-goldberg',
    name: 'Eric Goldberg',
    kind: 'principal',
    firm: 'Oxford Real Assets',
    role: 'Founder — strategic oversight, capital allocation, final sign-off on acquisitions',
    email: 'egoldberg@oxfordra.net',
    phone: null,
    market: null,
    notes: 'Formal, numbers-first. Wants NOI, cap rate, DSCR before narrative. Final approval on acquisitions & major CapEx.',
    source: 'memory',
    links: { properties: [], loans: [], deals: [], insurance: [] },
  },
  {
    id: 'cp-gabriel-goldberg',
    name: 'Gabriel Goldberg',
    kind: 'principal',
    firm: 'Oxford Real Assets',
    role: 'VP Acquisitions — sourcing, underwriting, broker relationships, market research',
    email: 'ggoldberg@oxfordra.net',
    phone: null,
    market: null,
    notes: 'Direct, deal-focused.',
    source: 'memory',
    links: { properties: [], loans: [], deals: [], insurance: [] },
  },
];
