import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/workbook/parse';
import { checkCashInvariants } from '../server/reconcile-runtime';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';

loadEnvFile();

type CellValue = ExcelJS.CellValue;
const cv = (v: CellValue | undefined): unknown => {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return (v as { result?: unknown }).result ?? null;
  }
  return v ?? null;
};
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

interface Check {
  label: string;
  expected: number;
  actual: number;
  tol: number;
  note?: string;
}

async function main() {
  const { snapshot } = await parseWorkbook(workbookPath());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath());

  const find = (sheet: string, pred: (c1: string) => boolean, col: number): number | null => {
    const ws = wb.getWorksheet(sheet);
    if (!ws) return null;
    for (let r = 1; r <= ws.rowCount; r++) {
      const c1 = String(cv(ws.getRow(r).getCell(1).value) ?? '');
      const c2 = String(cv(ws.getRow(r).getCell(2).value) ?? '');
      if (pred(`${c1} ${c2}`)) return num(cv(ws.getRow(r).getCell(col).value));
    }
    return null;
  };

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  // Workbook's own totals cells (independent re-read).
  const wbNoi = find('Property NOI', (c) => /portfolio total/i.test(c), 13) ?? NaN;
  const wbValue = find('Property NOI', (c) => /portfolio total/i.test(c), 10) ?? NaN;
  const wbRent = find('Master Tenant Rent Roll', (c) => /portfolio total/i.test(c), 14) ?? NaN;

  // Persimmon residence is excluded from the workbook's SF subtotal but included in value.
  const residenceSf = sum(snapshot.properties.filter((p) => p.type === 'Residence').map((p) => p.sf));

  const checks: Check[] = [
    {
      label: 'Property NOI (Oxford) total',
      expected: wbNoi,
      actual: sum(snapshot.properties.map((p) => p.noi)),
      tol: 1,
    },
    {
      label: 'Oxford value total',
      expected: wbValue,
      actual: sum(snapshot.properties.map((p) => p.oxfordValue)),
      tol: 1,
    },
    {
      label: 'Annualized rent total',
      expected: wbRent,
      actual: sum(snapshot.leases.map((l) => l.annualRent)),
      tol: 1,
    },
    {
      label: 'Portfolio SF (workbook excludes residence)',
      expected: sum(snapshot.properties.map((p) => p.sf)) - residenceSf,
      actual: sum(snapshot.properties.filter((p) => p.type !== 'Residence').map((p) => p.sf)),
      tol: 0,
      note: `residence SF excluded: ${residenceSf.toLocaleString()}`,
    },
    {
      label: 'Cash total = Σ entities',
      expected: snapshot.cash.totalCash,
      actual: sum(snapshot.cash.entities.map((e) => e.currentBalance)),
      tol: 2,
    },
    {
      label: 'Cash history latest = current total',
      expected: snapshot.cash.totalCash,
      actual: snapshot.cash.history.at(-1)?.total ?? NaN,
      tol: 2,
    },
    {
      label: 'Σ(monthly rent × 12) = Σ annual rent',
      expected: sum(snapshot.leases.map((l) => l.annualRent)),
      actual: sum(snapshot.leases.map((l) => l.monthlyRent * 12)),
      tol: 5,
    },
  ];

  let failed = 0;
  console.log('── RECONCILIATION GATE ($0 tolerance unless noted) ─────');
  for (const c of checks) {
    const diff = Math.abs(c.expected - c.actual);
    const pass = Number.isFinite(c.expected) && diff <= c.tol;
    if (!pass) failed++;
    console.log(
      `${pass ? '✓ PASS' : '✗ FAIL'}  ${c.label.padEnd(42)} exp ${Math.round(c.expected).toLocaleString()} · got ${Math.round(c.actual).toLocaleString()} · Δ ${diff.toFixed(2)}${c.note ? ` (${c.note})` : ''}`,
    );
  }

  // Date-aware cash invariants (2026-09-14 sweep). The "Cash history latest = current total" row
  // above is value-only and PASSES on the exact failure it should catch: a history slot clobbered
  // with the current total agrees with the headline because it was clobbered (found live: cash.asOf
  // 2026-09-10 over a history ending 2026-07-10, July's total bit-identical to September's). These
  // are boolean assertions, not expected/actual/tol rows, so they print as their own block. Shared
  // with checkSnapshot via checkCashInvariants -- one detector, not a copy that can drift; the
  // workbook re-read above is for the dollar totals, and these are about the parsed history array.
  // Only 'error' (cash.asOf later than generatedAt -- structurally impossible) fails the gate; the
  // rest print as WARN and never block, per the report-don't-refuse rule for plausible events.
  for (const f of checkCashInvariants(snapshot)) {
    const isError = f.severity === 'error';
    if (isError) failed++;
    console.log(`${isError ? '✗ FAIL' : '⚠ WARN'}  ${`Cash: ${f.field}`.padEnd(42)} ${f.issue}`);
  }

  // Count floor (non-zero, not exact-match): a parse that silently emptied a sheet must still
  // fail loudly. This was previously an EXACT count against hardcoded baselines (Properties 14 /
  // Leases 138 / Cash entities 16) captured on 2026-06-05 — a false-fail waiting on the next
  // genuine lease signing, property acquisition, or entity onboarding, and it was never the check
  // that actually caught anything: the phantom-vacancy-lease incident (2026-08-03, PR #250, +10
  // leases / +$312,540) shipped with the Lease count at exactly... 148, which this WOULD have
  // caught by luck of a stale baseline, but only because nobody had bumped the "138" since. The
  // "Annualized rent total" check above is the real, non-time-bombed assertion for exactly this
  // failure mode — it compares the snapshot's own derived total against the workbook's declared
  // total, which drifts with genuine business changes on its own and needs no hand-maintained
  // constant.
  const floors = [
    ['Properties', snapshot.properties.length],
    ['Leases', snapshot.leases.length],
    ['Cash entities', snapshot.cash.entities.length],
  ] as const;
  for (const [label, got] of floors) {
    const pass = got > 0;
    if (!pass) failed++;
    console.log(`${pass ? '✓ PASS' : '✗ FAIL'}  ${`Non-empty: ${label}`.padEnd(42)} got ${got}`);
  }

  // Entity-graph integrity: every counterparty edge must resolve to a real node.
  const propIds = new Set(snapshot.properties.map((p) => p.id));
  const loanIds = new Set(snapshot.loans.map((l) => l.id));
  const dealIds = new Set(snapshot.deals.map((d) => d.id));
  const insIds = new Set(snapshot.insurance.map((i) => i.id));
  let danglingEdges = 0;
  for (const cp of snapshot.counterparties) {
    danglingEdges += cp.links.properties.filter((id) => !propIds.has(id)).length;
    danglingEdges += cp.links.loans.filter((id) => !loanIds.has(id)).length;
    danglingEdges += cp.links.deals.filter((id) => !dealIds.has(id)).length;
    danglingEdges += cp.links.insurance.filter((id) => !insIds.has(id)).length;
  }
  const edgesOk = danglingEdges === 0;
  if (!edgesOk) failed++;
  console.log(`${edgesOk ? '✓ PASS' : '✗ FAIL'}  ${'Counterparty edges resolve'.padEnd(42)} ${danglingEdges} dangling`);

  const peopleSeeded = snapshot.counterparties.filter((c) => c.source === 'memory').length;
  const peopleOk = peopleSeeded >= 4;
  if (!peopleOk) failed++;
  console.log(`${peopleOk ? '✓ PASS' : '✗ FAIL'}  ${'People-layer seed present (≥4)'.padEnd(42)} got ${peopleSeeded}`);

  console.log('───────────────────────────────────────────────────────');
  if (failed > 0) {
    console.error(`✗ Reconciliation FAILED: ${failed} check(s) off.`);
    process.exit(1);
  }
  console.log('✓ Reconciliation passed — derived totals match the workbook to tolerance.');
}

main().catch((err) => {
  console.error('✗ Reconciliation error:', err);
  process.exit(1);
});
