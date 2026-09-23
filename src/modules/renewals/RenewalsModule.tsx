import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Mail } from 'lucide-react';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { useUi } from '@/brain/ui-context';
import { advanceRenewalStage } from '@/data/actions';
import { fmtUsdCompact, fmtDate } from '@analytics/index';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { renewalBoard, type RenewalCard } from '@/brain/renewals';
import { RENEWAL_STAGES, nextRenewalStage, type RenewalStage } from '@contracts/index';
import { useLeaseForecast, likelihoodTone, buildSignalMap } from '../leasing/hooks';
import type { RenewalSignal } from '../leasing/hooks';
import { dayLabel } from './day-label';

const STAGE_TONE: Record<RenewalStage, BadgeTone> = {
  Expiring: 'red',
  Outreach: 'amber',
  Negotiating: 'blue',
  LOI: 'purple',
  Executed: 'green',
};

const dayTone = (d: number | null): BadgeTone => (d === null ? 'neutral' : d < 0 ? 'red' : d <= 30 ? 'amber' : 'neutral');

export function RenewalsModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const ui = useUi();
  const qc = useQueryClient();
  const advance = useMutation({
    mutationFn: (v: { leaseId: string; stage: RenewalStage }) => advanceRenewalStage(v.leaseId, v.stage),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  // Leasing forecast: renewal signals for likelihood badges (degrades gracefully when warehouse unavailable)
  const { data: forecast } = useLeaseForecast();
  const signalMap = useMemo(() => buildSignalMap(forecast?.signals ?? []), [forecast?.signals]);

  const board = useMemo(
    () => (data ? renewalBoard(data.snapshot, new Date().toISOString().slice(0, 10)) : null),
    [data],
  );
  if (gate) return gate;
  if (!data || !board) return null;
  const total = RENEWAL_STAGES.reduce((n, s) => n + board[s].length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="amber" dot>Leases expiring ≤75 days — needs action now</Badge>
        <span className="num text-2xs uppercase" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          {total} in pipeline
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {RENEWAL_STAGES.map((stage) => (
          <div key={stage} className="flex flex-col rounded-[var(--radius-md)]" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <span className="text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em' }}>
                <Badge tone={STAGE_TONE[stage]}>{stage}</Badge>
              </span>
              <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{board[stage].length}</span>
            </div>
            <div className="flex flex-col gap-2 p-2" style={{ minHeight: 80 }}>
              {board[stage].length === 0 ? (
                <span className="px-1 py-4 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>—</span>
              ) : (
                board[stage].map((card) => (
                  <RenewalCardView
                    key={card.leaseId}
                    card={card}
                    signal={signalMap.get(card.leaseId)}
                    isPending={advance.isPending}
                    onAdvance={() => {
                      const next = nextRenewalStage(card.stage);
                      if (next) advance.mutate({ leaseId: card.leaseId, stage: next });
                    }}
                    onDraft={() => ui.openDraft({ kind: 'renewal', entity: { type: 'lease', id: card.leaseId } })}
                    onOpen={() => ui.openEntity({ type: 'lease', id: card.leaseId })}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RenewalCardView({
  card, signal, isPending, onAdvance, onDraft, onOpen,
}: {
  card: RenewalCard;
  signal?: RenewalSignal;
  isPending: boolean;
  onAdvance: () => void;
  onDraft: () => void;
  onOpen: () => void;
}) {
  const canAdvance = nextRenewalStage(card.stage) !== null;
  return (
    <div className="rounded-[var(--radius-sm)] p-2.5" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      <button onClick={onOpen} className="block w-full text-left">
        <div className="text-xs" style={{ fontWeight: 600 }}>{card.tenant}</div>
        <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{card.propertyKey} {card.unit ?? ''}</div>
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        <Badge tone={dayTone(card.daysToExpiry)}>{dayLabel(card.daysToExpiry)}</Badge>
        <span className="num text-2xs" style={{ color: 'var(--text-secondary)' }}>{fmtUsdCompact(card.annualRent)}</span>
      </div>
      {signal && (
        <div className="mt-1 flex items-center gap-1.5">
          <Badge tone={likelihoodTone(signal.likelihood)}>{signal.likelihood}</Badge>
          {signal.tenureMonths !== null && (
            <span className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {signal.tenureMonths} mo tenure
            </span>
          )}
        </div>
      )}
      <div className="mt-1 num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>exp {fmtDate(card.leaseEnd)}</div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={onDraft}
          className="flex items-center gap-1 text-2xs"
          style={{ color: 'var(--text-accent)' }}
          aria-label={`Draft renewal email for ${card.tenant}`}
        >
          <Mail size={11} /> Draft
        </button>
        <span className="flex-1" />
        {canAdvance && (
          <button
            onClick={onAdvance}
            disabled={isPending}
            className="flex items-center gap-1 text-2xs"
            style={{ color: 'var(--text-secondary)', opacity: isPending ? 0.5 : 1 }}
            aria-label={`Advance ${card.tenant} to ${nextRenewalStage(card.stage)}`}
          >
            {nextRenewalStage(card.stage)} <ArrowRight size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
