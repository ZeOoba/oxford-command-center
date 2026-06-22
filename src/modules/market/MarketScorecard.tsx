// src/modules/market/MarketScorecard.tsx
//
// Phase 5 W3 — per-cluster market intelligence scorecard card.
// Always shows "Advisory only" label (advisoryOnly === true per spec §4.3).
import { Badge } from '@/primitives/Badge';
import { Card } from '@/primitives/Card';
import type { MarketSignal } from './hooks';
import { marketActionLabel, marketActionTone } from './hooks';

interface Props { signal: MarketSignal }

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, width: '100%' }}>
      <div style={{
        height: '100%',
        width: `${Math.round(value * 100)}%`,
        background: value >= 0.75 ? 'var(--color-pos, #22c55e)' : value >= 0.5 ? 'var(--color-warn, #f59e0b)' : 'var(--color-neg, #ef4444)',
        borderRadius: 2,
      }} />
    </div>
  );
}

function SourceTag({ source, stale }: { source: string; stale: boolean }) {
  return (
    <span style={{
      fontSize: 10, padding: '1px 5px', borderRadius: 3,
      background: 'var(--surface-alt, var(--surface))',
      border: '1px solid var(--border)',
      color: stale ? 'var(--text-tertiary)' : 'var(--text-secondary)',
      textDecoration: stale ? 'line-through' : 'none',
    }}>
      {source}
    </span>
  );
}

export function MarketScorecard({ signal }: Props) {
  return (
    <Card>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{signal.cluster}</span>
          <Badge tone={marketActionTone(signal.action)}>{marketActionLabel(signal.action)}</Badge>
          <span style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--color-warn, #f59e0b)' }}>
            Advisory only
          </span>
        </div>

        {/* Score + confidence */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            Score <strong style={{ color: 'var(--text-primary)', fontSize: 14 }}>
              {signal.marketScore !== null ? signal.marketScore.toFixed(0) : '—'}
            </strong>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>/100</span>
          </span>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ConfidenceBar value={signal.confidence01} />
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {Math.round(signal.confidence01 * 100)}% conf ({signal.confidenceTier})
            </span>
          </div>
        </div>

        {/* Source tags */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {signal.sources.map((src, i) => (
            <SourceTag key={i} source={src.source} stale={src.stale} />
          ))}
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 4 }}>
            {signal.oraPropertyCount} ORA prop{signal.oraPropertyCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    </Card>
  );
}
