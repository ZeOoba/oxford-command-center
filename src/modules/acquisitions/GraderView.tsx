// src/modules/acquisitions/GraderView.tsx
//
// OM Grader — grade a single acquisition candidate (OM upload OR direct manual entry, both feed
// the same controlled form) against the RATIFIED Buy Box & Scorecard v1.0. Layout mirrors the
// design-handoff Grader.html reference for LAYOUT/FLOW ONLY (drop zone + manual-entry affordance
// on the left, a read-only buy-box reference on the right): its simulated letter-grade scoring
// (A/B/C/D bands) is NOT ported — the ratified ruleset (config/acquisition-ruleset.v1.json) is the
// only source of truth, and it defines a tier (T1/T2/PASS/KILLED) + a 0-100 composite, never a
// letter grade. This view renders tier + composite ONLY.
//
// Intake: reuses OmImportDrawer's existing upload → POST /api/actions/om-extract → fields flow
// verbatim (it already fits standalone — dealId is optional). Extracted fields populate the same
// FIELD_GROUPS-driven form used by AcquisitionWorkbench (acquisition-score.ts), which stays visible
// so the analyst can review/edit before grading — that also serves as the "manual entry" path when
// no OM is uploaded at all.
import { useState, type ReactNode } from 'react';
import ruleset from '../../../config/acquisition-ruleset.v1.json';
import type { AcquisitionScore } from '@contracts/acquisition';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { GaugeRing, type GaugeRingProps } from '@/primitives/GaugeRing';
import { FIELD_GROUPS, type FieldSpec, type FormState, buildInput, denominatorNotes } from './acquisition-score';
import { OmImportDrawer } from './OmImportDrawer';
import { useGradeAcquisition, isEngineUnavailable } from './grader-hooks';

const GRADER_DEAL_ID = 'om-grader';

