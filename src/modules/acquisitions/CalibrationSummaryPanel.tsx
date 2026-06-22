// src/modules/acquisitions/CalibrationSummaryPanel.tsx
//
// Renders the calibration hit-rate summary for acquisition-score verdicts (Phase 4, Step 7).
import type { AcqIntelResponse } from '@contracts/acquisition';
import { Card, CardHeader } from '@/primitives/Card';

type Props = { summary: AcqIntelResponse['calibrationSummary'] };

export function CalibrationSummaryPanel({ summary }: Props) {
  const pct = (n: number | null) =>
    n !== null ? `${Math.round(n * 100)}%` : '—';

  return (
    <Card as="section" className="mb-4">
      <CardHeader title="Calibration" />
      <div className="p-3">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.5rem' }}>
          {[
            { label: 'Verdicts', value: String(summary.totalVerdicts) },
            { label: 'Resolved', value: String(summary.resolvedVerdicts) },
            { label: 'Hit rate', value: pct(summary.overallHitRate) },
            { label: 'Wilson CI', value: summary.wilsonLow !== null && summary.wilsonHigh !== null ? `${pct(summary.wilsonLow)}–${pct(summary.wilsonHigh)}` : '—' },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--surface-overlay)', borderRadius: '0.25rem', padding: '0.5rem 0.75rem' }}>
              <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)' }}>{label}</div>
              <div style={{ fontSize: '1rem', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
