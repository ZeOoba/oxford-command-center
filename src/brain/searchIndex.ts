import type { PortfolioSnapshot } from '@contracts/index';
import { fmtUsdCompact, fmtSf, fmtPct } from '@analytics/index';
import type { EntityRef } from './ui-context';

export interface EntityItem {
  ref: EntityRef;
  group: 'Properties' | 'Tenants' | 'Loans' | 'Deals' | 'Insurance' | 'Cash' | 'Relationships';
  title: string;
  subtitle: string;
  /** Concatenated searchable text (cmdk filters on this). */
  value: string;
}

const KIND_LABEL: Record<string, string> = {
  lender: 'Lender',
  carrier: 'Insurance carrier',
  counsel: 'Counsel',
  title: 'Title / closing',
  broker: 'Broker',
  principal: 'Principal',
  partner: 'Partner',
};

export function buildEntityItems(s: PortfolioSnapshot): EntityItem[] {
  const items: EntityItem[] = [];

  for (const p of s.properties) {
    items.push({
      ref: { type: 'property', id: p.id },
      group: 'Properties',
      title: p.name,
      subtitle: `${p.type} · ${fmtSf(p.sf)} · ${fmtUsdCompact(p.noi)} NOI`,
      value: `property ${p.name} ${p.market} ${p.type} ${p.lender ?? ''}`,
    });
  }

  for (const l of s.leases) {
    const name = l.company ?? l.tenantName;
    items.push({
      ref: { type: 'lease', id: l.id },
      group: 'Tenants',
      title: name,
      subtitle: `${l.propertyKey} ${l.unit ?? ''} · ${fmtUsdCompact(l.annualRent)}/yr · ${l.status}`,
      value: `tenant lease ${name} ${l.tenantName} ${l.propertyKey} ${l.unit ?? ''} ${l.status}`,
    });
  }

  for (const ln of s.loans) {
    items.push({
      ref: { type: 'loan', id: ln.id },
      group: 'Loans',
      title: ln.name,
      subtitle: `${ln.direction} · ${fmtUsdCompact(ln.absBalance)} · ${ln.rate !== null ? fmtPct(ln.rate, 2) : '—'}`,
      value: `loan ${ln.name} ${ln.counterparty ?? ''} ${ln.direction} ${ln.lender ?? ''}`,
    });
  }

  for (const d of s.deals) {
    items.push({
      ref: { type: 'deal', id: d.id },
      group: 'Deals',
      title: d.name,
      subtitle: `${d.stage}${d.location ? ` · ${d.location}` : ''}`,
      value: `deal ${d.name} ${d.shortName ?? ''} ${d.stage} ${d.location ?? ''}`,
    });
  }

  for (const ins of s.insurance) {
    items.push({
      ref: { type: 'insurance', id: ins.id },
      group: 'Insurance',
      title: ins.property,
      subtitle: `${ins.coverage ?? 'Policy'} · ${ins.carrier ?? ''} · ${ins.status}`,
      value: `insurance policy ${ins.property} ${ins.carrier ?? ''} ${ins.coverage ?? ''} ${ins.status}`,
    });
  }

  for (const c of s.cash.entities) {
    items.push({
      ref: { type: 'cashEntity', id: c.id },
      group: 'Cash',
      title: c.entity,
      subtitle: `${fmtUsdCompact(c.currentBalance)} · ${fmtPct(c.pctOfPortfolio)} of cash`,
      value: `cash entity ${c.entity}`,
    });
  }

  for (const cp of s.counterparties) {
    const linkCount =
      cp.links.properties.length + cp.links.loans.length + cp.links.deals.length + cp.links.insurance.length;
    items.push({
      ref: { type: 'counterparty', id: cp.id },
      group: 'Relationships',
      title: cp.name,
      subtitle: `${KIND_LABEL[cp.kind] ?? cp.kind}${cp.firm && cp.firm !== cp.name ? ` · ${cp.firm}` : ''}${linkCount ? ` · ${linkCount} link${linkCount === 1 ? '' : 's'}` : ''}`,
      value: `relationship ${cp.kind} ${cp.name} ${cp.firm ?? ''} ${cp.role ?? ''} ${cp.email ?? ''}`,
    });
  }

  return items;
}
