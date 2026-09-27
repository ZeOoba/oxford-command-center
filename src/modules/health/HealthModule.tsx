import type { ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useBrain } from '@/data/brain-context';
import { useHealth } from '@/data/health';
import { computeFreshness, isBriefStale } from '@/lib/freshness';
import { relativeTime } from '@/lib/time';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { reconciliationCardState } from './reconciliation-card';
import { feedRowTone, feedRowValue, feedsBadge } from './feed-row';

type Tone = 'ok' | 'warn' | 'error' | 'info';

const ICON: Record<Tone, typeof Info> = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle, info: Info };
const COLOR: Record<Tone, string> = {
  ok: 'var(--color-pos)',
  warn: 'var(--color-warn)',
  error: 'var(--color-neg)',
  info: 'var(--text-tertiary)',
};

function Row({ tone, label, value }: { tone: Tone; label: string; value: ReactNode }) {
  const I = ICON[tone];
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <span className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <I size={14} style={{ color: COLOR[tone] }} /> {label}
      </span>
      <span className="num text-right text-xs" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </li>
  );
}

/**
 * System Health (Phase 6) — per-source status with no silent fallbacks: data freshness, runtime
 * reconciliation, data-quality flags, and AI availability. Honest about what is live vs static vs off.
 */
export function HealthModule() {
  const { data } = useSnapshot();
  const { state } = useBrain();
  const f = computeFreshness(state);
  // Shared with HealthDot (src/data/health.ts, 2026-09-23 review gap #2) — one `/api/health` poll,
  // keyed on brain-state status (I-2, same review), not two independently-effectful fetches.
  const healthQuery = useHealth();
  const health = healthQuery.data ?? null;
  const healthErr = healthQuery.isError;

  const flags = data?.snapshot.dataQuality ?? [];
  const recon = reconciliationCardState(flags);
  const errors = flags.filter((x) => x.severity === 'error');
  const warns = flags.filter((x) => x.severity === 'warn');

  const freshTone: Tone = f.kind === 'live' ? 'ok' : f.kind === 'stale' || f.kind === 'offline' ? 'error' : 'info';
  const aiTone: Tone = health?.ai?.configured ? 'ok' : 'warn';
  const aiValue = healthErr
    ? 'Live server not connected (mirror is read-only)'
    : health?.ai
      ? health.ai.configured
        ? `Live · ${health.ai.model}`
        : 'Offline — no API key (deterministic responder)'
      : 'Checking…';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Data Source" trailing={<Badge tone={freshTone === 'ok' ? 'green' : freshTone === 'error' ? 'red' : 'neutral'}>{f.label}</Badge>} />
          <ul className="flex flex-col">
            <Row tone={freshTone} label="Freshness" value={f.detail ?? f.label} />
            <Row tone={state?.source === 'workbook' ? 'ok' : 'info'} label="Source" value={state?.source ?? '—'} />
            <Row tone="info" label="Last updated" value={state?.lastUpdated ? relativeTime(state.lastUpdated) : '—'} />
            {state?.lastError && <Row tone="error" label="Last error" value={state.lastError} />}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Reconciliation" trailing={<Badge tone={recon.badgeTone}>{recon.badgeLabel}</Badge>} />
          <ul className="flex flex-col">
            {recon.rows.length === 0 ? (
              <Row tone="ok" label="Internal invariants" value="All checks pass" />
            ) : (
              recon.rows.map((r, i) => <Row key={i} tone={r.severity === 'error' ? 'error' : 'warn'} label={r.field} value={r.issue} />)
            )}
          </ul>
        </Card>

        <Card>
          <CardHeader title="AI Assistant" trailing={<Badge tone={aiTone === 'ok' ? 'green' : 'amber'}>{health?.ai?.configured ? 'Live' : 'Fallback'}</Badge>} />
          <ul className="flex flex-col">
            <Row tone={aiTone} label="Model endpoint" value={aiValue} />
          </ul>
        </Card>

        <Card>
          <CardHeader title="Data Quality" trailing={<Badge tone={errors.length ? 'red' : warns.length ? 'amber' : 'green'}>{flags.length} flag{flags.length === 1 ? '' : 's'}</Badge>} />
          <ul className="flex flex-col">
            {flags.length === 0 ? (
              <Row tone="ok" label="Parsed data" value="No flags" />
            ) : (
              flags.slice(0, 14).map((fl, i) => (
                <Row key={i} tone={fl.severity === 'error' ? 'error' : fl.severity === 'warn' ? 'warn' : 'info'} label={`${fl.entity} · ${fl.field}`} value={fl.issue} />
              ))
            )}
          </ul>
        </Card>

        {!healthErr && (
          <Card>
            {(() => {
              const b = health?.brief;
              const stale = b != null && isBriefStale(b.ranAt);
              const briefBadgeTone: 'green' | 'red' | 'amber' | 'neutral' =
                b == null ? 'neutral' : b.failures.length > 0 ? 'red' : stale ? 'amber' : 'green';
              const briefBadgeLabel = b == null ? 'Not yet run' : b.failures.length > 0 ? 'Failures' : stale ? 'Stale' : 'OK';
              return (
                <>
                  <CardHeader title="Daily Brief" trailing={<Badge tone={briefBadgeTone}>{briefBadgeLabel}</Badge>} />
                  <ul className="flex flex-col">
                    {b == null ? (
                      <Row tone="info" label="Status" value="No run recorded yet" />
                    ) : (
                      <>
                        <Row tone="info" label="Last run" value={relativeTime(b.ranAt)} />
                        <Row
                          tone={b.briefSent ? 'ok' : 'warn'}
                          label="Brief sent"
                          value={b.briefSent ? 'Yes' : 'No'}
                        />
                        <Row
                          tone={b.alertsSent > 0 ? 'ok' : 'info'}
                          label="Alerts sent"
                          value={String(b.alertsSent)}
                        />
                        {b.failures.map((f, i) => (
                          <Row key={i} tone="error" label={`Failure ${i + 1}`} value={f} />
                        ))}
                      </>
                    )}
                  </ul>
                </>
              );
            })()}
          </Card>
        )}

        {!healthErr && health?.feeds && (() => {
          const badge = feedsBadge(health.feeds);
          return (
            <Card>
              <CardHeader title="Data Feeds" trailing={<Badge tone={badge.tone}>{badge.label}</Badge>} />
              <ul className="flex flex-col">
                {health.feeds.map((f) => (
                  <Row key={f.id} tone={feedRowTone(f)} label={f.label} value={feedRowValue(f)} />
                ))}
              </ul>
            </Card>
          );
        })()}
      </div>
    </div>
  );
}
