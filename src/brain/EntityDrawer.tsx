import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import { X, Mail, ChevronRight } from 'lucide-react';
import type { PortfolioSnapshot, DealStage } from '@contracts/index';
import type { DraftRequest } from './draft';
import {
  fmtUsd,
  fmtUsdCompact,
  fmtPct,
  fmtSf,
  fmtDate,
  fmtMultiple,
  fmtMonths,
} from '@analytics/index';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useBrain } from '@/data/brain-context';
import { computeFreshness } from '@/lib/freshness';
import { advanceDealStage } from '@/data/actions';
import { useUi, type EntityRef } from './ui-context';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Sparkline } from '@/charts/Sparkline';
import { DealDrawer } from './DealDrawer';

const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];
const nextStage = (s: DealStage): DealStage | null => {
  const i = STAGE_FLOW.indexOf(s);
  return i >= 0 && i < STAGE_FLOW.length - 1 ? STAGE_FLOW[i + 1]! : null;
};

const KIND_LABEL: Record<string, string> = {
  lender: 'Lender',
  carrier: 'Insurance Carrier',
  counsel: 'Counsel',
  title: 'Title / Closing',
  broker: 'Broker',
  principal: 'Principal',
  partner: 'Partner',
};
const KIND_TONE: Record<string, BadgeTone> = {
  counsel: 'purple',
  title: 'blue',
  lender: 'amber',
  carrier: 'green',
  principal: 'gold',
  broker: 'neutral',
  partner: 'neutral',
};

interface DetailRow {
  label: string;
  value: ReactNode;
}
interface Chip {
  ref: EntityRef;
  label: string;
}
interface Content {
  kind: string;
  title: string;
  subtitle: string;
  tone: BadgeTone;
  badge?: string;
  rows: DetailRow[];
  chips: Chip[];
  extra?: ReactNode;
  /** Draft-only CTAs (Phase 5). */
  actions?: Array<{ label: string; draft: DraftRequest }>;
  /** Live-only write-back: advance a deal's stage (overlay). */
  writeAction?: { dealId: string; nextStage: DealStage; label: string };
}

export function EntityDrawer() {
  const ui = useUi();
  const { data } = useSnapshot();
  const { state } = useBrain();
  const qc = useQueryClient();
  const open = !!ui.selected;
  // Write-back is only offered against the live server, never the static mirror.
  const canWrite = computeFreshness(state).kind === 'live';

  const onAdvanceStage = async (dealId: string, stage: DealStage, label: string) => {
    if (!window.confirm(`${label}? This updates the local overlay — the master workbook is unchanged.`)) return;
    try {
      await advanceDealStage(dealId, stage);
      await qc.invalidateQueries({ queryKey: SNAPSHOT_KEY });
    } catch {
      /* surfaced by the snapshot not changing; kept silent here */
    }
  };

  return (
    <AnimatePresence>
      {open && data && ui.selected &&
        (ui.selected.type === 'deal' ? (
          <DealDrawer
            dealId={ui.selected.id}
            snapshot={data.snapshot}
            canWrite={canWrite}
            onClose={ui.closeEntity}
            onOpen={ui.openEntity}
            onDraft={ui.openDraft}
            onAdvanceStage={onAdvanceStage}
          />
        ) : (
          <Panel
            content={resolve(ui.selected, data.snapshot)}
            onClose={ui.closeEntity}
            onOpen={ui.openEntity}
            onDraft={ui.openDraft}
            canWrite={canWrite}
            onAdvanceStage={onAdvanceStage}
          />
        ))}
    </AnimatePresence>
  );
}

