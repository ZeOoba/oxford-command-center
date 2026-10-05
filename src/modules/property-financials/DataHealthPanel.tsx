// src/modules/property-financials/DataHealthPanel.tsx
//
// Property Financials data health (plan T8): the reference artifact's static "Command center data"
// tab made live. Two surfaces:
//   PfDataHealthPanel   — the full panel, a `?view=` of the Data destination's Quality tab
//                         (/data?tab=quality&view=property-financials; the strip is at its 5-tab cap)
//   PfDataHealthSummary — a compact card at the foot of the Property Financials module, linking there
// Everything shown is read from GET /dataset (dataset meta + data_quality + leases, server sha256 /
// staleness) and GET /mapping (entity → canonical id, inferred / unmatched / SF-mismatch flags). When
// either read fails the panel says so and shows no figures — never a placeholder.
//
// Northwood is excluded from the dataset: it appears only inside elements marked data-exclusion
// (the meta.excluded note and the data_quality item that records the exclusion).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Printer } from 'lucide-react';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable } from '../intel/hooks';
import { PF_DATA_HEALTH_HREF } from '../data/tabs';
import { EmptyState } from './components';
import { NOI_DISCLOSURE, mentionsExcluded, shortSha, unattachedLeaseGaps } from './data-health';
import { usePfDataset, usePfMapping } from './hooks';
import { excludedNotes, fmtLongDate } from './model';
import type { PfDataHealthMeta, PfDatasetResponse, PfMappingResponse, PfMappingRow } from './types';
import './pf.css';

const AVAILABILITY_WHY = {
  missing: 'The dataset file is not on disk.',
  unreadable: 'The dataset file could not be read.',
  invalid: 'The dataset file failed validation.',
  ok: '',
} as const;

/** Fresh / stale per the server's `staleness`: always an icon AND a label, never colour alone. */
export function PfFreshness({ meta }: { meta: PfDataHealthMeta }) {
  const age = `${meta.ageDays} day${meta.ageDays === 1 ? '' : 's'} since ${fmtLongDate(meta.as_of)}`;
  if (meta.staleness === 'stale') {
    return (
      <span className="pf-fresh pf-fresh-stale" role="status" data-testid="pf-dh-freshness">
        <AlertTriangle size={14} aria-hidden="true" />
        <b>Stale</b> · {age}; not current
      </span>
    );
  }
  return (
    <span className="pf-fresh" data-testid="pf-dh-freshness">
      <CheckCircle2 size={14} aria-hidden="true" />
      <b>Fresh</b> · {age}
    </span>
  );
}

function Sha({ value }: { value: string }) {
  return (
    <code className="pf-sha" title={value}>
      {shortSha(value)}
    </code>
  );
}

