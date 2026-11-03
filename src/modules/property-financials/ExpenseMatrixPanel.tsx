// src/modules/property-financials/ExpenseMatrixPanel.tsx
//
// Property × expense-line $/SF matrix (roadmap 3.2) on the Expense watchlist. One full ledger year,
// entity 100% basis. Cells shade by portfolio quartile within their column (interim until the
// design-step-7 per-column thresholds are ratified) and print the quartile, so colour is never the
// only cue. "No postings" is shown as such — never as $0, never ranked.
import { useMemo } from 'react';
import type { PfDataset } from '@contracts/property-financials';
import { usd } from '@analytics/property-financials/format';
import { cardName } from './explorer-model';
import { MATRIX_LINES, MATRIX_LINE_LABEL, buildExpenseMatrix, latestFullYear, type MatrixCell, type Quartile } from './expense-matrix';

/** Amber wash per quartile: Q1 none … Q4 strongest. Higher $/SF than peers, not "bad" by itself. */
const SHADE: Readonly<Record<Exclude<Quartile, null>, number>> = { 1: 0, 2: 10, 3: 22, 4: 38 };

function Cell({ c }: { c: MatrixCell }) {
  if (c.perSf === null) {
    return (
      <td className="pf-mut" title="No postings on this line in the year">
        —
      </td>
    );
  }
  const shade = c.quartile ? SHADE[c.quartile] : 0;
  return (
    <td
      title={`${usd(c.usd ?? 0)} posted${c.quartile ? ` · quartile ${c.quartile} of 4 in this column` : ' · column too thin to rank'}`}
      style={shade ? { background: `color-mix(in oklab, var(--pf-warn) ${shade}%, transparent)` } : undefined}
    >
      ${c.perSf.toFixed(2)}
      {c.quartile && <small className="pf-mut"> Q{c.quartile}</small>}
    </td>
  );
}

export function ExpenseMatrixPanel({ dataset: d }: { dataset: PfDataset }) {
  const year = useMemo(() => latestFullYear(d), [d]);
  const m = useMemo(() => (year ? buildExpenseMatrix(d, year) : null), [d, year]);
  if (!m || m.rows.length === 0) return null;
  return (
    <section className="pf-sec" aria-labelledby="pf-matrix-h" style={{ marginTop: 28 }} data-testid="pf-expense-matrix">
      <h2 id="pf-matrix-h">Operating expense per SF by line, FY{m.year}</h2>
      <div className="pf-note" style={{ marginBottom: 8 }}>
        P&amp;L ledger, entity 100%, full-year postings ÷ square footage. Shading is the property&apos;s quartile within each column across the portfolio (Q4 = highest $/SF) — an
        interim view until per-line thresholds are ratified, not a target. &quot;—&quot; means no postings on that line, which is not the same as $0 of landlord cost.
      </div>
      <div className="pf-tbl">
        <table>
          <caption className="pf-mut" style={{ captionSide: 'bottom', textAlign: 'left' }}>
            $/SF per year; Q = portfolio quartile in the column.
          </caption>
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">SF</th>
              {MATRIX_LINES.map((l) => (
                <th scope="col" key={l} title={l}>
                  {MATRIX_LINE_LABEL[l]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.entity}>
                <th scope="row">{cardName(d.properties[r.entity].label)}</th>
                <td>{r.sf.toLocaleString('en-US')}</td>
                {MATRIX_LINES.map((l) => (
                  <Cell key={l} c={r.cells[l]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {m.excluded.length > 0 && (
        <p className="pf-note" data-testid="pf-matrix-excluded">
          Left out: {m.excluded.map((e) => `${cardName(d.properties[e.entity].label)} (${e.reason})`).join('; ')}.
        </p>
      )}
    </section>
  );
}
