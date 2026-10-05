// src/modules/property-financials/EvaluationView.tsx
//
// Evaluation scorecard tab (reference artifact "EVALUATE"): eight tests x every PM asset. Status comes
// ONLY from ragStatus over one THRESHOLDS config (src/analytics/property-financials/thresholds.ts),
// and the definitions table is generated from the same config (thresholdText / thresholdDefinition),
// so a threshold edit moves the cells and their description together. `thresholds` is a prop only so
// tests can render a mutated clone; the module always passes the shipped config.
//
// A RAG cell is never colour-only: icon shape (green circle, amber diamond, red triangle, n/m hollow
// circle) + the value text + a visually hidden status word; n/m carries its reason as a tooltip.
import { useMemo } from 'react';
import type { PfDataset } from '@contracts/property-financials';
import { NM } from '@analytics/property-financials/format';
import {
  EVALUATION_TEST_IDS,
  RAG_LABEL,
  THRESHOLDS,
  formatThresholdValue,
  thresholdDefinition,
  thresholdText,
  type EvaluationTestId,
  type EvaluationThreshold,
  type RagStatus,
} from '@analytics/property-financials/thresholds';
import { countWord, evaluationMatrix, leaseUpLabels, type EvaluationCell } from './model';

const RAG_ICON: Readonly<Record<RagStatus, string>> = { g: 'circle', a: 'diamond', r: 'triangle', n: 'hollow circle' };

function joinAnd(xs: readonly string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

export function RagCell({ cell, threshold }: { cell: EvaluationCell; threshold: EvaluationThreshold }) {
  const { status, result } = cell;
  if (result.value === null) {
    return (
      <span className="pf-rag n" data-status="n" data-icon={RAG_ICON.n} title={result.reason} data-reason={result.reason} tabIndex={0}>
        {NM}
        <span className="sr-only">
          {' '}
          {threshold.label}: not meaningful, {result.reason}
        </span>
      </span>
    );
  }
  return (
    <span className="pf-rag" data-status={status} data-icon={RAG_ICON[status]} title={`${threshold.label}: ${RAG_LABEL[status]}`}>
      {formatThresholdValue(threshold, result.value)}
      <span className="sr-only"> {RAG_LABEL[status]}</span>
    </span>
  );
}

const MONTHLY_RHYTHM = [
  `Re-run the ${countWord(EVALUATION_TEST_IDS.length)} tests and diff against last month.`,
  'Any account above $2,500 and 25% over prior-year same month gets a one-line explanation from the manager.',
  'Confirm every scheduled rent step billed on the correct date.',
  'Match utility reimbursements to utility cost by building.',
];
const PERIODIC_RHYTHM = [
  'Quarterly: rent run-rate, contra-revenue and vacancy review with leasing.',
  'Before each county deadline: tax bill versus appeal outcome by property.',
  '90 days before renewals: rebid insurance, snow, landscaping, trash and management.',
  'Year-end: CAM, tax and insurance reconciliations for every NNN lease.',
];

export function EvaluationView({
  dataset: d,
  thresholds = THRESHOLDS,
}: {
  dataset: PfDataset;
  thresholds?: Readonly<Record<EvaluationTestId, EvaluationThreshold>>;
}) {
  const rows = useMemo(() => evaluationMatrix(d, thresholds), [d, thresholds]);
  const tests = EVALUATION_TEST_IDS.map((id) => thresholds[id]);
  const n = countWord(EVALUATION_TEST_IDS.length);
  return (
    <div>
      <h2>Evaluation scorecard</h2>
      <p className="pf-lede pf-lede-sm">
        {n[0]!.toUpperCase() + n.slice(1)} tests to run on every property each month. Status is computed from trailing-twelve-month data using the thresholds below.
        Change a threshold in the source file and the status moves.
      </p>
      <p className="pf-note" style={{ marginBottom: 10 }}>
        Ratios are computed from unrounded figures, so a value within rounding of a threshold can read differently from a 2-decimal summary; a value that would round onto a
        threshold it sits on the other side of prints with an extra digit. Focus or hover an n/m cell for the reason.
      </p>
      <div className="pf-tbl pf-eval" data-testid="pf-eval">
        <table>
          <thead>
            <tr>
              <th scope="col">Property</th>
              {tests.map((t) => (
                <th scope="col" key={t.id}>
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.label}</th>
                {tests.map((t) => (
                  <td key={t.id}>
                    <RagCell cell={r.cells[t.id]} threshold={t} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pf-note">
        Properties in lease-up ({joinAnd(leaseUpLabels(d))}) are measured on a short history and are best read against their own pro forma. Recovery ratio is not
        meaningful for single-tenant NNN assets that pay taxes and insurance directly.
      </p>
      <p className="pf-note pf-rag-key" aria-hidden>
        <span className="pf-rag" data-status="g">
          Green
        </span>
        <span className="pf-rag" data-status="a">
          Amber
        </span>
        <span className="pf-rag" data-status="r">
          Red
        </span>
        <span className="pf-rag n" data-status="n">
          n/m
        </span>
      </p>

      <section className="pf-sec" aria-labelledby="pf-eval-defs-h" style={{ marginTop: 28 }}>
        <h2 id="pf-eval-defs-h">Definitions and thresholds</h2>
        <div className="pf-tbl" data-testid="pf-eval-defs">
          <table>
            <thead>
              <tr>
                <th scope="col">Test</th>
                <th scope="col">Definition</th>
                <th scope="col">Thresholds</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td className="pf-wrap">{thresholdDefinition(t)}</td>
                  <td className="pf-wrap">{thresholdText(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="pf-note">
          Thresholds are starting points set from this portfolio&rsquo;s own spread, not market benchmarks. Revisit them once the Master Workbook supplies square footage
          and lease data.
        </p>
      </section>

      <section className="pf-sec" aria-labelledby="pf-rhythm-h">
        <h2 id="pf-rhythm-h">Review rhythm</h2>
        <div className="pf-two">
          <div>
            <h3 className="pf-h4">Monthly, after the PM close</h3>
            <ul className="pf-dq">
              {MONTHLY_RHYTHM.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="pf-h4">Quarterly and annually</h3>
            <ul className="pf-dq">
              {PERIODIC_RHYTHM.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
