// src/modules/property-condition/CalibrationView.tsx
//
// "How far off are PCA unit costs from what contractors charge?" — driven by the append-only observation ledger
// (data/calibration/observations.json). Everything shown (ratio, variance, per-component n / median / range / tier)
// is derived at render time from $/unit; adding a row to the ledger changes the display with no code change.
//
// Stale (pre-2024) PCA estimates stay visible as history but never count toward the statistics.
//
// Price Basis firewall: the PCA estimate and the contractor price are separate columns end to end. Nothing here
// blends them, and nothing applies a ratio to a reserve or to underwriting — informational only.
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import {
  aggregateByComponent,
  exclusionFor,
  supersededMap,
  latestObservation,
  ratio,
  underwritingUse,
  variancePct,
  type CalibrationObservation,
  type CalibrationProposal,
  type ComponentAggregate,
  type ConfidenceTier,
} from '@/analytics/calibration-ledger';
import { fmtDeltaPct, fmtPartialDate, fmtPsf } from './hooks';
import { calibrationLabel } from './pca-overlay';

const muted = { color: 'var(--text-tertiary)' } as const;

const TIER_TONE: Record<ConfidenceTier, BadgeTone> = { NONE: 'neutral', THIN: 'red', LIMITED: 'amber', USABLE: 'green' };

export function TierBadge({ tier }: { tier: ConfidenceTier }) {
  return <Badge tone={TIER_TONE[tier]}>{tier}</Badge>;
}

const COMPONENT_LABEL: Record<string, string> = {
  roof_tpo: 'Roof — TPO', roof_epdm: 'Roof — EPDM', roof_metal: 'Roof — metal', roof_other: 'Roof — other',
  paving_overlay: 'Paving — mill & overlay', paving_full_depth: 'Paving — full depth', seal_stripe: 'Seal & stripe',
  exterior_paint: 'Exterior paint', sealants: 'Sealants', hvac: 'HVAC', other: 'Other',
};
const label = (c: string) => COMPONENT_LABEL[c] ?? c;
const fmtRatio = (r: number | null) => (r === null ? 'n/a' : `${r.toFixed(2)}×`);

/** Dot strip on a fixed 0–4× axis with a 1.0× (contractor = PCA) reference line. Points beyond 4× pin to the edge. */
function DotStrip({ agg }: { agg: ComponentAggregate }) {
  const AXIS_MAX = 4;
  const pos = (r: number) => `${(Math.min(r, AXIS_MAX) / AXIS_MAX) * 100}%`;
  return (
    <div
      role="img"
      aria-label={`${label(agg.component)} ratios: ${agg.points.map((p) => p.ratio.toFixed(2)).join(', ')}`}
      style={{ position: 'relative', height: 22, margin: '6px 0 2px', background: 'var(--border-subtle)', borderRadius: 3 }}
    >
      <div style={{ position: 'absolute', left: pos(1), top: 0, bottom: 0, width: 1, background: 'var(--text-tertiary)' }} title="1.0× — contractor equals PCA" />
      {agg.points.map((p) => (
        <div
          key={p.obsId}
          title={`${p.property}: ${p.ratio.toFixed(2)}× (${fmtDeltaPct(p.variancePct)}) · ${p.contractorStatus}`}
          style={{
            position: 'absolute', left: pos(p.ratio), top: 5, width: 12, height: 12, marginLeft: -6, borderRadius: 6,
            background: p.ratio > 1 ? 'var(--color-warn)' : 'var(--color-info)',
            opacity: p.contractorStatus === 'BID' ? 0.55 : 1,
            border: '1px solid var(--surface-raised)',
          }}
        />
      ))}
    </div>
  );
}

function ComponentPanel({ agg }: { agg: ComponentAggregate }) {
  return (
    <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label(agg.component)}</span>
        <TierBadge tier={agg.tier} />
        <span className="num text-2xs" style={muted}>n={agg.n}{agg.excluded > 0 ? ` (+${agg.excluded} excluded)` : ''}</span>
        {agg.directionalOnly && <span className="text-2xs" style={{ color: 'var(--text-warn)' }}>directional only</span>}
        {agg.costSegQtyN > 0 && <span className="text-2xs" style={{ color: 'var(--text-warn)' }}>{agg.costSegQtyN} on a cost-seg-modeled quantity</span>}
      </div>
      {agg.n > 0 ? (
        <>
          <div className="num flex flex-wrap gap-x-5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span>median {fmtRatio(agg.medianRatio)} ({agg.medianRatio === null ? 'n/a' : fmtDeltaPct(agg.medianRatio - 1)})</span>
            <span>range {fmtRatio(agg.minRatio)} – {fmtRatio(agg.maxRatio)}</span>
            {agg.meanRatio !== null && <span>mean {fmtRatio(agg.meanRatio)}</span>}
          </div>
          <DotStrip agg={agg} />
          <div className="num text-2xs" style={muted}>0× · dot = one observation (lighter = unsigned bid) · line = 1.0× · axis capped at 4×</div>
        </>
      ) : (
        <div className="text-2xs" style={muted}>No observation currently counts toward the statistics.</div>
      )}
    </div>
  );
}

