// src/modules/taxes/TaxesModule.tsx
//
// Phase 6 — Taxes module. 4 KPIs + a 3-tab layout (Strategy Board / Assessments & Appeals /
// Filed Returns).
//
// Scope note: the design reference (design_handoff_ora_command_center/app/Taxes.html) shows a
// third "Filed Returns" tab. Phase 6 held that OUT OF SCOPE for this repo's confidentiality
// boundary. P4c / C2 (Task 10) reopens it under an explicit placeholder-data regime — the tab
// now ships, but METADATA-ONLY, PERMANENTLY (contracts/tax-strategy.ts header rule 1): return
// CONTENTS never enter this system, not now and not once real accountant records replace the
// placeholder fixture. The confidentiality BOUNDARY that put filed returns on the cut list is
// unchanged; only the metadata surface above it reopens.
//
// Loading/empty/error states mirror debt/ScorecardView.tsx exactly: Skeleton while loading, an
// informational offline card when the warehouse routes are unreachable (static mirror), a red
// error card on a real failure. The Filed Returns tab body has its own small loading/offline
// fallback scoped to useTaxStrategy() (see below) since that hook's result gates ONLY that tab
// and the Strategy Board's optional third tier — never the whole module the way useTaxAnalysis
// does.
import { useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { fmtUsdCompact, fmtPct, fmtNum } from '@analytics/index';
import { cn } from '@/lib/cn';
import { isWarehouseUnavailable } from '../intel/hooks';
import {
  useTaxAnalysis,
  useTaxStrategy,
  sumIdentifiedOpportunityUsd,
  computePortfolioEffectiveRate,
  countAppealsInFlight,
} from './hooks';
import { StrategyBoard } from './StrategyBoard';
import { AssessmentsTable } from './AssessmentsTable';
import { FiledReturnsTable } from './FiledReturnsTable';

type Tab = 'strategy' | 'assessments' | 'returns';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'strategy', label: 'Strategy Board' },
  { id: 'assessments', label: 'Assessments & Appeals' },
  { id: 'returns', label: 'Filed Returns' },
];

export function TaxesModule() {
  const [tab, setTab] = useState<Tab>('strategy');
  const { data: report, isLoading, error } = useTaxAnalysis();
  const { data: strategyReport, isLoading: strategyLoading } = useTaxStrategy();

  if (isLoading) return <Skeleton style={{ height: 320 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Taxes" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Tax analysis requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            Assessments, appeals, and tax opportunities are computed from the warehouse ledger +
            Spine A property snapshot. This deployed mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Taxes" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load tax analysis.'}
        </div>
      </Card>
    );
  }

  if (!report) return null;

  const identifiedOpportunity = sumIdentifiedOpportunityUsd(report.opportunities);
  const effectiveRate = computePortfolioEffectiveRate(report.assessments);
  const appealsInFlight = countAppealsInFlight(report.appeals);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Taxes"
          trailing={
            <div className="flex items-center gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'num rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase transition-colors',
                    tab === t.id ? 'cursor-default' : 'cursor-pointer',
                  )}
                  style={
                    tab === t.id
                      ? {
                          background: 'color-mix(in oklab, var(--accent) 16%, transparent)',
                          color: 'var(--text-accent)',
                          border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)',
                          letterSpacing: '0.06em',
                        }
                      : {
                          background: 'transparent',
                          color: 'var(--text-tertiary)',
                          border: '1px solid transparent',
                          letterSpacing: '0.06em',
                        }
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Annual Property Tax"
          value={report.ledgerTaxAnnualUsd}
          format={fmtUsdCompact}
          accentColor="var(--color-warn)"
          sublabel="Billed total — ledger, full-asset basis"
        />
        <KpiStat
          label="Effective Rate"
          value={effectiveRate}
          format={(n) => fmtPct(n, 2)}
          sublabel={
            effectiveRate === null
              ? 'Varies by property — see table'
              : 'Portfolio-weighted, full-asset basis'
          }
        />
        <KpiStat
          label="Identified Opportunity"
          value={identifiedOpportunity}
          format={fmtUsdCompact}
          accentColor="var(--color-pos)"
          sublabel="Oxford share, determinate appeals"
        />
        <KpiStat
          label="Appeals in Flight"
          value={appealsInFlight}
          format={fmtNum}
          sublabel={`${report.appeals.length} total appeal${report.appeals.length === 1 ? '' : 's'}`}
        />
      </div>

      {tab === 'strategy' ? (
        <StrategyBoard opportunities={report.opportunities} strategyReport={strategyReport} />
      ) : tab === 'assessments' ? (
        <AssessmentsTable report={report} />
      ) : strategyReport ? (
        <FiledReturnsTable report={strategyReport} />
      ) : strategyLoading ? (
        <Skeleton style={{ height: 200 }} />
      ) : (
        <Card>
          <CardHeader title="Filed Returns" trailing={<Badge tone="neutral">offline</Badge>} />
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Filed-return metadata requires the live brain server.
          </div>
        </Card>
      )}
    </div>
  );
}
