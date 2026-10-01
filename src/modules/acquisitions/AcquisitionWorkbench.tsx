// src/modules/acquisitions/AcquisitionWorkbench.tsx
//
// The Acquisition Workbench: enter a deal's underwriting inputs and get the platform's deterministic
// Oxford Acquisition Score live (debounced POST to the ratified engine). Renders verdict → composite →
// sub-scores → gates → floors → DD-critical → reasons, with advisory/incomplete banners so an
// un-RCT-backed or unratified result is never mistaken for a live verdict. `scoreFn` is injectable for
// tests (no network). Inputs are client-state only in v1 (server-side persistence is a later increment).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AcquisitionInput, AcquisitionScore } from '@contracts/acquisition';
import type { Deal } from '@contracts/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import {
  FIELD_GROUPS, type FieldSpec, type FormState,
  applyDealMarket, buildInput, denominatorNotes, dealToForm, inputToForm, isEngineUnavailable, saveDealInput, scoreDealRequest,
} from './acquisition-score';
import { OmImportDrawer } from './OmImportDrawer';

const VERDICT_TONE: Record<string, BadgeTone> = { PURSUE: 'green', WATCH: 'amber', PASS: 'neutral', KILLED: 'red' };
const TRIBOOL = [{ value: '', label: '—' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

const inputCls = 'w-full rounded-[var(--radius-sm)] px-2 py-1 text-xs num';
const inputStyle = { background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' } as const;

export function AcquisitionWorkbench({
  deal = null,
  savedInput = null,
  scoreFn = scoreDealRequest,
  saveFn = saveDealInput,
}: {
  deal?: Deal | null;
  savedInput?: AcquisitionInput | null;
  scoreFn?: (input: Record<string, unknown>) => Promise<AcquisitionScore>;
  saveFn?: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const dealId = deal?.id ?? 'workbench';
  const [form, setForm] = useState<FormState>(() => (savedInput ? applyDealMarket(inputToForm(savedInput), deal) : deal ? dealToForm(deal) : {}));
  const [score, setScore] = useState<AcquisitionScore | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const reqId = useRef(0);
  const retryInFlight = useRef(false);
  const loadedFor = useRef<string | null>(deal?.id ?? null);
  const [errIsEngineDown, setErrIsEngineDown] = useState(false);

  // Re-initialize the form only when the SELECTED DEAL changes (not on every snapshot refetch), so a
  // background refresh never clobbers in-progress edits. A saved deal reloads its persisted inputs.
  useEffect(() => {
    const id = deal?.id ?? null;
    if (loadedFor.current === id) return;
    loadedFor.current = id;
    setForm(savedInput ? applyDealMarket(inputToForm(savedInput), deal) : deal ? dealToForm(deal) : {});
  }, [deal, savedInput]);

  const runScore = useCallback(async (f: FormState) => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const s = await scoreFn(buildInput(f, dealId));
      if (reqId.current === id) { setScore(s); setErr(null); setErrIsEngineDown(false); }
    } catch (e) {
      if (reqId.current === id) {
        const unavailable = isEngineUnavailable(e);
        setScore(null);
        setErr(unavailable ? 'Acquisition engine unavailable — start the Brain server to score.' : e instanceof Error ? e.message : 'scoring failed');
        setErrIsEngineDown(unavailable);
      }
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [scoreFn, dealId]);

  useEffect(() => {
    const t = setTimeout(() => { void runScore(form); }, 300);
    return () => clearTimeout(t);
  }, [form, runScore]);

  // When the engine is down, retry automatically every 5 s so recovery is seamless after the Brain
  // server comes back up — no form touch or page reload needed.
  useEffect(() => {
    if (!errIsEngineDown) return;
    const id = setInterval(() => {
      if (retryInFlight.current) return;
      retryInFlight.current = true;
      void runScore(form).finally(() => { retryInFlight.current = false; });
    }, 5000);
    return () => clearInterval(id);
  }, [errIsEngineDown, form, runScore]);

  const onSave = useCallback(async () => {
    if (!deal) return; // only a real pipeline deal can persist (the route 404s on a blank/unknown deal)
    setSaveState('saving');
    setSaveState((await saveFn(buildInput(form, dealId))) ? 'ok' : 'err');
  }, [deal, saveFn, form, dealId]);

  const set = (key: string, value: string) => { setForm((f) => ({ ...f, [key]: value })); setSaveState('idle'); };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_minmax(320px,420px)]">
      <Card>
        <CardHeader
          title="Underwriting Inputs"
          trailing={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDrawerOpen((v) => !v)}
                className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
                style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--text-accent)' }}
              >
                {drawerOpen ? 'Close OM Import' : 'Upload OM'}
              </button>
              {deal && (
                <button
                  type="button"
                  onClick={() => void onSave()}
                  disabled={saveState === 'saving'}
                  className="rounded-[var(--radius-sm)] px-2 py-1 text-2xs font-semibold"
                  style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
                >
                  {saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Saved ✓' : saveState === 'err' ? 'Save failed' : 'Save'}
                </button>
              )}
              <Badge tone="neutral">{deal ? deal.name : 'blank deal'}</Badge>
            </div>
          }
        />
        {drawerOpen && (
          <div className="px-3 pt-3">
            <OmImportDrawer
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              dealId={deal?.id}
              onApply={(fields) => {
                setForm((f) => ({ ...f, ...fields }));
                setSaveState('idle');
                setDrawerOpen(false);
              }}
            />
          </div>
        )}
        <div className="flex flex-col gap-4 p-3">
          {FIELD_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{group.title}</div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {group.fields.map((spec) => (
                  <FieldControl key={spec.key} spec={spec} value={form[spec.key] ?? ''} onChange={(v) => set(spec.key, v)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Oxford Acquisition Score" trailing={loading ? <Badge tone="neutral">scoring…</Badge> : undefined} />
        <div className="flex flex-col gap-3 p-3">
          {err && (
            <Banner tone="red">
              {err}
              {errIsEngineDown && (
                <button
                  type="button"
                  onClick={() => {
                    if (retryInFlight.current) return;
                    retryInFlight.current = true;
                    void runScore(form).finally(() => { retryInFlight.current = false; });
                  }}
                  style={{ marginLeft: '0.5rem', opacity: 0.75, textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0 }}
                >
                  Retry now
                </button>
              )}
            </Banner>
          )}
          {!err && !score && <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Enter inputs to score.</div>}
          {score && <ScorePanel score={score} />}
        </div>
      </Card>
    </div>
  );
}

function FieldControl({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const label = (
    <span className="mb-0.5 block text-2xs" style={{ color: 'var(--text-secondary)' }}>
      {spec.label}{spec.hint ? <span style={{ color: 'var(--text-tertiary)' }}> · {spec.hint}</span> : null}
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
    const opts = spec.kind === 'tribool' ? TRIBOOL : [{ value: '', label: '—' }, ...(spec.options ?? [])];
    return (
      <label className="block">{label}
        <select className={inputCls} style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  const type = spec.kind === 'date' ? 'date' : 'number';
  return (
    <label className="block">{label}
      <input className={inputCls} style={inputStyle} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ScorePanel({ score }: { score: AcquisitionScore }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <Badge tone={VERDICT_TONE[score.verdict] ?? 'neutral'}>{score.verdict}</Badge>
        <div className="num text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>{score.composite}<span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>/100</span></div>
        <span className="text-2xs uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{score.tier} · {score.confidence}</span>
      </div>

      {score.advisoryOnly && <Banner tone="amber">Advisory only — not a ratified capital-allocation verdict.</Banner>}
      {score.incompleteRuleset && <Banner tone="amber">Ruleset incomplete — verdict capped.</Banner>}
      {score.cappedAtT2 && !score.advisoryOnly && !score.incompleteRuleset && <Banner tone="amber">Capped to WATCH (see reasons).</Banner>}
      {denominatorNotes(score).map((n) => <Banner key={n} tone="amber">{n}</Banner>)}

      <div className="flex flex-col gap-1">
        {score.subScores.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <span className="w-14 text-2xs uppercase" style={{ color: 'var(--text-secondary)' }}>{s.id}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-overlay)' }}>
              <div className="h-full rounded-full" style={{ width: `${s.normalized}%`, background: 'var(--accent)' }} />
            </div>
            <span className="num w-16 text-right text-2xs" style={{ color: 'var(--text-tertiary)' }}>{Math.round(s.points * 10) / 10}/{s.maxPoints}</span>
          </div>
        ))}
      </div>

      <ChipRow label="Gates" items={score.gates.map((g) => ({ text: g.id, tone: (g.passed ? 'green' : 'red') as BadgeTone, title: g.detail }))} />
      <ChipRow label="Floors" items={score.floors.map((f) => ({ text: f.id, tone: (f.actual === null ? 'neutral' : f.passed ? 'green' : 'red') as BadgeTone, title: f.detail }))} />
      {score.ddCriticalUnresolved.length > 0 && (
        <ChipRow label="DD unresolved" items={score.ddCriticalUnresolved.map((d) => ({ text: d, tone: 'amber' as BadgeTone }))} />
      )}

      {score.reasons.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {score.reasons.map((r, i) => <li key={i}>· {r}</li>)}
        </ul>
      )}
    </>
  );
}

function ChipRow({ label, items }: { label: string; items: { text: string; tone: BadgeTone; title?: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 text-2xs uppercase" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      {items.map((it, i) => <span key={`${it.text}-${i}`} title={it.title}><Badge tone={it.tone}>{it.text}</Badge></span>)}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'red' | 'amber'; children: ReactNode }) {
  const c = tone === 'red' ? 'var(--color-neg)' : 'var(--color-warn)';
  const textC = tone === 'red' ? 'var(--text-neg)' : 'var(--text-warn)';
  const bg = tone === 'red' ? 'var(--color-neg-soft)' : 'var(--color-warn-soft)';
  return <div className="rounded-[var(--radius-sm)] px-2 py-1.5 text-2xs" style={{ background: bg, color: textC, border: `1px solid color-mix(in oklab, ${c} 40%, transparent)` }}>{children}</div>;
}
