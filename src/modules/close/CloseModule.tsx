import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { saveNoiBudget } from '@/data/actions';
import { fmtUsd, fmtUsdCompact, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { noiVariance, type NoiVarianceRow } from '@/brain/noi-variance';

export function CloseModule() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const qc = useQueryClient();
  const budgetMut = useMutation({
    mutationFn: (v: { propertyId: string; amount: number }) => saveNoiBudget(v.propertyId, v.amount),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });
  const v = useMemo(() => (data ? noiVariance(data.snapshot) : null), [data]);
  const [selected, setSelected] = useState<string | null>(null);
  if (gate) return gate;
  if (!data || !v) return null;
  const qb = data.snapshot.quickbooks;
  const sel = selected ? data.snapshot.quickbooks?.properties.find((p) => p.propertyId === selected) ?? null : null;
  const selRow = selected ? v.rows.find((r) => r.propertyId === selected) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {qb ? <Badge tone="green" dot>QuickBooks actuals · parsed {qb.parsedAt.slice(0, 10)}</Badge>
            : <Badge tone="amber" dot>No QuickBooks export — set QUICKBOOKS_CSV; budgets are editable now</Badge>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Actual NOI" value={qb && v.pairedCount > 0 ? v.totalActual : null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor="var(--color-pos)" sublabel={qb ? `${v.pairedCount} of ${v.actualCount} paired` : undefined} />
        <KpiStat label="Budget NOI" value={v.pairedCount > 0 ? v.totalBudget : null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor="var(--accent)" sublabel={qb ? `${v.pairedCount} of ${v.budgetedCount} paired` : undefined} />
        {/* No budget/actual pairs: a 0 variance is "nothing compared", not "on budget" — show — with a neutral accent. */}
        <KpiStat label="Portfolio Variance" value={qb && v.pairedCount > 0 ? v.totalVariance : null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor={v.pairedCount === 0 ? 'var(--text-tertiary)' : v.totalVariance < 0 ? 'var(--color-neg)' : 'var(--color-pos)'} sublabel={qb ? (v.pairedCount === 0 ? 'no budget/actual pairs' : `${v.belowBudgetCount} below budget · ${v.pairedCount} of ${v.rows.length} paired`) : undefined} />
        <KpiStat label="Expense Ratio" value={v.expenseRatio !== null ? v.expenseRatio : null} format={(n) => (n === null ? '—' : fmtPct(n))} accentColor="var(--color-warn)" sublabel="QB opex / income" />
      </div>

      <Card>
        <CardHeader title="Budget vs. Actual NOI" trailing={<Badge tone="gold">{v.rows.length} properties</Badge>} />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                {['Property', 'Annual NOI Budget', 'QB Actual NOI', 'Variance', '% Var', ''].map((h, i) => (
                  <th key={h} className="num px-3 py-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', textAlign: i === 0 || i === 5 ? 'left' : 'right', borderBottom: '1px solid var(--border-strong)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => (
                <BudgetRow key={r.propertyId} row={r} hasQb={!!qb} pending={budgetMut.isPending}
                  onSave={(amount) => budgetMut.mutate({ propertyId: r.propertyId, amount })}
                  onSelect={() => setSelected((id) => (id === r.propertyId ? null : r.propertyId))} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {sel && selRow && (
        <Card>
          <CardHeader title={`${selRow.name} — monthly`} trailing={<Badge tone="neutral">{sel.monthly.length} months</Badge>} />
          <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_320px]">
            <div>
              {sel.monthly.length > 0 ? (
                <BarChart data={sel.monthly.map((m) => ({ label: m.month.slice(5), value: m.noi }))} valueFormat={fmtUsdCompact} height={220} color="var(--color-pos)" />
              ) : <div className="py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>No monthly detail in the export.</div>}
            </div>
            <div>
              <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Expense by GL category</div>
              <div className="flex flex-col gap-1">
                {sel.glExpense.length === 0 ? <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>—</span> :
                  sel.glExpense.map((g) => (
                    <div key={g.account} className="flex items-center justify-between gap-3 py-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>{g.account}</span>
                      <span className="num text-xs" style={{ color: 'var(--text-primary)' }}>{fmtUsd(g.amount)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function BudgetRow({ row, hasQb, pending, onSave, onSelect }: { row: NoiVarianceRow; hasQb: boolean; pending: boolean; onSave: (amount: number) => void; onSelect: () => void }) {
  const [draft, setDraft] = useState(row.budget !== null ? String(row.budget) : '');
  return (
    <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <td className="px-3 py-2">
        <button onClick={onSelect} className="text-left text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{row.name}</button>
      </td>
      <td className="px-3 py-2 text-right">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
          onBlur={() => { const n = Number(draft); if (draft !== '' && Number.isFinite(n) && n !== row.budget) onSave(n); }}
          inputMode="numeric"
          aria-label={`Annual NOI budget for ${row.name}`}
          placeholder="—"
          disabled={pending}
          className="num h-7 w-28 rounded-[var(--radius-sm)] px-2 text-right text-xs outline-none"
          style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
      </td>
      <td className="num px-3 py-2 text-right text-xs" style={{ color: 'var(--text-primary)' }}>{row.actual !== null ? fmtUsd(row.actual) : (hasQb ? '—' : '·')}</td>
      <td className="num px-3 py-2 text-right text-xs" style={{ color: row.variance !== null ? (row.variance < 0 ? 'var(--text-neg)' : 'var(--text-pos)') : 'var(--text-tertiary)' }}>{row.variance !== null ? fmtUsd(row.variance) : '—'}</td>
      <td className="num px-3 py-2 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>{row.variancePct !== null ? fmtPct(row.variancePct) : '—'}</td>
      <td className="px-3 py-2 text-right">{row.belowBudget && <Badge tone="red">under</Badge>}</td>
    </tr>
  );
}
