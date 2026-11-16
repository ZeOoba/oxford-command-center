// src/modules/capital/AllocationCard.tsx
//
// Phase 5 W2 — per-asset allocation verdict card with action chip, risk band,
// return vs hurdle, confidence bar, and reasons accordion.
import { useState } from 'react';
import { Card } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import type { AllocationVerdict } from './hooks';
import { actionLabel, actionColor, actionFillColor, riskBandTone } from './hooks';

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function ConfidenceBar({ value }: { value: number }) {
  return (
    <div style={{ height: 4, background: 'var(--border-subtle)', borderRadius: 2, width: '100%' }}>
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

/**
 * Round 8 fresh-sweep (adversarial refute, HIGH — reproduced with byte-identical rendered DOM):
 * this card never read verdict.inputs.bookTrust or verdict.dataQuality at all, even though both
 * were already required/populated by the server (round 19's whole point). A withheld-because-
 * distrusted verdict rendered pixel-identical to a genuine clean hold, and — because riskBand in
 * the server's default hold branch used to be derived from operating health alone — a real 0.71x
 * DSCR governor-block breach rendered with a GREEN "low" risk badge. capital-allocation.ts's
 * combinedRiskBand() (this same round) fixes the badge's own color for a measured breach; the
 * trust badge + inline flag below are the independent fix for the *unmeasured* case (degraded/
 * unknown book), which no risk-band derivation can recover since the governor figures don't exist.
 * Mirrors the pattern already shipped for ScorecardView.tsx / LadderView.tsx in round 19d.
 */
export function AllocationCard({ verdict, hurdleRatePct }: Props) {
  const [open, setOpen] = useState(false);

  const returnStr = fmtPct(verdict.expectedReturnPct);
  const hurdleStr = fmtPct(hurdleRatePct);
  const aboveHurdle = verdict.returnAboveHurdle;

  const bookTrust = verdict.inputs.bookTrust;
  // 'buy' verdicts hardcode bookTrust:'unknown' as a "not applicable" placeholder (pipeline
  // candidates aren't owned, so no debt book describes them — see buildBuyVerdict's docblock),
  // not a real trust failure. Same distinction filterTrustedVerdicts (capital-allocation-api.ts)
  // makes on the server side.
  const distrusted = verdict.action !== 'buy' && bookTrust !== 'trusted';
  const debtBookFlag = verdict.dataQuality.find((f) => f.field === 'debtBook');
  // Ruling 2026-11-13: the projection behind returnAboveHurdle rests on unratified assumptions.
  const projectionFlag = verdict.dataQuality.find((f) => f.field === 'returnAboveHurdle');

  return (
    <Card>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontWeight: 700, fontSize: 13, letterSpacing: '0.03em',
            padding: '2px 8px', borderRadius: 4,
            background: `color-mix(in oklab, ${actionFillColor(verdict.action)} 15%, transparent)`,
            color: actionColor(verdict.action),
            border: `1px solid color-mix(in oklab, ${actionFillColor(verdict.action)} 40%, transparent)`,
          }}>
            {actionLabel(verdict.action)}
          </span>
          <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>
            {verdict.propertyName ?? verdict.propertyId}
          </span>
          {distrusted && (
            <Badge tone={bookTrust === 'unknown' ? 'amber' : 'red'}>
              {bookTrust === 'unknown' ? 'book not loaded' : 'book not trusted'}
            </Badge>
          )}
          <Badge tone={riskBandTone(verdict.riskBand)}>
            {verdict.riskBand}
          </Badge>
        </div>

        {/* Debt-book distrust flag — independent of the reasons accordion below, since
            scores.ts unconditionally seeds a health line as reasons[0], so this fact would
            otherwise never be the visible line even when it is the most important one. */}
        {distrusted && debtBookFlag && (
          <div
            style={{
              fontSize: 11,
              color: debtBookFlag.severity === 'error' ? 'var(--text-neg)' : 'var(--text-warn)',
            }}
          >
            {debtBookFlag.issue}
          </div>
        )}

        {/* Return vs hurdle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>
            Return <strong style={{ color: 'var(--text-primary)' }}>{returnStr}</strong>
            {verdict.expectedReturnPct === null && verdict.action !== 'buy' && (
              <span style={{ marginLeft: 4, color: 'var(--text-tertiary)' }}>no return data</span>
            )}
            {aboveHurdle !== null && (
              <span style={{ marginLeft: 4, color: aboveHurdle ? 'var(--text-pos)' : 'var(--text-neg)' }}>
                {aboveHurdle ? '↑' : '↓'} vs {hurdleStr} hurdle
                {projectionFlag && (
                  <span title={projectionFlag.issue} style={{ color: 'var(--text-warn)', fontStyle: 'italic' }}> (projected, advisory)</span>
                )}
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
          <span
            style={{ whiteSpace: 'nowrap' }}
            title={verdict.confidenceTier === 'estimated' ? 'Forecast inputs absent: confidence is capped at 65%' : undefined}
          >
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
