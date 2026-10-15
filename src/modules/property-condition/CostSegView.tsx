// src/modules/property-condition/CostSegView.tsx
//
// Cost Segregation Property Data — engineering takeoffs and RSMeans / Marshall & Swift modeled pricing from the six cost
// segregation studies, kept in their own price basis. This is NOT a condition assessment: it records quantities, system
// types and modeled cost for tax classification, never condition, remaining life or deferred maintenance. Nothing here
// feeds a reserve total, the near-term rollup, reserve intensity, or calibration statistics; the basis panel shows class
// splits and placed-in-service dates exactly as read (no recomputation, no edits to models or governors).
import { useMemo, useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { fmtUsd } from '@analytics/index';
import {
  COST_SEG_BASIS,
  COST_SEG_PROPERTY_MAP,
  crossCheck,
  isUnverified,
  pcaComparators,
  sourceKind,
  specSheet,
  studyRegister,
  type CostSegDatasetT,
  type CostSegFactT,
  type CostSegStudyId,
  type QuantityStatus,
} from '@/analytics/cost-seg';
import { fmtPartialDate } from './hooks';
import { useCostSeg } from './cost-seg-data';
import { useBuildingSpecs } from './specs-data';

const muted = { color: 'var(--text-tertiary)' } as const;
const STATUS_TONE: Record<QuantityStatus, BadgeTone> = { match: 'green', differs: 'amber', 'no-pca': 'neutral', 'not-comparable': 'neutral' };
const STATUS_LABEL: Record<QuantityStatus, string> = { match: 'matches', differs: 'differs', 'no-pca': 'no PCA value', 'not-comparable': 'scope differs — not compared' };
const CLASS_LABEL: Record<string, string> = { '5yr': '5-yr', '7yr': '7-yr', '15yr': '15-yr', '39yr': '39-yr', '9yr_ads': 'ADS 9-yr' };

const fmtNum = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function ValueCell({ f }: { f: CostSegFactT }) {
  const v = f.value;
  if (Array.isArray(v)) {
    return (
      <ul className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        {v.map((x, i) => (
          <li key={i}>{String(x)}</li>
        ))}
      </ul>
    );
  }
  if (v !== null && typeof v === 'object') {
    return (
      <div className="num text-xs" style={{ color: 'var(--text-secondary)' }}>
        {Object.entries(v).map(([k, x]) => (
          <div key={k}>
            {k}: {typeof x === 'number' ? fmtNum(x) : typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)}
          </div>
        ))}
      </div>
    );
  }
  const text = typeof v === 'number' ? (f.unit === 'USD' || f.unit === 'USD/yr' ? fmtUsd(v) : fmtNum(v)) : String(v);
  return (
    <span className="text-xs" style={{ color: 'var(--text-primary)' }}>
      {text}
      {typeof v === 'number' && f.unit && f.unit !== 'USD' && f.unit !== 'USD/yr' ? ` ${f.unit}` : ''}
    </span>
  );
}

function Flags({ f }: { f: CostSegFactT }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {f.confidence === 'DERIVED' && <Badge tone="amber">DERIVED</Badge>}
      {f.ocr && <Badge tone="neutral">OCR</Badge>}
      {isUnverified(f) && <Badge tone="red">UNVERIFIED</Badge>}
      {sourceKind(f) === 'PROPERTY_NOTES' && <Badge tone="blue">property notes — not the study</Badge>}
    </div>
  );
}

// ── study register + basis panel ────────────────────────────────────────────────────────────

