// src/modules/calibration/ResolveDialog.tsx
//
// The MANUAL-resolution confirm-before-write surface (spec §3.2). An analyst records the realized
// outcome of a pending verdict: a hit/miss judgment, the realized band/value, the action_taken
// treatment annotation (§5 — the clean-test 'none' vs an intervention), and a free-text treatment
// note. NOTHING is written until the analyst explicitly confirms — the POST fires only on the
// "Record outcome" press, and the body is Zod-validated (client + server) before it leaves.
//
// This writes calibration_outcome ONLY (append-only; the verdict is never mutated) — never overlay,
// never a governor. The grain rule (same-grain, strictly-later outcome period) is enforced server-side
// and surfaced here as an inline error if violated.
import { useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { useToast } from '@/primitives/toast-context';
import { useResolveVerdict, type CalibrationLogRow, type CalibrationResolveRequest } from './hooks';
import { verdictLabel } from './format';
import type { ActionTaken } from '@contracts/warehouse';

const ACTION_OPTIONS: Array<{ value: ActionTaken; label: string }> = [
  { value: 'none', label: 'None — left alone (clean test)' },
  { value: 'acted-aligned', label: 'Acted, aligned with verdict' },
  { value: 'acted-counter', label: 'Acted, counter to verdict' },
  { value: 'unknown', label: 'Unknown' },
];

const inputStyle = {
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-strong)',
} as const;

export function ResolveDialog({ row, onClose }: { row: CalibrationLogRow; onClose: () => void }) {
  const { toast } = useToast();
  const resolve = useResolveVerdict();

  const [outcomePeriod, setOutcomePeriod] = useState('');
  const [hit, setHit] = useState<'1' | '0' | ''>('');
  const [realizedBand, setRealizedBand] = useState('');
  const [realizedValue, setRealizedValue] = useState('');
  const [actionTaken, setActionTaken] = useState<ActionTaken>('none');
  const [treatmentNote, setTreatmentNote] = useState('');
  const [actionDetail, setActionDetail] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    setErr(null);
    const parsedValue = realizedValue.trim() === '' ? null : Number(realizedValue);
    if (parsedValue !== null && Number.isNaN(parsedValue)) {
      setErr('Realized value must be a number (or blank).');
      return;
    }
    const body: CalibrationResolveRequest = {
      calibrationId: row.id,
      realizedBand: realizedBand.trim() === '' ? null : realizedBand.trim(),
      realizedValue: parsedValue,
      realizedUnit: (row.predictedUnit as CalibrationResolveRequest['realizedUnit']) ?? null,
      outcomePeriod: outcomePeriod.trim(),
      hit: hit === '' ? null : hit === '1' ? 1 : 0,
      actionTaken,
      actionDetail: actionDetail.trim() === '' ? null : actionDetail.trim(),
      treatmentNote: treatmentNote.trim() === '' ? null : treatmentNote.trim(),
      resolutionBasis: 'analyst-judgment',
      resolvedBy: 'manual:gabriel',
    };
    resolve.mutate(
      { id: row.id, body },
      {
        onSuccess: (r) => {
          toast({
            tone: 'success',
            title: r.duplicate ? 'Outcome already recorded' : r.superseded ? 'Resolution updated' : 'Outcome recorded',
            description: verdictLabel(row),
          });
          onClose();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title="Record realized outcome"
        trailing={<Badge tone="purple">manual resolution</Badge>}
      />
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{verdictLabel(row)}</div>
        <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Records a realized outcome (append-only — the verdict is never altered). The outcome period
          must be the same grain as, and later than, the verdict period ({row.asOfPeriod}).
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Outcome period (YYYY)</span>
            <input value={outcomePeriod} onChange={(e) => setOutcomePeriod(e.target.value)} placeholder="2026"
              className="num rounded-md px-2.5 py-1 text-xs" style={inputStyle} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Was the verdict right?</span>
            <select value={hit} onChange={(e) => setHit(e.target.value as '1' | '0' | '')}
              className="rounded-md px-2.5 py-1 text-xs" style={inputStyle}>
              <option value="">— not scoreable —</option>
              <option value="1">Hit (verdict was right)</option>
              <option value="0">Miss (verdict was wrong)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Realized band (optional)</span>
            <input value={realizedBand} onChange={(e) => setRealizedBand(e.target.value)} placeholder="noi-flat-or-declined"
              className="rounded-md px-2.5 py-1 text-xs" style={inputStyle} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Realized value (optional)</span>
            <input value={realizedValue} onChange={(e) => setRealizedValue(e.target.value)} placeholder="-0.04"
              className="num rounded-md px-2.5 py-1 text-xs" style={inputStyle} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Did the firm act? (treatment — §5)</span>
            <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value as ActionTaken)}
              className="rounded-md px-2.5 py-1 text-xs" style={inputStyle}>
              {ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {actionTaken !== 'none' && actionTaken !== 'unknown' && (
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Action detail (capex / refi / disposition)</span>
              <input value={actionDetail} onChange={(e) => setActionDetail(e.target.value)} placeholder="re-leased anchor tenant Q3"
                className="rounded-md px-2.5 py-1 text-xs" style={inputStyle} />
            </label>
          )}
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Treatment note (why this is / isn't a clean test)</span>
            <textarea value={treatmentNote} onChange={(e) => setTreatmentNote(e.target.value)} rows={2}
              placeholder="NOI held flat only because we re-leased the anchor — verdict was directionally right but we intervened."
              className="rounded-md px-2.5 py-1 text-xs" style={inputStyle} />
          </label>
        </div>

        {err && (
          <div className="rounded-md px-3 py-2 text-2xs" role="alert"
            style={{ background: 'color-mix(in oklab, var(--color-neg) 12%, transparent)', color: 'var(--text-neg)', border: '1px solid color-mix(in oklab, var(--color-neg) 35%, transparent)' }}>
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="subtle" onPress={onClose} isDisabled={resolve.isPending}>Cancel</Button>
          <Button size="sm" variant="primary" onPress={submit} isDisabled={resolve.isPending}>
            {resolve.isPending ? 'Recording…' : 'Record outcome'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
