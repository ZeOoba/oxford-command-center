// src/modules/taxes/AssessmentsTable.tsx
//
// Phase 6 — Taxes module Assessments & Appeals tab.
//
// A DataTable of every property's latest assessment (property, tax year, jurisdiction, assessed
// value, assessment ratio, millage, annual tax billed), an Oxford-share savings-potential column
// (the same basis-doctrine figure the Strategy Board ranks by — never savingsFullAsset), and an
// Appeals column showing existing appeals (status badges) plus a "File Appeal" action. Default
// sort is by potential overshoot (the savings-potential column, desc) — the properties most worth
// reviewing surface first.
//
// "File Appeal" opens an inline panel below the table (mirrors intel/ImportsView.tsx's row-click
// → detail-panel convention — DataTable itself has no row-expansion slot) with the tax year
// pre-filled from the clicked row and status defaulted to 'draft'.
import { useMemo, useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import { fmtUsd, fmtPct } from '@analytics/index';
import { TaxAppealStatus } from '@contracts/tax';
import { useFileAppeal, appealStatusTone, appealsByProperty, opportunityByProperty } from './hooks';
import type { TaxAnalysisReport, TaxAssessment, TaxAppeal, TaxOpportunity } from './hooks';

const fieldStyle = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const;

function fmtMillage(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)} mills`;
}

/** Oxford-share savings potential for a row — null when there is no opportunity for the
 *  property, it is indeterminate, or its savingsOxfordShare is itself null (Oxford ownership %
 *  unavailable). Never derived from savingsFullAsset (basis doctrine). */
function savingsDisplay(o: TaxOpportunity | undefined): number | null {
  if (!o || o.indeterminate || o.savingsOxfordShare === null) return null;
  return o.savingsOxfordShare;
}

function savingsSortValue(o: TaxOpportunity | undefined): number {
  return savingsDisplay(o) ?? -1;
}

function buildColumns(
  opportunities: Map<string, TaxOpportunity>,
  appealsMap: Map<string, TaxAppeal[]>,
  onFile: (target: { propertyId: string; taxYear: number }) => void,
): Column<TaxAssessment>[] {
  const nameFor = (propertyId: string) => opportunities.get(propertyId)?.propertyName ?? propertyId;

  return [
    {
      key: 'property',
      header: 'Property',
      render: (a) => (
        <div>
          <div style={{ fontWeight: 600 }}>{nameFor(a.propertyId)}</div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{a.propertyId}</div>
        </div>
      ),
      sortValue: (a) => nameFor(a.propertyId),
    },
    {
      key: 'taxYear',
      header: 'Tax Year',
      align: 'right',
      render: (a) => <span className="num">{a.taxYear}</span>,
      sortValue: (a) => a.taxYear,
    },
    {
      key: 'jurisdiction',
      header: 'Jurisdiction',
      render: (a) => a.jurisdiction ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>,
      sortValue: (a) => a.jurisdiction ?? '',
    },
    {
      key: 'assessedValue',
      header: 'Assessed Value',
      align: 'right',
      render: (a) => fmtUsd(a.assessedValue),
      sortValue: (a) => a.assessedValue ?? -1,
    },
    {
      key: 'assessmentRatio',
      header: 'Assessment Ratio',
      align: 'right',
      render: (a) => fmtPct(a.assessmentRatio, 1),
      sortValue: (a) => a.assessmentRatio ?? -1,
    },
    {
      key: 'millageRate',
      header: 'Millage',
      align: 'right',
      render: (a) => fmtMillage(a.millageRate),
      sortValue: (a) => a.millageRate ?? -1,
    },
    {
      key: 'annualTaxBilled',
      header: 'Annual Tax Billed',
      align: 'right',
      render: (a) => fmtUsd(a.annualTaxBilled),
      sortValue: (a) => a.annualTaxBilled ?? -1,
    },
    {
      key: 'savings',
      header: 'Oxford Savings Potential',
      align: 'right',
      render: (a) => {
        const val = savingsDisplay(opportunities.get(a.propertyId));
        return (
          <span style={{ color: val !== null ? 'var(--text-pos)' : 'var(--text-tertiary)' }}>
            {val !== null ? fmtUsd(val) : '—'}
          </span>
        );
      },
      sortValue: (a) => savingsSortValue(opportunities.get(a.propertyId)),
    },
    {
      key: 'appeals',
      header: 'Appeals',
      render: (a) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {(appealsMap.get(a.propertyId) ?? []).map((ap) => (
            <Badge key={ap.id} tone={appealStatusTone(ap.status)}>{`FY${ap.taxYear} ${ap.status}`}</Badge>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => onFile({ propertyId: a.propertyId, taxYear: a.taxYear })}
            aria-label={`File appeal for ${nameFor(a.propertyId)}`}
          >
            File Appeal
          </Button>
        </div>
      ),
    },
  ];
}

function AppealFormPanel({
  propertyId,
  propertyName,
  taxYear,
  suggestedSavings,
  onClose,
}: {
  propertyId: string;
  propertyName: string;
  taxYear: number;
  suggestedSavings: number | null;
  onClose: () => void;
}) {
  const fileAppeal = useFileAppeal();
  const [year, setYear] = useState(String(taxYear));
  const [status, setStatus] = useState<TaxAppealStatus>('draft');
  const [filedDate, setFiledDate] = useState('');
  const [estSavings, setEstSavings] = useState(
    suggestedSavings !== null ? String(Math.round(suggestedSavings)) : '',
  );
  const [notes, setNotes] = useState('');

  const submit = () => {
    const parsedYear = Number.parseInt(year, 10);
    if (!Number.isFinite(parsedYear)) return;
    fileAppeal.mutate(
      {
        propertyId,
        taxYear: parsedYear,
        status,
        filedDate: filedDate.trim() === '' ? null : filedDate,
        estSavingsAnnual: estSavings.trim() === '' ? null : Number(estSavings),
        realizedSavingsAnnual: null,
        notes: notes.trim() === '' ? null : notes,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Card accent>
      <CardHeader
        title={`File Appeal — ${propertyName}`}
        trailing={
          <Button size="sm" variant="ghost" onPress={onClose} aria-label="Cancel appeal form">
            Cancel
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Tax Year</span>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            aria-label="Tax year"
            className="num h-8 w-24 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaxAppealStatus)}
            aria-label="Appeal status"
            className="num h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
            style={fieldStyle}
          >
            {TaxAppealStatus.options.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Filed Date</span>
          <input
            type="date"
            value={filedDate}
            onChange={(e) => setFiledDate(e.target.value)}
            aria-label="Filed date"
            className="num h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Est. Savings / yr</span>
          <input
            type="number"
            value={estSavings}
            onChange={(e) => setEstSavings(e.target.value)}
            placeholder="—"
            aria-label="Estimated annual savings"
            className="num h-8 w-32 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 200 }}>
          <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-label="Notes"
            className="h-8 w-full rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
            style={fieldStyle}
          />
        </label>
        <Button
          size="sm"
          variant="primary"
          onPress={submit}
          isDisabled={fileAppeal.isPending}
          aria-label="Submit appeal"
        >
          {fileAppeal.isPending ? 'Filing…' : 'Submit Appeal'}
        </Button>
      </div>
      {fileAppeal.isError && (
        <div className="px-4 pb-3 text-2xs" style={{ color: 'var(--text-neg)' }}>
          {fileAppeal.error instanceof Error ? fileAppeal.error.message : 'Failed to file appeal.'}
        </div>
      )}
    </Card>
  );
}

export function AssessmentsTable({ report }: { report: TaxAnalysisReport }) {
  const [filing, setFiling] = useState<{ propertyId: string; taxYear: number } | null>(null);

  const opportunities = useMemo(() => opportunityByProperty(report.opportunities), [report.opportunities]);
  const appealsMap = useMemo(() => appealsByProperty(report.appeals), [report.appeals]);
  const columns = useMemo(
    () => buildColumns(opportunities, appealsMap, setFiling),
    [opportunities, appealsMap],
  );

  const filingOpportunity = filing ? opportunities.get(filing.propertyId) : undefined;
  const filingSavings = filingOpportunity && !filingOpportunity.indeterminate
    ? filingOpportunity.savingsOxfordShare
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Assessments & Appeals"
          trailing={<Badge tone="neutral">{report.assessments.length} assessments</Badge>}
        />
        <DataTable
          columns={columns}
          rows={report.assessments}
          getRowId={(a) => `${a.propertyId}-${a.taxYear}`}
          initialSort={{ key: 'savings', dir: 'desc' }}
          minWidth={960}
        />
      </Card>
      {filing && (
        <AppealFormPanel
          propertyId={filing.propertyId}
          propertyName={opportunities.get(filing.propertyId)?.propertyName ?? filing.propertyId}
          taxYear={filing.taxYear}
          suggestedSavings={filingSavings}
          onClose={() => setFiling(null)}
        />
      )}
    </div>
  );
}