function RegisterCard({ ds }: { ds: CostSegDatasetT }) {
  const rows = studyRegister(ds);
  const classes = ['5yr', '7yr', '15yr', '39yr', '9yr_ads'];
  return (
    <Card>
      <CardHeader title="Study register & basis (read-only)" trailing={<Badge tone={rows.every((r) => r.ties && r.qcOk) ? 'green' : 'red'}>{rows.filter((r) => r.ties).length}/{rows.length} allocations tie</Badge>} />
      <div className="overflow-x-auto">
        <table aria-label="Cost segregation study register" style={{ width: '100%', minWidth: 980, borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-2xs" style={{ ...muted, textAlign: 'left' }}>
              <th className="px-3 py-2">Study · property</th>
              <th className="px-3 py-2">Consultant · report</th>
              <th className="px-3 py-2">Site visit</th>
              <th className="px-3 py-2">Placed in service</th>
              <th className="px-3 py-2 text-right">Total basis</th>
              {classes.map((c) => (
                <th key={c} className="px-3 py-2 text-right">{CLASS_LABEL[c]}</th>
              ))}
              <th className="px-3 py-2 text-right">Fee</th>
              <th className="px-3 py-2">Tie</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.studyId} className="text-xs" style={{ borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                <td className="px-3 py-2">
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.studyId}</div>
                  <div className="text-2xs" style={muted}>{r.property}</div>
                </td>
                <td className="px-3 py-2">
                  <div>{r.consultant}</div>
                  <div className="num text-2xs" style={muted}>{r.reportDate ? fmtPartialDate(r.reportDate) : 'cover date not read'}{r.ocr ? ' · OCR' : ''}</div>
                </td>
                <td className="num px-3 py-2">{fmtPartialDate(r.asOf)}</td>
                <td className="px-3 py-2 text-2xs">{r.pis}</td>
                <td className="num px-3 py-2 text-right">{fmtUsd(r.total)}</td>
                {classes.map((c) => (
                  <td key={c} className="num px-3 py-2 text-right">{r.alloc[c] ? fmtUsd(r.alloc[c] as number) : '—'}</td>
                ))}
                <td className="num px-3 py-2 text-right">{r.fee === null ? 'n/a' : fmtUsd(r.fee)}</td>
                <td className="px-3 py-2">
                  <Badge tone={r.ties && r.qcOk ? 'green' : 'red'}>{r.ties && r.qcOk ? 'ties' : 'does not tie'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="num px-4 py-2 text-2xs" style={muted}>
        Class splits and placed-in-service dates are shown as read from the study / tax register (ORA Master Workbook, CostSegBasis_ORA_Portfolio,
        TaxAndBasisRegister) — not recomputed, and no financial model or governor is touched.
        Basis: {COST_SEG_BASIS} — an engineering estimate, distinct from PCA consultant estimates and contractor prices.
      </p>
    </Card>
  );
}

// ── spec sheet ──────────────────────────────────────────────────────────────────────────────

function SpecSheetCard({ ds, studyId, onStudy }: { ds: CostSegDatasetT; studyId: string; onStudy: (id: string) => void }) {
  const sheet = useMemo(() => specSheet(ds.facts, studyId), [ds.facts, studyId]);
  const study = ds.studies[studyId];
  const nFacts = sheet.reduce((a, g) => a + g.facts.length, 0);
  return (
    <Card>
      <CardHeader title="Property spec sheet (modeled takeoff — not a condition assessment)" trailing={<Badge tone="neutral">{nFacts} facts</Badge>} />
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <select
          aria-label="Cost seg study"
          value={studyId}
          onChange={(e) => onStudy(e.target.value)}
          style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '4px 6px', fontSize: 12 }}
        >
          {Object.entries(ds.studies).map(([id, s]) => (
            <option key={id} value={id}>{id} — {s.property}</option>
          ))}
        </select>
        {study && <span className="num text-2xs" style={muted}>as of {fmtPartialDate(study.as_of)}</span>}
      </div>
      {studyId === 'CS-FIS' && (
        <p className="num px-4 pb-2 text-2xs" style={{ color: 'var(--text-warn)' }}>
          Fishel: CSSI provides dollars only (no quantities). The building description (1998, metal roof, doors, dock) comes from the owner's property notes,
          not the study, and is tagged accordingly.
        </p>
      )}
      {studyId === 'CS-NWD' && (
        <p className="num px-4 pb-2 text-2xs" style={{ color: 'var(--text-warn)' }}>
          Northwood is a scan (OCR pp.1–93 of 129): door counts and per-building roof area are back-solved from cost and DERIVED; asphalt quantity was lost in OCR.
        </p>
      )}
      {sheet.map((g) => (
        <div key={g.group} style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="px-4 py-2 text-2xs" style={{ ...muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{g.group}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {g.facts.map((f, i) => (
                <tr key={`${f.attribute}-${i}`} style={{ verticalAlign: 'top' }}>
                  <td className="px-4 py-1 text-xs" style={{ width: '32%', ...muted }}>{f.attribute.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-1"><ValueCell f={f} /></td>
                  <td className="px-2 py-1"><Flags f={f} /></td>
                  <td className="px-2 py-1 text-2xs" style={muted}>
                    {f.note}
                    {f.source_page !== null ? ` · p.${f.source_page}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="num px-4 py-2 text-2xs" style={muted}>
        Tenant lists are history as of the study date; the rent roll and HubSpot/Notion remain the tenant record. Electrical service ratings are UNVERIFIED
        until a panel schedule or utility record confirms them (Broadway and Red Branch share an identical electrical paragraph).
      </p>
    </Card>
  );
}

// ── cross-check ─────────────────────────────────────────────────────────────────────────────

function CrossCheckCard({ ds, specFacts, registerSf, registerStatus }: { ds: CostSegDatasetT; specFacts: Parameters<typeof pcaComparators>[0]; registerSf: Record<string, number | null>; registerStatus: Record<string, 'CURRENT' | 'DRAFT' | 'STALE'> }) {
  const groups = Object.keys(ds.studies).map((id) => {
    const key = COST_SEG_PROPERTY_MAP[id as CostSegStudyId] ?? null;
    const cmp = pcaComparators(specFacts, key, key === null ? null : registerSf[key] ?? null, key === null ? null : registerStatus[key] ?? null);
    return { id, key, rows: crossCheck(ds.facts, id, cmp) };
  });
  const differs = groups.reduce((a, g) => a + g.rows.filter((r) => r.status === 'differs').length, 0);
  return (
    <Card>
      <CardHeader title="PCA vs cost seg — quantity cross-check" trailing={<Badge tone={differs > 0 ? 'amber' : 'neutral'}>{differs} differ</Badge>} />
      <div className="overflow-x-auto">
        <table aria-label="PCA versus cost seg quantity cross-check" style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-2xs" style={{ ...muted, textAlign: 'left' }}>
              <th className="px-3 py-2">Study · metric</th>
              <th className="px-3 py-2 text-right">Cost seg (modeled)</th>
              <th className="px-3 py-2">PCA side</th>
              <th className="px-3 py-2">Check</th>
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((g) =>
              g.rows.map((r, i) => (
                <tr key={`${g.id}-${r.metric}-${i}`} className="text-xs" style={{ borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                  <td className="px-3 py-2">
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{g.id} · {r.metric}</div>
                    <div className="text-2xs" style={muted}>
                      {g.key === null ? 'no PCA on file' : `PCA key ${g.key}`}
                      {g.key !== null && !(ds.studies[g.id]?.property ?? '').toLowerCase().includes(g.key.replace(/-/g, ' ')) ? ` · study covers ${ds.studies[g.id]?.property ?? ''}` : ''}
                    </div>
                  </td>
                  <td className="num px-3 py-2 text-right">
                    {r.costSeg === null ? 'n/a' : `${fmtNum(r.costSeg)} ${r.unit}`}
                    <div className="flex justify-end gap-1">
                      {r.confidence === 'DERIVED' && <Badge tone="amber">DERIVED</Badge>}
                      {r.ocr && <Badge tone="neutral">OCR</Badge>}
                    </div>
                  </td>
                  <td className="num px-3 py-2 text-2xs" style={muted}>
                    {r.pca.length === 0 ? 'n/a' : r.pca.map((p) => `${fmtNum(p.value)} (${p.label}${p.vintage ? ` · ${p.vintage}` : ''})`).join('; ')}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.pctDiff !== null && r.status === 'differs' && (
                      <span className="num text-2xs" style={muted}> {r.pctDiff > 0 ? '+' : '−'}{Math.abs(r.pctDiff * 100).toFixed(1)}%</span>
                    )}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="num px-4 py-2 text-2xs" style={muted}>
        Informational only: no PCA reserve or quantity is adjusted, and a cost seg value never overwrites a PCA or field-note value. Where a roof is stated as several surfaces the rows are listed for reference but not compared (D2: the PCA and Able prices stay unlinked to any surface), and a stale PCA value never decides a check when a current one exists. A match is within 2% of the PCA's whole-property value (sectional values only when there is none). A different building SF would change PCA $/SF/yr — noted in D1, not applied.
      </p>
    </Card>
  );
}

// ── discrepancy queue ───────────────────────────────────────────────────────────────────────

function DiscrepancyCard({ ds }: { ds: CostSegDatasetT }) {
  return (
    <Card>
      <CardHeader title="Cost seg discrepancy queue (D1–D14)" trailing={<Badge tone="amber">{ds.discrepancies.length} open</Badge>} />
      <ul>
        {ds.discrepancies.map((d) => (
          <li key={d.id} className="flex gap-3 px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)', fontSize: 13 }}>
            <div className="num text-2xs" style={{ width: 28, flexShrink: 0, ...muted }}>{d.id}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{d.property}</div>
              <div style={{ color: 'var(--text-secondary)' }}>{d.issue}</div>
              <div className="text-2xs" style={muted}>Action: {d.action}</div>
            </div>
            <div className="text-2xs" style={{ width: 120, flexShrink: 0, textAlign: 'right', ...muted }}>
              <Badge tone="amber">Open</Badge>
              <div>Owner: unassigned</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── view ────────────────────────────────────────────────────────────────────────────────────

export function CostSegPanel({ registerSf, registerStatus }: { registerSf: Record<string, number | null>; registerStatus: Record<string, 'CURRENT' | 'DRAFT' | 'STALE'> }) {
  const cs = useCostSeg(true);
  const specs = useBuildingSpecs(true);
  const [studyId, setStudyId] = useState<string>('CS-LIV');
  if (cs.isLoading) return <Skeleton style={{ height: 320 }} />;
  const err = cs.error;
  if (err) {
    return (
      <Card>
        <CardHeader title="Cost seg" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>{err instanceof Error ? err.message : 'Failed to load cost seg data.'}</div>
      </Card>
    );
  }
  if (!cs.data) return null;
  const ds = cs.data;
  // The PCA side of the cross-check needs the building-specs facts; the rest of the view does not, so a specs problem must not blank it.
  const specFacts = specs.data?.facts ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="Cost segregation property data" trailing={<Badge tone="neutral">{Object.keys(ds.studies).length} studies · {ds.facts.length} facts</Badge>} />
        <p className="px-4 pb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Engineering takeoffs and RSMeans / Marshall &amp; Swift modeled pricing for tax classification — <strong>not</strong> a condition assessment and not a PCA
          estimate or a contractor price. It records quantities and system types; it never assesses condition, remaining life or deferred maintenance, and it never feeds
          reserves, near-term capex, reserve intensity or calibration statistics. Cost seg quantities can only be offered as a <em>candidate</em> quantity on a pending
          calibration proposal, which a person promotes.
        </p>
      </Card>
      <RegisterCard ds={ds} />
      <SpecSheetCard ds={ds} studyId={studyId} onStudy={setStudyId} />
      {specs.error && (
        <p className="num px-1 text-2xs" style={{ color: 'var(--text-neg)' }}>
          PCA building specs failed to load ({specs.error instanceof Error ? specs.error.message : 'error'}) — the cross-check shows register SF only.
        </p>
      )}
      <CrossCheckCard ds={ds} specFacts={specFacts} registerSf={registerSf} registerStatus={registerStatus} />
      <DiscrepancyCard ds={ds} />
    </div>
  );
}
