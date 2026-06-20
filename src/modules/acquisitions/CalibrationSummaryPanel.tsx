// src/modules/acquisitions/CalibrationSummaryPanel.tsx
//
// Renders the calibration hit-rate summary for acquisition-score verdicts (Phase 4, Step 7).
import type { AcqIntelResponse } from '@contracts/acquisition';

type Props = { summary: AcqIntelResponse['calibrationSummary'] };

export function CalibrationSummaryPanel({ summary }: Props) {
  const pct = (n: number | null) =>
    n !== null ? `${Math.round(n * 100)}%` : '—';

  return (
    <section style={{ marginBottom: '1rem' }}>
      <h3 style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Calibration
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.5rem' }}>
        {[
          { label: 'Verdicts', value: String(summary.totalVerdicts) },
          { label: 'Resolved', value: String(summary.resolvedVerdicts) },
          { label: 'Hit rate', value: pct(summary.overallHitRate) },
          { label: 'Wilson CI', value: summary.wilsonLow !== null && summary.wilsonHigh !== null ? `${pct(summary.wilsonLow)}–${pct(summary.wilsonHigh)}` : '—' },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--bg-secondary)', borderRadius: '0.25rem', padding: '0.5rem 0.75rem' }}>
            <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)' }}>{label}</div>
            <div style={{ fontSize: '1rem', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
