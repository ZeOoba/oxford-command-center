// src/modules/capital/AllocationCard.tsx
//
// Phase 5 W2 — per-asset allocation verdict card with action chip, risk band,
// return vs hurdle, confidence bar, and reasons accordion.
import { useState } from 'react';
import { Card } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import type { AllocationVerdict } from './hooks';
import { actionLabel, actionColor, riskBandTone } from './hooks';

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, width: '100%' }}>
      <div style={{
        height: '100%',
        width: `${Math.round(value * 100)}%`,
        background: value >= 0.75 ? 'var(--color-pos)' : value >= 0.5 ? 'var(--color-warn)' : 'var(--color-neg)',
        borderRadius: 2,
        transition: 'width 0.3s',
      }} />
    </div>
  );
}

interface Props { verdict: AllocationVerdict; hurdleRatePct: number }

export function AllocationCard({ verdict, hurdleRatePct }: Props) {
  const [open, setOpen] = useState(false);

  const returnStr = fmtPct(verdict.expectedReturnPct);
  const hurdleStr = fmtPct(hurdleRatePct);
  const aboveHurdle = verdict.returnAboveHurdle;

  return (
    <Card>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontWeight: 700, fontSize: 13, letterSpacing: '0.03em',
            padding: '2px 8px', borderRadius: 4,
            background: `color-mix(in oklab, ${actionColor(verdict.action)} 15%, transparent)`,
            color: actionColor(verdict.action),
            border: `1px solid color-mix(in oklab, ${actionColor(verdict.action)} 40%, transparent)`,
          }}>
            {actionLabel(verdict.action)}
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
            {verdict.propertyName ?? verdict.propertyId}
          </span>
          <Badge tone={riskBandTone(verdict.riskBand)}>
            {verdict.riskBand}
          </Badge>
        </div>

        {/* Return vs hurdle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>
            Return <strong style={{ color: 'var(--text-primary)' }}>{returnStr}</strong>
            {aboveHurdle !== null && (
              <span style={{ marginLeft: 4, color: aboveHurdle ? 'var(--text-pos)' : 'var(--text-neg)' }}>
                {aboveHurdle ? '↑' : '↓'} vs {hurdleStr} hurdle
              </span>
            )}
          </span>
          <span>Timeline <strong style={{ color: 'var(--text-primary)' }}>{verdict.timelineMonths}mo</strong></span>
          {verdict.advisoryOnly && (
            <span style={{ color: 'var(--text-warn)', fontStyle: 'italic' }}>advisory</span>
          )}
        </div>

        {/* Confidence bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
          <span style={{ whiteSpace: 'nowrap' }}>
            Conf {Math.round(verdict.confidence01 * 100)}%
          </span>
          <ConfidenceBar value={verdict.confidence01} />
          <span>{verdict.confidenceTier}</span>
        </div>

        {/* Reasons accordion */}
        {verdict.reasons.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={"allocation-reasons-" + verdict.propertyId}
              onClick={() => setOpen(o => !o)}
              style={{
                fontSize: 11, color: 'var(--text-secondary)', background: 'none',
                border: 'none', cursor: 'pointer', padding: 0, display: 'flex', gap: 4,
              }}
            >
              {open ? '▾' : '▸'} {verdict.reasons[0]}
            </button>
            {open && verdict.reasons.length > 1 && (
              <ul id={"allocation-reasons-" + verdict.propertyId} style={{ margin: '4px 0 0 12px', padding: 0, listStyle: 'disc', fontSize: 11, color: 'var(--text-tertiary)' }}>
                {verdict.reasons.slice(1).map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
