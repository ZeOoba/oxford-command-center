// src/modules/capital/HurdleRateBanner.tsx
//
// Phase 5 W2 — Advisory banner rendered when the hurdle rate is still 'proposed'.
// Hidden once Gabriel ratifies the governor.
import type { HurdleRateConfig } from './hooks';

interface Props { hurdleRate: HurdleRateConfig }

export function HurdleRateBanner({ hurdleRate }: Props) {
  if (hurdleRate.ratification !== 'proposed') return null;
  const pct = (hurdleRate.hurdleRatePct * 100).toFixed(1);
  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 6,
      background: 'color-mix(in oklab, var(--color-warn) 12%, transparent)',
      border: '1px solid color-mix(in oklab, var(--color-warn) 35%, transparent)',
      color: 'var(--text-primary)',
      fontSize: 13,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ fontSize: 16 }}>⚠</span>
      <span>
        <strong>Advisory only</strong> — hurdle rate {pct}% pending ratification.
        Verdicts are non-binding.
      </span>
    </div>
  );
}
