import type { PortfolioSnapshot } from '@contracts/index';
import { fmtUsd, fmtDate } from '@analytics/index';
import type { EntityRef } from './ui-context';

/**
 * Draft-only email generation for closed-loop CTAs (Phase 5). Produces a firm-voice draft from
 * spine data — NEVER sends. Every draft cc's the principals; the user reviews and sends it
 * themselves (Copy or Open in Outlook). Send automation is intentionally out of the browser app.
 */
export type DraftKind = 'renewal' | 'refi' | 'insurance' | 'general';

export interface DraftRequest {
  kind: DraftKind;
  entity: EntityRef;
}
export interface DraftResult {
  title: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
}

/** ORA principals are always cc'd on outbound (per firm policy). */
export const ORA_CC = ['ggoldberg@oxfordra.net', 'egoldberg@oxfordra.net'];

const SIGN_OFF = '\n\nBest regards,\nGabriel Goldberg\nVP Acquisitions, Oxford Realty Advisors\n301.512.6125';

const findLinkedCp = (s: PortfolioSnapshot, key: 'loans' | 'insurance', id: string): string =>
  s.counterparties.find((c) => c.email && c.links[key].includes(id))?.email ?? '';

export function buildDraft(s: PortfolioSnapshot, req: DraftRequest): DraftResult | null {
  const cc = ORA_CC;
  switch (req.kind) {
    case 'renewal': {
      const l = s.leases.find((x) => x.id === req.entity.id);
      if (!l) return null;
      const tenant = l.company ?? l.tenantName;
      const where = `${l.propertyKey}${l.unit ? ` (Unit ${l.unit})` : ''}`;
      const expires = l.leaseEnd ? fmtDate(l.leaseEnd) : 'the current term';
      return {
        title: `Draft renewal — ${tenant}`,
        to: '',
        cc,
        subject: `Lease renewal — ${where}`,
        body:
          `${tenant} team,\n\n` +
          `Your lease at ${where} expires ${expires}. We value the tenancy and would like to discuss a renewal ahead of expiration. ` +
          `Current annual rent is ${fmtUsd(l.annualRent)}.\n\n` +
          `Please let us know your interest and availability this week to review terms.` +
          SIGN_OFF,
      };
    }
    case 'refi': {
      const ln = s.loans.find((x) => x.id === req.entity.id);
      if (!ln) return null;
      const due = ln.maturity ? fmtDate(ln.maturity) : 'maturity';
      return {
        title: `Draft refinance outreach — ${ln.name}`,
        to: findLinkedCp(s, 'loans', ln.id),
        cc,
        subject: `Upcoming maturity — ${ln.name}`,
        body:
          `Hello,\n\n` +
          `The loan on ${ln.name} (current balance ${fmtUsd(ln.absBalance)}) reaches ${due}` +
          `${ln.monthsToMaturity !== null ? ` — roughly ${ln.monthsToMaturity} months out` : ''}. ` +
          `We would like to begin discussing refinance or extension terms.\n\n` +
          `Could we set a call this week to walk through options?` +
          SIGN_OFF,
      };
    }
    case 'insurance': {
      const p = s.insurance.find((x) => x.id === req.entity.id);
      if (!p) return null;
      return {
        title: `Draft carrier note — ${p.property}`,
        to: findLinkedCp(s, 'insurance', p.id),
        cc,
        subject: `Coverage confirmation — ${p.property}`,
        body:
          `Hello,\n\n` +
          `Regarding the ${p.coverage ?? 'policy'} for ${p.property}${p.carrier ? ` with ${p.carrier}` : ''} ` +
          `(status: ${p.status}${p.expires ? `, expires ${fmtDate(p.expires)}` : ''}): ` +
          `please confirm replacement coverage is bound and send the updated certificate.\n\n` +
          `Thank you for the quick turn.` +
          SIGN_OFF,
      };
    }
    case 'general': {
      const c = s.counterparties.find((x) => x.id === req.entity.id);
      if (!c) return null;
      return {
        title: `Draft email — ${c.name}`,
        to: c.email ?? '',
        cc,
        subject: `${c.firm ?? c.name}`,
        body: `Hi ${c.name.split(' ')[0] ?? ''},\n\n[Your message]` + SIGN_OFF,
      };
    }
    default:
      return null;
  }
}

/** A mailto: URL for "Open in Outlook" — opens a draft, never sends. */
export function mailtoHref(d: DraftResult): string {
  const params = new URLSearchParams();
  if (d.cc.length) params.set('cc', d.cc.join(','));
  params.set('subject', d.subject);
  params.set('body', d.body);
  return `mailto:${encodeURIComponent(d.to)}?${params.toString()}`;
}