const TRIBOOL_OPTIONS = [
  { value: '', label: '—' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const inputCls = 'w-full rounded-[var(--radius-sm)] px-2 py-1 text-xs num';
const inputStyle = { background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' } as const;

const TIER_BADGE_TONE: Record<AcquisitionScore['tier'], BadgeTone> = {
  T1: 'gold',
  T2: 'blue',
  PASS: 'neutral',
  KILLED: 'red',
};

function gaugeTone(tier: AcquisitionScore['tier']): NonNullable<GaugeRingProps['tone']> {
  if (tier === 'T1') return 'pos';
  if (tier === 'T2') return 'warn';
  return 'neg'; // PASS | KILLED
}

export function GraderView() {
  const [form, setForm] = useState<FormState>({});
  const [uploadOpen, setUploadOpen] = useState(true);
  const grade = useGradeAcquisition();

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Grade an Acquisition"
            trailing={
              <button
                type="button"
                onClick={() => setUploadOpen((v) => !v)}
                className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
                style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--text-accent)' }}
              >
                {uploadOpen ? 'Hide OM Upload' : 'Upload OM'}
              </button>
            }
          />
          {uploadOpen && (
            <div className="px-3 pt-3">
              <OmImportDrawer
                open={uploadOpen}
                onClose={() => setUploadOpen(false)}
                onApply={(fields) => {
                  setForm((f) => ({ ...f, ...fields }));
                  setUploadOpen(false);
                }}
              />
            </div>
          )}
          <div className="flex flex-col gap-4 p-3">
            <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              Manual entry — edit any field below, whether pre-filled from an OM or entered by hand.
            </div>
            {FIELD_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{group.title}</div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {group.fields.map((spec) => (
                    <GraderFieldControl key={spec.key} spec={spec} value={form[spec.key] ?? ''} onChange={(v) => set(spec.key, v)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 px-3 pb-3">
            <button
              type="button"
              onClick={() => grade.mutate(buildInput(form, GRADER_DEAL_ID))}
              disabled={grade.isPending}
              className="rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold"
              style={{ background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--text-on-accent)', opacity: grade.isPending ? 0.6 : 1 }}
            >
              {grade.isPending ? 'Grading…' : 'Grade'}
            </button>
            {grade.isError && (
              <span className="text-2xs" style={{ color: 'var(--text-neg)' }}>
                {isEngineUnavailable(grade.error)
                  ? 'Acquisition engine unavailable — start the Brain server to grade.'
                  : grade.error instanceof Error
                    ? grade.error.message
                    : 'Grading failed.'}
              </span>
            )}
          </div>
        </Card>

        {grade.data && <ScorecardPanel score={grade.data} />}
      </div>

      <div data-testid="buy-box-panel">
        <BuyBoxPanel />
      </div>
    </div>
  );
}

function GraderFieldControl({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const label = (
    <span className="mb-0.5 block text-2xs" style={{ color: 'var(--text-secondary)' }}>
      {spec.label}
      {spec.hint ? <span style={{ color: 'var(--text-tertiary)' }}> · {spec.hint}</span> : null}
    </span>
  );
  if (spec.kind === 'ddbool') {
    return (
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} />
        {spec.label}
      </label>
    );
  }
  if (spec.kind === 'select' || spec.kind === 'numselect' || spec.kind === 'tribool') {
    const opts = spec.kind === 'tribool' ? TRIBOOL_OPTIONS : [{ value: '', label: '—' }, ...(spec.options ?? [])];
    return (
      <label className="block">
        {label}
        <select className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  const type = spec.kind === 'date' ? 'date' : 'number';
  return (
    <label className="block">
      {label}
      <input className={inputCls} style={inputStyle} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ScorecardPanel({ score }: { score: AcquisitionScore }) {
  return (
    <Card>
      <CardHeader title="Oxford Acquisition Score" trailing={<Badge tone={TIER_BADGE_TONE[score.tier]}>{score.tier}</Badge>} />
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-4">
          <GaugeRing value={score.composite} tone={gaugeTone(score.tier)} label={`${score.tier} · ${score.verdict}`} />
          <div className="flex flex-col gap-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{score.verdict}</div>
            <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{score.composite}/100 · confidence: {score.confidence}</div>
          </div>
        </div>

        {(score.advisoryOnly || score.cappedAtT2 || score.incompleteRuleset) && (
          <div className="flex flex-wrap gap-1.5">
            {score.advisoryOnly && <Badge tone="amber">Advisory only</Badge>}
            {score.cappedAtT2 && <Badge tone="amber">Capped at T2</Badge>}
            {score.incompleteRuleset && <Badge tone="amber">Incomplete ruleset</Badge>}
          </div>
        )}

        {denominatorNotes(score).length > 0 && (
          <ul className="flex flex-col gap-0.5 text-2xs" style={{ color: 'var(--text-warn)' }}>
            {denominatorNotes(score).map((n) => <li key={n}>! {n}</li>)}
          </ul>
        )}

        <ChecklistSection title="Gates" rows={score.gates.map((g) => ({ key: g.id, ok: g.passed, detail: g.detail }))} />
        <ChecklistSection
          title="Floors"
          rows={score.floors.map((f) => ({ key: f.id, ok: f.actual === null ? null : f.passed, detail: f.detail }))}
        />

        <div className="flex flex-col gap-1">
          {score.subScores.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className="w-14 text-2xs uppercase" style={{ color: 'var(--text-secondary)' }}>{s.id}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-overlay)' }}>
                <div className="h-full rounded-full" style={{ width: `${s.normalized}%`, background: 'var(--accent)' }} />
              </div>
              <span className="num w-16 text-right text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                {Math.round(s.points * 10) / 10}/{s.maxPoints}
              </span>
            </div>
          ))}
        </div>

        {score.reasons.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-2xs" style={{ color: 'var(--text-secondary)' }}>
            {score.reasons.map((r, i) => <li key={i}>· {r}</li>)}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ChecklistSection({ title, rows }: { title: string; rows: { key: string; ok: boolean | null; detail: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-2xs" title={r.detail}>
          <Badge tone={r.ok === null ? 'neutral' : r.ok ? 'green' : 'red'}>
            {r.ok === null ? 'Indeterminate' : r.ok ? 'Pass' : 'Fail'}
          </Badge>
          <span style={{ color: 'var(--text-secondary)' }}>{r.key}</span>
        </div>
      ))}
    </div>
  );
}

function BuyBoxPanel() {
  const versionLabel = `v${ruleset.rulesetVersion.split('.').slice(0, 2).join('.')}`;
  return (
    <Card>
      <CardHeader
        title={`Buy Box — Ruleset ${versionLabel}`}
        trailing={<Badge tone="gold">{versionLabel} · ratified {ruleset.ratifiedDate}</Badge>}
      />
      <div className="flex flex-col gap-4 p-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Read-only — a ruleset change requires a new version + a fresh ratification, never an edit here.
        </div>

        <RuleSection title="Gates">
          <KV label="Single-asset price" value={`$${ruleset.gates.sizePrice.singleAssetPriceMin.toLocaleString()}–$${ruleset.gates.sizePrice.singleAssetPriceMax.toLocaleString()}`} />
          <KV label="Portfolio price max" value={`$${ruleset.gates.sizePrice.portfolioPriceMax.toLocaleString()}`} />
          <KV label="Max SF / building" value={`< ${ruleset.gates.sizePrice.maxSfPerBuilding.toLocaleString()}`} />
          <KV label="Min clear height" value={`${ruleset.gates.physical.minClearHeightFt} ft`} />
          <KV label="SFHA on pad" value={ruleset.gates.flood.sfhaOnPadKills ? 'Kills' : 'Allowed'} />
          <KV label="Min ground lease remaining" value={`${ruleset.gates.other.minGroundLeaseYearsRemaining} yrs`} />
          <KV label="Max env remediation" value={`${(ruleset.gates.other.maxEnvRemediationPctOfPrice * 100).toFixed(0)}% of price`} />
          <KV label="Established clusters" value={ruleset.gates.establishedClusters.join(', ')} />
          <KV label="Entry clusters" value={ruleset.gates.entryClusters.join(', ')} />
          <KV label="Satellite max drive" value={`${ruleset.gates.satelliteMaxDriveMinutes} min`} />
        </RuleSection>

        <RuleSection title="Floors">
          <KV label="Basis discount (post-2000)" value={`≥ ${(ruleset.floors.basisDiscountMinPostMillennium * 100).toFixed(0)}%`} />
          <KV label="Basis discount (pre-2000)" value={`≥ ${(ruleset.floors.basisDiscountMinPreMillennium * 100).toFixed(0)}%`} />
          <KV label="Stabilized YoC floor" value={`≥ ${(ruleset.floors.stabilizedYocFloorPct * 100).toFixed(0)}%`} />
          <KV label="Levered IRR floor (5yr)" value={`≥ ${(ruleset.floors.leveredIrrFloor5yr * 100).toFixed(0)}%`} />
          <KV label="Levered IRR floor (10yr)" value={`≥ ${(ruleset.floors.leveredIrrFloor10yr * 100).toFixed(0)}%`} />
        </RuleSection>

        <RuleSection title="Scorecard (100 pts)">
          {ruleset.scorecard.map((cat) => (
            <div key={cat.id} className="flex items-center justify-between">
              <span>{cat.label}</span>
              <span className="num">
                {cat.points} pts{cat.vacantPoints !== null ? ` (${cat.vacantPoints} if vacant)` : ''}
              </span>
            </div>
          ))}
        </RuleSection>

        <RuleSection title="Bands">
          <KV label="T1 Pursue" value={`≥ ${ruleset.bands.t1PursueMin}`} />
          <KV label="T2 Watch" value={`≥ ${ruleset.bands.t2WatchMin}`} />
        </RuleSection>
      </div>
    </Card>
  );
}

function RuleSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{title}</div>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