function Panel({
  content,
  onClose,
  onOpen,
  onDraft,
  canWrite,
  onAdvanceStage,
}: {
  content: Content | null;
  onClose: () => void;
  onOpen: (ref: EntityRef) => void;
  onDraft: (req: DraftRequest) => void;
  canWrite: boolean;
  onAdvanceStage: (dealId: string, stage: DealStage, label: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Entity detail">
      <motion.div
        className="absolute inset-0"
        style={{ background: 'rgba(2,4,8,0.5)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        className="absolute right-0 top-0 flex h-full w-[440px] max-w-[94vw] flex-col"
        style={{ background: 'var(--surface-raised)', borderLeft: '1px solid var(--border-strong)' }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        {!content ? (
          <div className="grid flex-1 place-items-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            Record not found.
          </div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge tone={content.tone}>{content.kind}</Badge>
                  {content.badge && <Badge tone="neutral">{content.badge}</Badge>}
                </div>
                <h2 className="display text-lg leading-tight" style={{ color: 'var(--text-primary)' }}>
                  {content.title}
                </h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {content.subtitle}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)]"
                style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              >
                <X size={15} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {((content.actions && content.actions.length > 0) || (content.writeAction && canWrite)) && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {content.actions?.map((a, i) => (
                    <button
                      key={i}
                      onClick={() => onDraft(a.draft)}
                      className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold"
                      style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
                    >
                      <Mail size={13} /> {a.label}
                    </button>
                  ))}
                  {content.writeAction && canWrite && (
                    <button
                      onClick={() => onAdvanceStage(content.writeAction!.dealId, content.writeAction!.nextStage, content.writeAction!.label)}
                      className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold"
                      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
                    >
                      {content.writeAction.label} <ChevronRight size={13} />
                    </button>
                  )}
                </div>
              )}
              {content.extra && <div className="mb-4">{content.extra}</div>}
              <dl className="flex flex-col">
                {content.rows.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 py-2"
                    style={{ borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}
                  >
                    <dt className="num shrink-0 text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
                      {r.label}
                    </dt>
                    <dd className="num text-right text-sm" style={{ color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }}>
                      {r.value}
                    </dd>
                  </div>
                ))}
              </dl>

              {content.chips.length > 0 && (
                <div className="mt-5">
                  <div className="num mb-2 text-2xs uppercase" style={{ letterSpacing: '0.14em', color: 'var(--text-tertiary)' }}>
                    Related
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {content.chips.map((c, i) => (
                      <button
                        key={i}
                        onClick={() => onOpen(c.ref)}
                        className="num rounded-full px-2.5 py-1 text-2xs transition-colors"
                        style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </motion.aside>
    </div>
  );
}

/** Reverse edges: counterparties whose links touch this entity → chips back to them. */
function counterpartyChips(
  s: PortfolioSnapshot,
  type: 'property' | 'loan' | 'deal' | 'insurance',
  id: string,
): Chip[] {
  return s.counterparties
    .filter((cp) => {
      const arr =
        type === 'property'
          ? cp.links.properties
          : type === 'loan'
            ? cp.links.loans
            : type === 'deal'
              ? cp.links.deals
              : cp.links.insurance;
      return arr.includes(id);
    })
    .map((cp) => ({ ref: { type: 'counterparty' as const, id: cp.id }, label: cp.name }));
}

function resolve(sel: EntityRef, s: PortfolioSnapshot): Content | null {
  switch (sel.type) {
    case 'property': {
      const p = s.properties.find((x) => x.id === sel.id);
      if (!p) return null;
      const leases = s.leases.filter((l) => l.propertyId === p.id);
      return {
        kind: 'Property',
        title: p.name,
        subtitle: `${p.market} · ${p.type}`,
        tone: 'gold',
        badge: p.encumbered ? 'Encumbered' : 'Free & clear',
        rows: [
          { label: 'Square Feet', value: fmtSf(p.sf) },
          { label: 'Tenants', value: p.tenantCount },
          { label: 'Occupancy', value: fmtPct(p.occPct) },
          { label: 'NOI (Oxford)', value: fmtUsd(p.noi) },
          { label: 'Cap Rate', value: fmtPct(p.capRate) },
          { label: 'DSCR', value: p.dscr !== null ? fmtMultiple(p.dscr) : '—' },
          { label: 'Oxford Value', value: fmtUsd(p.oxfordValue) },
          { label: 'Ownership', value: fmtPct(p.oxfordOwnPct) },
          { label: 'Loan Balance', value: fmtUsd(p.loanBalance) },
          { label: 'LTV', value: fmtPct(p.ltv) },
          { label: 'Lender', value: p.lender ?? '—' },
          { label: 'Equity Invested', value: fmtUsd(p.equityInvested) },
          { label: 'Cash-on-Cash', value: fmtPct(p.cashOnCash) },
          { label: 'Rent $/SF', value: p.rentPerSf !== null ? `$${p.rentPerSf.toFixed(2)}` : '—' },
          { label: 'Acquired', value: fmtDate(p.acqDate) },
        ],
        chips: [
          ...leases.slice(0, 16).map((l) => ({ ref: { type: 'lease' as const, id: l.id }, label: l.company ?? l.tenantName })),
          ...counterpartyChips(s, 'property', p.id),
        ],
      };
    }
    case 'lease': {
      const l = s.leases.find((x) => x.id === sel.id);
      if (!l) return null;
      const prop = s.properties.find((p) => p.id === l.propertyId);
      return {
        kind: 'Lease',
        title: l.company ?? l.tenantName,
        subtitle: `${l.propertyKey}${l.unit ? ` · Unit ${l.unit}` : ''}`,
        tone: l.status === 'Expired' ? 'red' : l.status === 'Expiring Soon' ? 'amber' : 'green',
        badge: l.status,
        rows: [
          { label: 'Contact', value: l.tenantName },
          { label: 'Square Feet', value: fmtSf(l.sf) },
          { label: 'Monthly Rent', value: fmtUsd(l.monthlyRent) },
          { label: 'Annual Rent', value: fmtUsd(l.annualRent) },
          { label: 'Rent $/SF', value: l.rentPerSf !== null ? `$${l.rentPerSf.toFixed(2)}` : '—' },
          { label: 'Lease Start', value: fmtDate(l.leaseStart) },
          { label: 'Lease End', value: fmtDate(l.leaseEnd) },
          { label: 'Months to Expiry', value: l.monthsToExpiry !== null ? fmtMonths(l.monthsToExpiry) : '—' },
          { label: 'Escalation', value: l.escalationPct !== null ? fmtPct(l.escalationPct, 2) : '—' },
          { label: 'Escalation Date', value: fmtDate(l.escalationDate) },
        ],
        chips: prop ? [{ ref: { type: 'property', id: prop.id }, label: prop.name }] : [],
        actions: [{ label: 'Draft renewal', draft: { kind: 'renewal', entity: { type: 'lease', id: l.id } } }],
      };
    }
    case 'loan': {
      const ln = s.loans.find((x) => x.id === sel.id);
      if (!ln) return null;
      const prop = s.properties.find(
        (p) => ln.lender && p.lender === ln.lender,
      );
      return {
        kind: 'Loan',
        title: ln.name,
        subtitle: `${ln.direction === 'borrower' ? 'We pay' : ln.direction === 'lender' ? 'We receive' : 'Intercompany'} · ${ln.counterparty ?? ''}`,
        tone: ln.balloon ? 'red' : ln.direction === 'lender' ? 'blue' : 'amber',
        badge: ln.balloon ? 'Balloon' : (ln.loanType ?? undefined),
        rows: [
          { label: 'Current Balance', value: fmtUsd(ln.currentBalance) },
          { label: 'Rate', value: ln.rate !== null ? fmtPct(ln.rate, 3) : '—' },
          { label: 'Monthly Payment', value: fmtUsd(ln.monthlyPmt) },
          { label: 'Type', value: ln.loanType ?? '—' },
          { label: 'Status', value: ln.status ?? '—' },
          { label: 'Maturity', value: ln.isDemand ? 'Demand' : fmtDate(ln.maturity) },
          { label: 'Months to Maturity', value: ln.monthsToMaturity !== null ? fmtMonths(ln.monthsToMaturity) : '—' },
          { label: 'LTV', value: fmtPct(ln.ltv) },
        ],
        chips: [
          ...(prop ? [{ ref: { type: 'property' as const, id: prop.id }, label: prop.name }] : []),
          ...counterpartyChips(s, 'loan', ln.id),
        ],
        actions: [{ label: 'Draft refinance note', draft: { kind: 'refi', entity: { type: 'loan', id: ln.id } } }],
      };
    }
    case 'deal': {
      const d = s.deals.find((x) => x.id === sel.id);
      if (!d) return null;
      return {
        kind: 'Deal',
        title: d.name,
        subtitle: d.location ?? d.stage,
        tone: d.confidential ? 'purple' : 'gold',
        badge: d.stage,
        rows: [
          { label: 'Stage', value: d.stage },
          { label: 'Market', value: d.market ?? '—' },
          { label: 'Square Feet', value: d.sf !== null ? fmtSf(d.sf) : '—' },
          { label: 'Buildings', value: d.buildings ?? '—' },
          { label: 'Est. Price', value: fmtUsdCompact(d.estPrice) },
          { label: 'Cap Rate', value: fmtPct(d.capRate, 2) },
          { label: 'IRR', value: fmtPct(d.irr) },
          { label: 'Equity Multiple', value: d.equityMultiple !== null ? fmtMultiple(d.equityMultiple) : '—' },
          { label: 'Hold', value: d.holdYrs !== null ? `${d.holdYrs} yr` : '—' },
          { label: 'Lender', value: d.lender ?? '—' },
          { label: 'Owner', value: d.owner ?? '—' },
          { label: 'Next Action', value: d.nextAction ?? '—' },
        ],
        chips: counterpartyChips(s, 'deal', d.id),
        actions: [{ label: 'Draft LOI handoff', draft: { kind: 'loi', entity: { type: 'deal', id: d.id } } }],
        writeAction: ((): Content['writeAction'] => {
          const ns = nextStage(d.stage);
          return ns ? { dealId: d.id, nextStage: ns, label: `Advance to ${ns}` } : undefined;
        })(),
      };
    }
    case 'insurance': {
      const p = s.insurance.find((x) => x.id === sel.id);
      if (!p) return null;
      return {
        kind: 'Insurance',
        title: p.property,
        subtitle: `${p.coverage ?? 'Policy'} · ${p.carrier ?? ''}`,
        tone: p.status === 'Expired' || p.status === 'Cancelled' ? 'red' : p.status === 'Current' ? 'green' : 'amber',
        badge: p.status,
        rows: [
          { label: 'Named Insured', value: p.entity ?? '—' },
          { label: 'Coverage', value: p.coverage ?? '—' },
          { label: 'Carrier', value: p.carrier ?? '—' },
          { label: 'Policy #', value: p.policyNo ?? '—' },
          { label: 'Premium', value: fmtUsd(p.premium) },
          { label: 'Effective', value: fmtDate(p.effective) },
          { label: 'Expires', value: fmtDate(p.expires) },
          { label: 'Days to Expiry', value: p.daysToExpiry ?? '—' },
          { label: 'Notes', value: p.notes ?? '—' },
        ],
        chips: counterpartyChips(s, 'insurance', p.id),
        actions: [{ label: 'Draft carrier note', draft: { kind: 'insurance', entity: { type: 'insurance', id: p.id } } }],
      };
    }
    case 'cashEntity': {
      const c = s.cash.entities.find((x) => x.id === sel.id);
      if (!c) return null;
      const series = s.cash.history.map((h) => h.balances[c.entity]).filter((v): v is number => typeof v === 'number');
      return {
        kind: 'Cash',
        title: c.entity,
        subtitle: `${fmtPct(c.pctOfPortfolio)} of total cash`,
        tone: c.trend === 'up' ? 'green' : c.trend === 'down' ? 'red' : 'neutral',
        badge: c.trend,
        extra:
          series.length > 1 ? (
            <div className="rounded-[var(--radius-md)] p-3" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
              <div className="num mb-2 text-2xs uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
                12-Month Balance
              </div>
              <Sparkline data={series} width={380} height={56} color={c.trend === 'down' ? 'var(--color-neg)' : 'var(--color-pos)'} />
            </div>
          ) : undefined,
        rows: [
          { label: 'Current Balance', value: fmtUsd(c.currentBalance) },
          { label: 'Prior Balance', value: fmtUsd(c.priorBalance) },
          { label: 'Δ Period', value: c.deltaPct !== null ? fmtPct(c.deltaPct) : '—' },
          { label: '3-Mo Average', value: fmtUsd(c.avg3) },
          { label: 'Min (all-time)', value: fmtUsd(c.minAllTime) },
          { label: 'Max (all-time)', value: fmtUsd(c.maxAllTime) },
          { label: '12-Mo Growth', value: c.growth12Pct !== null ? fmtPct(c.growth12Pct) : '—' },
          { label: '% of Portfolio', value: fmtPct(c.pctOfPortfolio) },
        ],
        chips: [],
      };
    }
    case 'counterparty': {
      const cp = s.counterparties.find((x) => x.id === sel.id);
      if (!cp) return null;
      const chips: Chip[] = [
        ...cp.links.deals.map((id): Chip | null => {
          const d = s.deals.find((x) => x.id === id);
          return d ? { ref: { type: 'deal', id }, label: d.shortName ?? d.name } : null;
        }),
        ...cp.links.properties.map((id): Chip | null => {
          const p = s.properties.find((x) => x.id === id);
          return p ? { ref: { type: 'property', id }, label: p.name } : null;
        }),
        ...cp.links.loans.map((id): Chip | null => {
          const l = s.loans.find((x) => x.id === id);
          return l ? { ref: { type: 'loan', id }, label: l.name } : null;
        }),
        ...cp.links.insurance.map((id): Chip | null => {
          const i = s.insurance.find((x) => x.id === id);
          return i ? { ref: { type: 'insurance', id }, label: i.property } : null;
        }),
      ].filter((c): c is Chip => c !== null);
      return {
        kind: KIND_LABEL[cp.kind] ?? 'Relationship',
        title: cp.name,
        subtitle: cp.firm && cp.firm !== cp.name ? cp.firm : (cp.role ?? cp.kind),
        tone: KIND_TONE[cp.kind] ?? 'neutral',
        badge: cp.source === 'memory' ? 'Memory' : 'Workbook',
        rows: [
          { label: 'Role', value: cp.role ?? '—' },
          { label: 'Firm', value: cp.firm ?? '—' },
          { label: 'Email', value: cp.email ?? '—' },
          { label: 'Phone', value: cp.phone ?? '—' },
          { label: 'Market', value: cp.market ?? '—' },
          { label: 'Deals', value: cp.links.deals.length || '—' },
          { label: 'Properties', value: cp.links.properties.length || '—' },
          { label: 'Loans', value: cp.links.loans.length || '—' },
          { label: 'Insurance', value: cp.links.insurance.length || '—' },
          ...(cp.notes ? [{ label: 'Notes', value: cp.notes }] : []),
        ],
        chips,
        actions: [{ label: 'Draft email', draft: { kind: 'general', entity: { type: 'counterparty', id: cp.id } } }],
      };
    }
    default:
      return null;
  }
}