function Facts({ response, meta }: { response: PfDatasetResponse; meta: PfDataHealthMeta }) {
  const rows: Array<[string, ReactNode]> = [
    ['Dataset version', meta.version],
    ['Generated', fmtLongDate(meta.generated)],
    ['Data as of', fmtLongDate(meta.as_of)],
    ['Basis', `${meta.basis} basis`],
    ['Source freshness', <PfFreshness key="f" meta={meta} />],
    ['dataset.json sha256', <Sha key="s" value={meta.sha256} />],
    ['monthly-long.csv sha256', meta.csvSha256 ? <Sha key="c" value={meta.csvSha256} /> : <span className="pf-neg">{meta.csvError ?? 'not available'}</span>],
  ];
  if (response.lastGoodLoadedAt) rows.push(['Loaded by the server', response.lastGoodLoadedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')]);
  return (
    <dl className="pf-dh-facts" data-testid="pf-dh-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function MatchCell({ row }: { row: PfMappingRow }) {
  if (row.method === 'inferred') {
    return (
      <span className="pf-dh-tag pf-dh-tag-warn">
        <AlertTriangle size={12} aria-hidden="true" /> [INFERRED] Confirm me
      </span>
    );
  }
  if (row.method === 'unmatched') {
    return (
      <span className="pf-dh-tag pf-dh-tag-crit">
        <AlertTriangle size={12} aria-hidden="true" /> Unmatched
      </span>
    );
  }
  return <span className="pf-dh-tag">Exact (address)</span>;
}

function MappingTable({ mapping }: { mapping: PfMappingResponse }) {
  return (
    <div className="pf-tbl pf-dh-print">
      <table aria-label="Entity to canonical property id mapping">
        <thead>
          <tr>
            <th scope="col">Dataset entity</th>
            <th scope="col">Canonical property id</th>
            <th scope="col">Match</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {mapping.rows.map((r) => (
            <tr key={r.entity} data-testid="pf-map-row" data-entity={r.entity} data-method={r.method}>
              <td>{r.entity}</td>
              <td className="pf-wrap">{r.canonicalId ? <code>{r.canonicalId}</code> : <span className="pf-neg">none</span>}</td>
              <td>
                <MatchCell row={r} />
              </td>
              <td className="pf-wrap pf-dh-flags">
                {r.flags.length === 0 ? (
                  <span className="pf-mut">—</span>
                ) : (
                  <ul>
                    {r.flags.map((f) =>
                      f.code === 'SF_MISMATCH' ? (
                        <li key={f.code} data-testid="pf-map-sf-flag">
                          <b>SF differs:</b> {f.detail}. Shown, not corrected.
                        </li>
                      ) : f.code === 'UNMATCHED' ? (
                        <li key={f.code}>
                          <b>Unmatched:</b> {f.detail}
                        </li>
                      ) : (
                        <li key={f.code}>
                          <b>Mapping inferred:</b> {f.detail}
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MappingSection({ datasetOk }: { datasetOk: boolean }) {
  const q = usePfMapping();
  let body: ReactNode;
  if (q.isPending) body = <Skeleton style={{ height: 160 }} />;
  else if (q.isError) {
    body = (
      <p className="pf-flag" role="alert" data-testid="pf-dh-mapping-error">
        The mapping table could not be read: {isWarehouseUnavailable(q.error) ? 'the Brain Server is not reachable.' : q.error instanceof Error ? q.error.message : 'unknown error.'}
      </p>
    );
  } else {
    body = (
      <>
        {(q.data.availability !== 'ok' || !datasetOk) && (
          <p className="pf-note pf-gap">The dataset is not available, so square-footage disagreements cannot be computed; ids below are the ratified table only.</p>
        )}
        <MappingTable mapping={q.data} />
      </>
    );
  }
  return (
    <section className="pf-sec pf-dh-print" aria-labelledby="pf-dh-map-h">
      <div className="pf-dh-head">
        <h2 id="pf-dh-map-h">Entity → canonical property id</h2>
        <button type="button" className="pf-btn ghost pf-dh-noprint" onClick={() => window.print()}>
          <Printer size={13} aria-hidden="true" /> Print mapping table
        </button>
      </div>
      <p className="pf-note">
        The dataset names its 11 entities by short labels; the firm’s canonical ids come from the property master. Inferred rows need the owner’s confirmation. Square-footage differences are
        flagged, never written back to either side.
      </p>
      {body}
    </section>
  );
}

export function PfDataHealthPanel() {
  const q = usePfDataset();
  let body: ReactNode;
  if (q.isPending) {
    body = <Skeleton style={{ height: 240 }} />;
  } else if (q.isError) {
    body = isWarehouseUnavailable(q.error) ? (
      <EmptyState title="Data health is local-only">
        <p>The Brain Server is not reachable. Property Financials data health reads the local dataset and is never published to the mirror.</p>
      </EmptyState>
    ) : (
      <EmptyState title="Data health could not load">
        <p>{q.error instanceof Error ? q.error.message : 'Unknown error.'}</p>
      </EmptyState>
    );
  } else if (!q.data.dataset || !q.data.meta) {
    body = (
      <>
        <EmptyState title="No property financials dataset">
          <p>{AVAILABILITY_WHY[q.data.availability] || 'The dataset is not available.'}</p>
          {q.data.issues.length > 0 && (
            <ul className="pf-note">
              {q.data.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </EmptyState>
        <MappingSection datasetOk={false} />
      </>
    );
  } else {
    const d = q.data.dataset;
    const excluded = d.meta.excluded;
    const unattached = unattachedLeaseGaps(d);
    body = (
      <>
        <p className="pf-basis pf-dh-noi" data-testid="pf-dh-noi">
          {NOI_DISCLOSURE}
        </p>
        {q.data.readError && (
          <p className="pf-flag" role="status">
            Showing the last good copy; the latest re-read failed ({q.data.readError}).
          </p>
        )}
        <section className="pf-sec" aria-labelledby="pf-dh-src-h">
          <h2 id="pf-dh-src-h">Source</h2>
          <Facts response={q.data} meta={q.data.meta} />
          {excluded.length > 0 && (
            <ul className="pf-note pf-gap" data-testid="pf-dh-excluded">
              {excludedNotes(excluded).map((e) => (
                <li key={e} data-exclusion="">
                  {e}. Not in any figure, mapping row or property view.
                </li>
              ))}
            </ul>
          )}
        </section>
        <MappingSection datasetOk />
        <section className="pf-sec" aria-labelledby="pf-dh-dq-h">
          <h2 id="pf-dh-dq-h">Data quality and gaps</h2>
          <ul className="pf-dh-dq" data-testid="pf-dh-quality">
            {d.data_quality.map((x) => (
              <li key={x} {...(mentionsExcluded(x, excluded) ? { 'data-exclusion': '' } : {})}>
                {x}
              </li>
            ))}
          </ul>
        </section>
        {unattached.length > 0 && (
          <section className="pf-sec" aria-labelledby="pf-dh-ul-h" data-testid="pf-dh-unattached">
            <h2 id="pf-dh-ul-h">Leases with no P&amp;L entity</h2>
            <ul className="pf-dh-dq">
              {unattached.map((u) => (
                <li key={u.property + u.tenant}>
                  <b>{u.property}</b>: {u.text}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }
  return (
    <div className="pf-root pf-dh">
      <header className="pf-dh-mast">
        <h1>Property Financials data health</h1>
        <p className="pf-note">Live read of the committed normalized dataset served by the local Brain Server.</p>
      </header>
      {body}
    </div>
  );
}

/** Compact card at the foot of the Property Financials module (the module's seventh view lives in Data). */
export function PfDataHealthSummary({ response }: { response: PfDatasetResponse }) {
  const mapping = usePfMapping();
  const d = response.dataset;
  const meta = response.meta;
  if (!d || !meta) return null;
  const rows = mapping.data?.rows ?? null;
  const inferred = rows?.filter((r) => r.method === 'inferred').length ?? 0;
  const unmatched = rows?.filter((r) => r.method === 'unmatched').length ?? 0;
  const sfFlags = rows?.reduce((n, r) => n + r.flags.filter((f) => f.code === 'SF_MISMATCH').length, 0) ?? 0;
  return (
    <aside className="pf-dh-summary" data-testid="pf-dh-summary" aria-label="Data health summary">
      <div>
        <h2>Data health</h2>
        <p className="pf-note">
          Dataset {meta.version} · as of {fmtLongDate(meta.as_of)} · <PfFreshness meta={meta} />
        </p>
        <p className="pf-note">
          {d.data_quality.length} data-quality notes
          {rows
            ? ` · ${rows.length} entities mapped · ${inferred} inferred · ${sfFlags} SF flags${unmatched ? ` · ${unmatched} unmatched` : ''}`
            : mapping.isError
              ? ' · mapping table unavailable'
              : ''}
        </p>
      </div>
      <Link className="pf-btn" to={PF_DATA_HEALTH_HREF}>
        Open data health
      </Link>
    </aside>
  );
}
