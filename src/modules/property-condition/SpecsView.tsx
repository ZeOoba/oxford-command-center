// src/modules/property-condition/SpecsView.tsx
//
// Building Specs & Historical Findings — a per-property building profile merged from EVERY report, stale ones
// included. Each fact is stamped with its own as_of date and report vintage. Stale facts are shown "as reported in
// <year>" first; the computed "projected status today" is a labeled [FORECAST], never a finding. A current-vintage
// fact for the same component always wins; the stale value stays visible as history.
//
// Nothing here feeds a reserve, the near-term rollup, a forecast input, or calibration. Stale-report dollars are never
// summed; they appear per row, labeled with the report year and STALE (findings ledger rows and any dollar-valued facts
// in the profile, e.g. a stated reserve total).
import { useMemo, useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd } from '@analytics/index';
import { byCode } from '@/analytics/pca-intelligence';
import {
  SPEC_COMPONENTS,
  buildFindingsLedger,
  crossVintageDiff,
  effectiveSpecs,
  filterFacts,
  filterFindings,
  formatSpecValue,
  hvacOwnershipRollup,
  projectRoofs,
  roofEulText,
  roofProjectionKey,
  roofForecastText,
  roofRollup,
  sprinklerRollup,
  type CoverageRow,
  type CountRow,
  type DiffRow,
  type EffectiveSpec,
  type LedgerRow,
  type RoofProjection,
  type Vintage,
} from '@/analytics/building-specs';
import { fmtPartialDate } from './hooks';
import { useBuildingSpecs, type BuildingSpecsModel } from './specs-data';

const muted = { color: 'var(--text-tertiary)' } as const;
const yrs = (n: number): string => `${n} yr${n === 1 ? '' : 's'}`;
const VINTAGE_TONE: Record<Vintage, BadgeTone> = { CURRENT: 'green', DRAFT: 'amber', STALE: 'neutral' };
const STATUS_TONE: Record<CoverageRow['status'], BadgeTone> = { READ: 'green', PARTIAL: 'amber', UNREADABLE: 'red' };

const fmtValue = formatSpecValue;

// ── coverage ────────────────────────────────────────────────────────────────────────────────