function LedgerRow({ o, tier, superseded }: { o: CalibrationObservation; tier: ConfidenceTier | undefined; superseded: ReadonlyMap<string, string> }) {
  const why = exclusionFor(o, superseded);
  return (
    <tr style={{ borderTop: '1px solid var(--border-subtle)', opacity: why ? 0.6 : 1, verticalAlign: 'top' }}>
      <td className="px-3 py-2 text-xs">
        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{o.property}</div>
        <div className="text-2xs" style={muted}>{label(o.component)} · {o.qty === null ? 'qty n/a' : `${o.qty.toLocaleString('en-US')} ${o.unit}`}{o.qty_source === 'COST_SEG_MODELED' ? ' · qty: cost seg modeled' : ''}</div>
      </td>
      <td className="num px-3 py-2 text-right text-xs">
        {o.pca_unit_cost === null ? 'n/a' : `${fmtPsf(o.pca_unit_cost)}/${o.unit}`}
        <div className="text-2xs" style={muted} title={`${o.pca_source.source_file} · ${o.pca_source.price_basis}`}>
          {o.pca_source.consultant} · {fmtPartialDate(o.pca_source.report_date)} · {o.pca_source.status}
        </div>
      </td>
      <td className="num px-3 py-2 text-right text-xs">
        {o.contractor_unit_cost === null ? 'n/a' : `${fmtPsf(o.contractor_unit_cost)}/${o.unit}`}
        <div className="text-2xs" style={muted} title={`${o.contractor_source.source_file} · ${o.contractor_source.price_basis}`}>
          {o.contractor_source.vendor} · {fmtPartialDate(o.contractor_source.doc_date)} · {o.contractor_source.status}
        </div>
      </td>
      <td className="num px-3 py-2 text-right text-xs">
        <span>{fmtRatio(ratio(o))} </span>
        <span style={muted}>({fmtDeltaPct(variancePct(o))})</span>
        <div className="mt-0.5 flex items-center justify-end gap-1">
          {why !== null && <span className="text-2xs" style={muted}>excluded — history only</span>}
          {why === null && tier !== undefined && <TierBadge tier={tier} />}
          {why === null && tier !== undefined && (tier === 'THIN' || tier === 'LIMITED') && <span className="text-2xs" style={{ color: 'var(--text-warn)' }}>directional only</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-2xs" style={muted}>
        {why !== null && <div style={{ color: 'var(--text-warn)' }}>Excluded: {why}</div>}
        {o.scope_note}
      </td>
    </tr>
  );
}

export function CalibrationView({ ledger, pending }: { ledger: CalibrationObservation[]; pending: CalibrationProposal[] }) {
  const aggs = aggregateByComponent(ledger);
  const superseded = supersededMap(ledger);
  const tierByComponent = new Map(aggs.map((a) => [a.component, a.tier]));
  const latest = latestObservation(ledger);
  const use = underwritingUse(aggs);
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="PCA estimate vs contractor price — calibration ledger" trailing={<Badge tone="amber">{ledger.length} observations · {aggs.reduce((a, g) => a + g.n, 0)} count toward stats</Badge>} />
        <div className="num px-4 pb-1 text-2xs" style={{ color: 'var(--text-warn)' }}>{calibrationLabel(aggs.map((a) => a.n))}</div>
        <div className="px-4 pb-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {latest !== null && (
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>What changed:</strong> latest observation {latest.property} — {label(latest.component)} ({latest.contractor_source.vendor}, {latest.contractor_source.status}) added {latest.added_at}.
            </div>
          )}
          <div>
            <strong style={{ color: 'var(--text-primary)' }}>Underwriting use:</strong> {use.note} This view is informational — no reserve or underwriting figure is adjusted by any ratio here.
          </div>
        </div>
        {aggs.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No observations loaded.</div>
        ) : (
          aggs.map((a) => <ComponentPanel key={a.component} agg={a} />)
        )}
      </Card>

      <Card>
        <CardHeader title="Observation ledger" trailing={<Badge tone="neutral">append-only</Badge>} />
        <div className="overflow-x-auto">
          <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="text-2xs" style={{ ...muted, textAlign: 'left' }}>
                <th className="px-3 py-2">Property / scope</th>
                <th className="px-3 py-2 text-right">PCA estimate (consultant)</th>
                <th className="px-3 py-2 text-right">Contractor price</th>
                <th className="px-3 py-2 text-right">Ratio · tier</th>
                <th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((o) => (
                <LedgerRow key={o.obs_id} o={o} tier={tierByComponent.get(o.component)} superseded={superseded} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="num px-1 text-2xs" style={muted}>
        Ratio = contractor ÷ PCA unit cost, both normalized to $/unit so different job sizes compare; variance = ratio − 1.
        Both are derived on every render and never stored. PCA estimates and contractor prices stay in separate columns —
        never blended into one benchmark and never used to overwrite one another. Tier is computed from n (THIN 1 · LIMITED
        2–4 · USABLE 5+); the mean appears only at n ≥ 5, and there is deliberately no portfolio-wide calibration factor.
        {pending.length > 0
          ? ` ${pending.length} proposal${pending.length === 1 ? '' : 's'} await review in data/calibration/calibration_pending.json — promote with: npm run calibration:promote -- <obs_id> [--supersedes <obs_id>]... (a placeholder row it replaces must be superseded; see the script for the two override flags).`
          : ' No proposals are awaiting review (refresh with npm run calibration:propose).'}
      </p>
    </div>
  );
}
