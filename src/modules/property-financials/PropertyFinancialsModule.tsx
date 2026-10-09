// src/modules/property-financials/PropertyFinancialsModule.tsx
//
// Property Financials destination (plan T5; Gabriel's ruling 2026-10-05: standalone destination,
// Assets group, own sticky in-module tab strip). Read-only view of the committed normalized dataset
// (cash basis) served by /api/warehouse/property-financials. This is a THIRD NOI basis, separate from
// Financials (warehouse) and Portfolio (Master Workbook); the masthead says so on every view.
//
// Views: Overview, Scorecard (T5), Levers, Watchlist, Evaluation (T6), Property explorer (T7). The
// explorer's selection lives in the URL (?view=explorer&p=<entity id>) so Overview / Scorecard /
// review-item links deep-link to a property and a refresh keeps it.
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components';
import { PF_ENTITY_IDS, type PfEntityId } from '@contracts/property-financials';
import { applyLiveSf } from '@analytics/property-financials/live-sf';
import { useTabParam } from '@/lib/useTabParam';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable } from '../intel/hooks';
import { EmptyState } from './components';
import { usePfDataset } from './hooks';
import { excludedNotes, fmtLongDate } from './model';
import { OverviewView } from './OverviewView';
import { ScorecardView } from './ScorecardView';
import { LeversView } from './LeversView';
import { WatchlistView } from './WatchlistView';
import { EvaluationView } from './EvaluationView';
import { ExplorerView } from './ExplorerView';
import { PF_PROPERTY_PARAM, PF_VIEWS, PF_VIEW_IDS, type PfViewId } from './views';
import { PfDataHealthSummary } from './DataHealthPanel';
import { freshnessAge } from './data-health';
import type { PfDatasetResponse } from './types';
import './pf.css';

const CLEAR_ON_VIEW_CHANGE: readonly string[] = [PF_PROPERTY_PARAM];

/** Bring the masthead back into view when the strip is stuck and the view changes (artifact parity). */
function scrollToTop(el: HTMLElement | null): void {
  if (el && typeof el.scrollIntoView === 'function' && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
}

function Masthead({ response }: { response: PfDatasetResponse | undefined }) {
  const d = response?.dataset;
  const meta = response?.meta;
  return (
    <header className="pf-mast">
      <div>
        <div className="pf-firm">Oxford Realty Advisors · Asset Management</div>
        <h1>Property Financials</h1>
      </div>
      {d && (
        <div className="pf-meta" data-testid="pf-meta">
          <span>Cash basis · data through {fmtLongDate(d.meta.as_of)}</span>
          {excludedNotes(d.meta.excluded).map((e) => (
            <span key={e} data-exclusion="">
              {e}
            </span>
          ))}
          <span className="pf-basis">Normalized NOI · not reconciled with Spine A/B</span>
          <span>Prepared {fmtLongDate(d.meta.generated)}</span>
          {meta?.staleness === 'stale' && (
            <span className="pf-stale" role="status">
              STALE · {freshnessAge(meta)}; not current
            </span>
          )}
          {response?.readError && (
            <span className="pf-stale" role="status">
              Showing the last good copy; the latest re-read failed ({response.readError}).
            </span>
          )}
        </div>
      )}
    </header>
  );
}

export function PropertyFinancialsModule() {
  const q = usePfDataset();
  const [view, setView] = useTabParam<PfViewId>(PF_VIEW_IDS, 'overview', 'view', CLEAR_ON_VIEW_CHANGE);
  const [params, setParams] = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const rawP = params.get(PF_PROPERTY_PARAM);
  const selected = useMemo(() => (rawP !== null && (PF_ENTITY_IDS as readonly string[]).includes(rawP) ? (rawP as PfEntityId) : null), [rawP]);

  const onSelect = (key: Key) => {
    setView(String(key) as PfViewId);
    scrollToTop(rootRef.current);
  };
  const openProperty = useCallback(
    (entity: PfEntityId) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('view', 'explorer');
          next.set(PF_PROPERTY_PARAM, entity);
          return next;
        },
        { replace: false },
      );
      scrollToTop(rootRef.current);
    },
    [setParams],
  );
  /** Card selection inside the explorer: rewrite ?p= in place (no history entry per click). */
  const selectProperty = useCallback(
    (entity: PfEntityId) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('view', 'explorer');
          next.set(PF_PROPERTY_PARAM, entity);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  let body: ReactNode;
  if (q.isPending) {
    body = (
      <div aria-busy="true" aria-label="Loading property financials" style={{ display: 'grid', gap: 12 }}>
        <Skeleton style={{ height: 28, width: '60%' }} />
        <Skeleton style={{ height: 90 }} />
        <Skeleton style={{ height: 260 }} />
      </div>
    );
  } else if (q.isError) {
    body = isWarehouseUnavailable(q.error) ? (
      <EmptyState title="Property Financials is local-only">
        <p>This view reads firm financials from the local Brain Server and is never published to the mirror. Start the Brain Server to see it.</p>
      </EmptyState>
    ) : (
      <EmptyState title="Property Financials could not load">
        <p>{q.error instanceof Error ? q.error.message : 'Unknown error.'}</p>
      </EmptyState>
    );
  } else if (!q.data.dataset) {
    const why = { missing: 'The dataset file is not on disk.', unreadable: 'The dataset file could not be read.', invalid: 'The dataset file failed validation.', ok: '' }[q.data.availability];
    body = (
      <EmptyState title="No property financials dataset">
        <p>{why}</p>
        {q.data.issues.length > 0 && (
          <ul className="pf-note">
            {q.data.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </EmptyState>
    );
  }

  // The ONE place live square footage enters the figures (T9b part 2): every view below divides by
  // the SF in this dataset; applyLiveSf swaps in Spine A values only when the block is present,
  // live and fresh, otherwise the dataset's static SF stands. Provenance is shown in data health.
  const d = useMemo(() => (q.data?.dataset ? applyLiveSf(q.data.dataset, q.data.liveSf ?? null) : null), [q.data]);
  return (
    <div className="pf-root" ref={rootRef}>
      <Masthead response={q.data} />
      {d ? (
        <Tabs selectedKey={view} onSelectionChange={onSelect} keyboardActivation="automatic">
          <TabList className="pf-tabs" aria-label="Property Financials views">
            {PF_VIEWS.map((v) => (
              <Tab key={v.id} id={v.id} className="pf-tab">
                {v.label}
              </Tab>
            ))}
          </TabList>
          {PF_VIEWS.map((v) => (
            <TabPanel key={v.id} id={v.id} className="pf-panel-body">
              {v.id === 'overview' ? (
                <OverviewView dataset={d} onOpenProperty={openProperty} />
              ) : v.id === 'scorecard' ? (
                <ScorecardView dataset={d} onOpenProperty={openProperty} />
              ) : v.id === 'levers' ? (
                <LeversView dataset={d} onOpenProperty={openProperty} />
              ) : v.id === 'watchlist' ? (
                <WatchlistView dataset={d} onOpenProperty={openProperty} />
              ) : v.id === 'evaluation' ? (
                <EvaluationView dataset={d} />
              ) : (
                <ExplorerView dataset={d} liveSf={q.data?.liveSf ?? null} selected={selected} onSelect={selectProperty} onOpenProperty={openProperty} />
              )}
            </TabPanel>
          ))}
        </Tabs>
      ) : (
        <div style={{ marginTop: 24 }}>{body}</div>
      )}
      {/* The artifact's seventh tab ("Command center data") lives in Data > Quality; this card links there. */}
      {d && q.data && <PfDataHealthSummary response={q.data} />}
    </div>
  );
}