export function CoverageCard({ rows }: { rows: CoverageRow[] }) {
  const counts = { READ: 0, PARTIAL: 0, UNREADABLE: 0 };
  for (const r of rows) counts[r.status] += 1;
  return (
    <Card>
      <CardHeader
        title="Extraction coverage"
        trailing={<Badge tone={counts.UNREADABLE > 0 ? 'red' : 'neutral'}>{counts.READ} read · {counts.PARTIAL} partial · {counts.UNREADABLE} unreadable</Badge>}
      />
      <div className="overflow-x-auto">
        <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-2xs" style={{ ...muted, textAlign: 'left' }}>
              <th className="px-3 py-2">Report</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Facts</th>
              <th className="px-3 py-2 text-right">Findings</th>
              <th className="px-3 py-2">Pages</th>
              <th className="px-3 py-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.reportId} style={{ borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                <td className="px-3 py-2 text-xs">
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.reportId} · {r.propertyLabel}</div>
                  <div className="num text-2xs" style={muted}>{r.consultant} · {fmtPartialDate(r.reportDate)}</div>
                </td>
                <td className="px-3 py-2 text-xs">
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  {r.ocr && <span className="text-2xs" style={muted}> OCR</span>}
                </td>
                <td className="num px-3 py-2 text-right text-xs">{r.facts}</td>
                <td className="num px-3 py-2 text-right text-xs">{r.findings}</td>
                <td className="num px-3 py-2 text-2xs" style={muted}>
                  {r.pagesTotal} total{r.pagesWithoutText > 0 ? ` · ${r.pagesWithoutText} no text` : ''}
                </td>
                <td className="px-3 py-2 text-2xs" style={muted}>
                  {r.status === 'UNREADABLE' && (
                    <div style={{ color: 'var(--text-neg)' }}>UNREADABLE — path tried: {r.pathTried ?? 'n/a'}</div>
                  )}
                  {Object.entries(r.factsByComponent).map(([c, n]) => `${c} ${n}`).join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── roof clock ──────────────────────────────────────────────────────────────────────────────

const ROOF_COLS: Column<RoofProjection & { label2: string }>[] = [
  {
    key: 'roof',
    header: 'Roof',
    render: (r) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{r.label2}</div>
        <div className="num text-2xs" style={muted}>{r.reportId} · {r.scope ?? 'whole site'}</div>
      </div>
    ),
    sortValue: (r) => r.label2,
  },
  {
    key: 'reported',
    header: 'As reported',
    render: (r) => (
      <div>
        <div className="num text-xs">installed {r.installYear}</div>
        <div className="flex items-center gap-1 text-2xs" style={muted}>
          in {r.asReportedYear} report <Badge tone={VINTAGE_TONE[r.vintage]}>{r.vintage}</Badge>
        </div>
      </div>
    ),
    sortValue: (r) => r.installYear,
  },
  {
    key: 'eul',
    header: 'EUL',
    align: 'right',
    render: (r) => <span className="num text-xs">{roofEulText(r)}</span>,
    sortValue: (r) => r.eulMin,
  },
  {
    key: 'age',
    header: 'Age today',
    align: 'right',
    render: (r) => <span className="num text-xs">{yrs(r.ageToday)}</span>,
    sortValue: (r) => r.ageToday,
  },
  {
    key: 'left',
    header: 'Projected today [FORECAST]',
    align: 'right',
    render: (r) =>
      r.yearsRemaining === null ? (
        <span className="num text-xs" style={muted}>{roofForecastText(r)}</span>
      ) : (
        <span className="num text-xs" style={{ color: r.pastEul && r.vintage !== 'STALE' ? 'var(--text-neg)' : r.pastEul === null && r.vintage !== 'STALE' ? 'var(--text-warn)' : undefined }}>
          {roofForecastText(r)}
        </span>
      ),
    sortValue: (r) => r.yearsRemaining,
  },
];

function RoofClockCard({ projections, labels }: { projections: RoofProjection[]; labels: Map<string, string> }) {
  const rows = projections.map((p) => ({ ...p, label2: labels.get(p.propertyKey) ?? p.propertyKey }));
  // Stale roofs are projected for reference but never counted: a roof may have been replaced since the old report.
  const past = projections.filter((p) => p.pastEul === true && p.vintage !== 'STALE').length;
  const staleN = projections.filter((p) => p.vintage === 'STALE').length;
  return (
    <Card>
      <CardHeader title="Roof age & past-EUL list" trailing={<Badge tone={past > 0 ? 'amber' : 'neutral'}>{past} past EUL (current + draft) · {rows.length} roofs with an install year ({staleN} stale, history only)</Badge>} />
      <p className="num px-4 pb-2 text-2xs" style={muted}>
        Projected status is install year + the report's own EUL, computed from today's date and labeled [FORECAST] — it is not a finding and
        does not assert present condition. Where a report states no EUL, nothing is assumed; where it states conflicting EULs, the
        range is shown, sorted on the shortest, and a roof counts as past EUL only when it is past every stated EUL.
      </p>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No roof install years in the current filter.</div>
      ) : (
        <DataTable columns={ROOF_COLS} rows={rows} getRowId={(r) => roofProjectionKey(r.propertyKey, r.reportId, r.scope, r.installYear)} initialSort={{ key: 'left', dir: 'asc' }} maxHeight={420} minWidth={720} />
      )}
    </Card>
  );
}

// ── rollups ─────────────────────────────────────────────────────────────────────────────────

