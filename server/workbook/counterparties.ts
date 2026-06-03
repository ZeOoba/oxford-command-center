import type {
  Counterparty,
  CounterpartyKind,
  Property,
  Loan,
  InsurancePolicy,
  Deal,
} from '../../src/contracts/index';
import { SEED_PEOPLE } from '../../src/data/seed-counterparties';

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const pushUniq = (arr: string[], id: string | null | undefined): void => {
  if (id && !arr.includes(id)) arr.push(id);
};

const KIND_ORDER: Record<CounterpartyKind, number> = {
  principal: 0,
  counsel: 1,
  title: 2,
  lender: 3,
  carrier: 4,
  broker: 5,
  partner: 6,
};

/**
 * Builds the relationship layer of the entity graph. Lenders & carriers are derived
 * from the workbook (loans, insurance) and the pipeline (deals); counsel/title/principals
 * come from the grounded people seed and are linked to deals by owner/firm mention, then
 * merged with any same-named derived firm (e.g., REDACTED-672 lender ↔ REDACTED-583, REDACTED-672 title).
 */
export function deriveCounterparties(args: {
  properties: Property[];
  loans: Loan[];
  insurance: InsurancePolicy[];
  deals: Deal[];
}): Counterparty[] {
  const { properties, loans, insurance, deals } = args;
  const firms = new Map<string, Counterparty>();

  const ensureFirm = (name: string, kind: CounterpartyKind, market: string | null): Counterparty => {
    const key = norm(name);
    let cp = firms.get(key);
    if (!cp) {
      cp = {
        id: `cp-${slug(name)}`,
        name,
        kind,
        firm: name,
        role: null,
        email: null,
        phone: null,
        market,
        notes: null,
        source: 'workbook',
        links: { properties: [], loans: [], deals: [], insurance: [] },
      };
      firms.set(key, cp);
    }
    return cp;
  };

  // Lenders — external (borrower) debt positions in the Loan Index.
  for (const ln of loans) {
    const lender = ln.lender ?? (ln.direction === 'borrower' ? ln.counterparty : null);
    if (!lender) continue;
    const cp = ensureFirm(lender, 'lender', null);
    pushUniq(cp.links.loans, ln.id);
    for (const p of properties) if (p.lender && norm(p.lender) === norm(lender)) pushUniq(cp.links.properties, p.id);
  }

  // Lenders — also surfaced through the acquisitions pipeline.
  for (const d of deals) {
    if (!d.lender) continue;
    const cp = ensureFirm(d.lender, 'lender', d.market ?? null);
    pushUniq(cp.links.deals, d.id);
    for (const p of properties) if (p.lender && norm(p.lender) === norm(d.lender)) pushUniq(cp.links.properties, p.id);
  }

  // Carriers — from the Insurance Renewals schedule.
  for (const ins of insurance) {
    if (!ins.carrier) continue;
    const cp = ensureFirm(ins.carrier, 'carrier', null);
    pushUniq(cp.links.insurance, ins.id);
    for (const p of properties) if (norm(p.name) === norm(ins.property)) pushUniq(cp.links.properties, p.id);
  }

  // People — clone the seed (parse runs on every workbook change; never mutate the seed).
  const people: Counterparty[] = SEED_PEOPLE.map((p) => ({
    ...p,
    links: { properties: [...p.links.properties], loans: [...p.links.loans], deals: [...p.links.deals], insurance: [...p.links.insurance] },
  }));

  for (const person of people) {
    const tokens = person.name
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const firmKey = person.firm ? norm(person.firm) : '';

    // Link to deals that name the person (owner / next action / status) or their firm.
    for (const d of deals) {
      const hay = `${d.owner ?? ''} ${d.lender ?? ''} ${d.nextAction ?? ''} ${d.status ?? ''}`.toLowerCase();
      const firmMatch = firmKey.length > 0 && hay.includes(firmKey);
      const nameMatch = tokens.some((t) => hay.includes(t));
      if (firmMatch || nameMatch) pushUniq(person.links.deals, d.id);
    }

    // Merge with a same-named derived firm: person inherits its links; firm gets the contact.
    const firm = firmKey ? firms.get(firmKey) : undefined;
    if (firm) {
      firm.links.properties.forEach((id) => pushUniq(person.links.properties, id));
      firm.links.loans.forEach((id) => pushUniq(person.links.loans, id));
      firm.links.deals.forEach((id) => pushUniq(person.links.deals, id));
      firm.links.insurance.forEach((id) => pushUniq(person.links.insurance, id));
      if (!firm.email) firm.email = person.email;
      if (!firm.notes) firm.notes = `Primary contact: ${person.name}${person.role ? ` — ${person.role}` : ''}`;
    }
  }

  return [...firms.values(), ...people].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}