function CountTable({ title, rows }: { title: string; rows: CountRow[] }) {
  return (
    <div className="px-4 py-3">
      <div className="text-2xs" style={{ ...muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{title}</div>
      {rows.length === 0 ? (
        <div className="text-2xs" style={muted}>none in filter</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-2xs" style={muted}>
              <th style={{ textAlign: 'left', padding: '2px 0' }} />
              <th className="text-right">Current</th>
              <th className="text-right">Draft</th>
              <th className="text-right">Stale</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="text-xs">
                <td style={{ padding: '2px 0', color: 'var(--text-primary)' }}>{r.key}</td>
                <td className="num text-right">{r.CURRENT}</td>
                <td className="num text-right">{r.DRAFT}</td>
                <td className="num text-right" style={muted}>{r.STALE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RollupsCard({ facts }: { facts: BuildingSpecsModel['facts'] }) {
  const roofs = roofRollup(facts);
  return (
    <Card>
      <CardHeader title="Portfolio spec rollups (counts by vintage)" trailing={<Badge tone="neutral">counts only — no dollars</Badge>} />
      <div className="grid gap-0 md:grid-cols-2">
        <CountTable title="Roof type" rows={roofs.byType} />
        <CountTable title="Roof install-year cohort" rows={roofs.byCohort} />
        <CountTable title="HVAC ownership" rows={hvacOwnershipRollup(facts)} />
        <CountTable title="Sprinklered vs not" rows={sprinklerRollup(facts)} />
      </div>
      <p className="num px-4 pb-3 text-2xs" style={muted}>
        One count per reported roof section / statement per report, so a building covered by both a stale and a current report appears in
        both columns. Free-text answers that cannot be classified are counted as "unclassified", not guessed.
      </p>
    </Card>
  );
}

// ── cross-vintage diff ──────────────────────────────────────────────────────────────────────

function DiffCard({ propertyLabel, rows }: { propertyLabel: string; rows: DiffRow[] }) {
  const changed = rows.filter((r) => r.differs).length;
  return (
    <Card>
      <CardHeader title={`Cross-vintage diff — ${propertyLabel}`} trailing={<Badge tone={changed > 0 ? 'amber' : 'neutral'}>{changed} differ</Badge>} />
      <div className="overflow-x-auto">
        <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-2xs" style={{ ...muted, textAlign: 'left' }}>
              <th className="px-3 py-2">Component · attribute</th>
              <th className="px-3 py-2">Stale report</th>
              <th className="px-3 py-2">Current / draft report</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.component}|${r.attribute}`} className="text-xs" style={{ borderTop: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                <td className="px-3 py-2">{r.component} · {r.attribute}</td>
                <td className="px-3 py-2" style={muted}>{r.stale.length ? r.stale.join('; ') : 'n/a'}</td>
                <td className="px-3 py-2">{r.current.length ? r.current.join('; ') : 'n/a'}</td>
                <td className="px-3 py-2">{r.differs && <Badge tone="amber">differs</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="num px-4 py-2 text-2xs" style={muted}>
        The current-vintage value governs; the stale value is history. Differences are candidates for PCA_RECONCILIATION.md, not corrections.
      </p>
    </Card>
  );
}

// ── facts profile ───────────────────────────────────────────────────────────────────────────

function profileColumns(projectionByKey: Map<string, RoofProjection>): Column<EffectiveSpec>[] {
  return [
    {
      key: 'what',
      header: 'Property · component · attribute',
      render: (e) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{e.effective.property_label}</div>
          <div className="text-2xs" style={muted}>{e.component} · {e.attribute}{e.scope ? ` · ${e.scope}` : ''}</div>
        </div>
      ),
      sortValue: (e) => `${e.effective.property_label}|${e.component}|${e.attribute}`,
    },
    {
      key: 'value',
      header: 'Value',
      render: (e) => {
        const proj = e.attribute === 'install_year' && e.component === 'roof'
          ? projectionByKey.get(roofProjectionKey(e.property, e.effective.report_id, e.scope, e.effective.value))
          : undefined;
        return (
          <div>
            <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
              {fmtValue(e.effective.value, e.effective.unit)}
              {e.effective.confidence === 'DERIVED' && <span className="text-2xs" style={muted}> derived</span>}
            </div>
            {proj && (
              <div className="num text-2xs" style={{ color: 'var(--text-warn)' }}>
                [FORECAST] {yrs(proj.ageToday)} old today
                {proj.yearsRemaining === null ? '; EUL not stated' : `; ${roofForecastText(proj)}`}
              </div>
            )}
            {e.effective.note && <div className="text-2xs" style={muted}>{e.effective.note}</div>}
          </div>
        );
      },
      sortValue: (e) => String(e.effective.value),
    },
    {
      key: 'asof',
      header: 'As reported',
      render: (e) => (
        <div className="flex flex-wrap items-center gap-1">
          <span className="num text-2xs">{e.staleOnly ? `as reported in ${e.effective.report_date.slice(0, 4)}` : fmtPartialDate(e.effective.as_of)}</span>
          <Badge tone={VINTAGE_TONE[e.effective.report_vintage]}>{e.effective.report_vintage}</Badge>
          {e.effective.ocr && <Badge tone="neutral">OCR</Badge>}
        </div>
      ),
      sortValue: (e) => e.effective.as_of,
    },
    {
      key: 'history',
      header: 'History',
      render: (e) =>
        e.history.length === 0 ? (
          <span className="text-2xs" style={muted}>—</span>
        ) : (
          <div className="text-2xs" style={muted} title={e.history.map((h) => `${h.report_id} ${h.as_of}: ${fmtValue(h.value, h.unit)}`).join('\n')}>
            {e.history.length} older{e.conflicts ? ' · ' : ''}
            {e.conflicts && <span style={{ color: 'var(--text-warn)' }}>differs</span>}
          </div>
        ),
      sortValue: (e) => e.history.length,
    },
    {
      key: 'src',
      header: 'Source',
      render: (e) => <span className="num text-2xs" style={muted}>{e.effective.report_id} p.{e.effective.source_page}</span>,
      sortValue: (e) => e.effective.report_id,
    },
  ];
}

// ── findings ledger ─────────────────────────────────────────────────────────────────────────

const FINDING_COLS: Column<LedgerRow>[] = [
  {
    key: 'finding',
    header: 'Finding',
    render: (r) => (
      <div>
        <div style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-primary)' }}>{r.property_label}</div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{r.description}</div>
        <div className="text-2xs" style={muted}>{r.component}{r.scope ? ` · ${r.scope}` : ''}</div>
      </div>
    ),
    sortValue: (r) => `${r.property_label}|${r.finding_id}`,
  },
  {
    key: 'priority',
    header: 'Original priority',
    render: (r) => (
      <div>
        <div className="text-xs">{r.priority}</div>
        {r.timing && <div className="text-2xs" style={muted}>{r.timing}</div>}
      </div>
    ),
    sortValue: (r) => r.priority,
  },
  {
    key: 'estimate',
    header: 'Estimate (as of report year)',
    align: 'right',
    render: (r) => (
      <div>
        <div className="num text-xs">{r.estimate_usd === null ? 'n/a' : fmtUsd(r.estimate_usd)}</div>
        <div className="flex items-center justify-end gap-1 text-2xs" style={muted}>
          {r.estimate_label} <Badge tone={VINTAGE_TONE[r.report_vintage]}>{r.report_vintage}</Badge>
        </div>
      </div>
    ),
    sortValue: (r) => r.estimate_usd,
  },
  {
    key: 'resolved',
    header: 'Resolved since',
    render: (r) => (
      <div>
        <span className="num text-xs" style={{ color: r.resolved_since === 'UNKNOWN' ? 'var(--text-warn)' : undefined }}>{r.resolved_since}</span>
        {r.resolution_note && <div className="text-2xs" style={muted}>{r.resolution_note}</div>}
      </div>
    ),
    sortValue: (r) => r.resolved_since,
  },
  {
    key: 'src',
    header: 'Source',
    render: (r) => <span className="num text-2xs" style={muted}>{r.report_id} p.{r.source_page}{r.ocr ? ' · OCR' : ''}</span>,
    sortValue: (r) => r.report_id,
  },
];

// ── view ────────────────────────────────────────────────────────────────────────────────────

const selectStyle = { background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '4px 6px', fontSize: 12 } as const;

export function SpecsView({ model, todayYear }: { model: BuildingSpecsModel; todayYear: number }) {
  const [property, setProperty] = useState('');
  const [component, setComponent] = useState('');
  const [vintage, setVintage] = useState<'' | Vintage>('');
  const [text, setText] = useState('');
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);

  const properties = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of model.metas) m.set(r.property_key, r.property_label);
    return [...m.entries()].sort((a, b) => byCode(a[1], b[1]));
  }, [model.metas]);
  const labels = useMemo(() => new Map(properties), [properties]);

  const filter = { property: property || undefined, component: component || undefined, vintage: vintage || undefined, text: text || undefined };
  const facts = useMemo(() => filterFacts(model.facts, filter), [model.facts, property, component, vintage, text]); // eslint-disable-line react-hooks/exhaustive-deps
  const effective = useMemo(() => effectiveSpecs(facts), [facts]);
  // Roof clock inputs span SEPARATE facts (install year, EUL), so the text/component filters must not thin them out:
  // project from property + vintage only, otherwise a search drops the EUL fact and the roof reads "EUL not stated".
  const roofBase = useMemo(() => filterFacts(model.facts, { property: property || undefined, vintage: vintage || undefined }), [model.facts, property, vintage]);
  const projections = useMemo(() => projectRoofs(roofBase, todayYear), [roofBase, todayYear]);
  const projectionByKey = useMemo(() => new Map(projections.map((p) => [roofProjectionKey(p.propertyKey, p.reportId, p.scope, p.installYear), p])), [projections]);
  const ledger = useMemo(() => buildFindingsLedger(model.findings, model.resolutions), [model.findings, model.resolutions]);
  const findings = useMemo(
    () => filterFindings(ledger, { ...filter, unresolvedOnly }),
    [ledger, property, component, vintage, text, unresolvedOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const diffs = useMemo(() => {
    const keys = property ? [property] : properties.map(([k]) => k);
    return keys.map((k) => ({ key: k, rows: crossVintageDiff(model.facts, k) })).filter((d) => d.rows.length > 0);
  }, [model.facts, property, properties]);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title="Building specs & historical findings" trailing={<Badge tone="neutral">{model.facts.length} facts · {model.findings.length} findings · {model.metas.length} reports</Badge>} />
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <select aria-label="Property" value={property} onChange={(e) => setProperty(e.target.value)} style={selectStyle}>
            <option value="">All properties</option>
            {properties.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select aria-label="Component" value={component} onChange={(e) => setComponent(e.target.value)} style={selectStyle}>
            <option value="">All components</option>
            {SPEC_COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select aria-label="Vintage" value={vintage} onChange={(e) => setVintage(e.target.value as '' | Vintage)} style={selectStyle}>
            <option value="">All vintages</option>
            <option value="CURRENT">Current</option>
            <option value="DRAFT">Draft</option>
            <option value="STALE">Stale</option>
          </select>
          <input aria-label="Search" placeholder="Search facts and findings" value={text} onChange={(e) => setText(e.target.value)} style={{ ...selectStyle, minWidth: 200 }} />
          <label className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={unresolvedOnly} onChange={(e) => setUnresolvedOnly(e.target.checked)} /> Unresolved findings only
          </label>
        </div>
        <p className="num px-4 pb-3 text-2xs" style={muted}>
          Every fact carries its own as_of date and report vintage (CURRENT · DRAFT · STALE = dated before 2024). Stale facts are history:
          they never feed forecasts, reserve totals, the near-term rollup or calibration, and a current fact for the same component always wins.
        </p>
      </Card>

      <CoverageCard rows={model.coverage} />
      <RoofClockCard projections={projections} labels={labels} />
      <RollupsCard facts={facts} />
      {diffs.map((d) => <DiffCard key={d.key} propertyLabel={labels.get(d.key) ?? d.key} rows={d.rows} />)}

      <Card>
        <CardHeader title="Building profile — effective facts" trailing={<Badge tone="neutral">{effective.length} facts</Badge>} />
        {effective.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No facts match the current filter.</div>
        ) : (
          <DataTable columns={profileColumns(projectionByKey)} rows={effective} getRowId={(e) => `${e.property}|${e.component}|${e.attribute}|${e.scope ?? ''}|${e.effective.report_id}|${e.effective.source_page}`} initialSort={{ key: 'what', dir: 'asc' }} maxHeight={560} minWidth={820} />
        )}
      </Card>

      <Card>
        <CardHeader title="Findings ledger" trailing={<Badge tone="neutral">{findings.length} findings · no totals</Badge>} />
        <p className="num px-4 pb-2 text-2xs" style={muted}>
          Original priority and estimate from each report, in a column labeled with the report year. Dollars from different report years
          are never summed or compared as current; "resolved since" stays UNKNOWN until work done is recorded in data/building-specs/resolutions.json.
        </p>
        {findings.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>No findings match the current filter.</div>
        ) : (
          <DataTable columns={FINDING_COLS} rows={findings} getRowId={(r) => r.finding_id} initialSort={{ key: 'finding', dir: 'asc' }} maxHeight={560} minWidth={820} />
        )}
      </Card>
    </div>
  );
}

export function SpecsPanel({ enabled }: { enabled: boolean }) {
  const { data, isLoading, error } = useBuildingSpecs(enabled);
  if (isLoading) return <Skeleton style={{ height: 320 }} />;
  if (error) {
    return (
      <Card>
        <CardHeader title="Building specs" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>{error instanceof Error ? error.message : 'Failed to load building specs.'}</div>
      </Card>
    );
  }
  if (!data) return null;
  return <SpecsView model={data} todayYear={new Date().getFullYear()} />;
}
