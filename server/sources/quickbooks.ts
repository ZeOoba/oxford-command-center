import { existsSync, readFileSync } from 'node:fs';
import type { Property } from '../../src/contracts/index';
import { QbActuals, type QbProperty } from '../../src/contracts/quickbooks';

/** Parse one CSV line honoring double-quoted fields (handles embedded commas + "" escapes). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Tolerant number parse: strips $ , and treats (123) as -123. */
function parseAmount(raw: string): number {
  const neg = /^\(.*\)$/.test(raw.trim());
  const n = Number(raw.replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

const findCol = (headers: string[], re: RegExp): number => headers.findIndex((h) => re.test(h));

/**
 * Parse a QuickBooks "P&L by property" long-format CSV into per-property actuals. Header-driven and
 * tolerant; infers income/expense from the account name when no Type column exists. Pure — `now`
 * and `properties` are injected. Returns null when no recognizable header/rows are found.
 */
export function parseQuickbooksCsv(text: string, properties: Property[], now: string): QbActuals | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = parseCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const cProp = findCol(headers, /property|class|customer/);
  const cAmt = findCol(headers, /amount|total/);
  const cAcct = findCol(headers, /account|gl|category/);
  const cMonth = findCol(headers, /month|period|date/);
  const cType = findCol(headers, /type|income|expense/);
  if (cProp < 0 || cAmt < 0) return null;

  interface Acc { key: string; income: number; expense: number; monthly: Map<string, { income: number; expense: number }>; gl: Map<string, number>; }
  const byProp = new Map<string, Acc>();

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const key = cells[cProp]?.trim();
    if (!key) continue;
    const amount = parseAmount(cells[cAmt] ?? '0');
    const account = cAcct >= 0 ? (cells[cAcct] ?? '') : '';
    const month = cMonth >= 0 ? (cells[cMonth] ?? '').slice(0, 7) : '';
    const typeRaw = cType >= 0 ? (cells[cType] ?? '').toLowerCase() : '';
    const isIncome = typeRaw ? /income|revenue/.test(typeRaw) : /income|revenue|rent/i.test(account);

    const acc = byProp.get(key) ?? { key, income: 0, expense: 0, monthly: new Map(), gl: new Map() };
    if (isIncome) acc.income += amount;
    else { acc.expense += amount; if (account) acc.gl.set(account, (acc.gl.get(account) ?? 0) + amount); }
    if (month) {
      const m = acc.monthly.get(month) ?? { income: 0, expense: 0 };
      if (isIncome) m.income += amount; else m.expense += amount;
      acc.monthly.set(month, m);
    }
    byProp.set(key, acc);
  }

  if (byProp.size === 0) return null;

  const resolveId = (key: string): string | null => {
    const k = key.toLowerCase();
    const hit = properties.find((p) => p.name.toLowerCase().includes(k) || k.includes(p.name.toLowerCase()));
    return hit ? hit.id : null;
  };

  const out: QbProperty[] = [...byProp.values()].map((a) => ({
    propertyKey: a.key,
    propertyId: resolveId(a.key),
    annualIncome: a.income,
    annualExpense: a.expense,
    annualNoi: a.income - a.expense,
    monthly: [...a.monthly.entries()]
      .sort((x, y) => x[0].localeCompare(y[0]))
      .map(([month, v]) => ({ month, income: v.income, expense: v.expense, noi: v.income - v.expense })),
    glExpense: [...a.gl.entries()].map(([account, amount]) => ({ account, amount })).sort((x, y) => y.amount - x.amount),
  }));

  return { sourceFile: null, parsedAt: now, properties: out };
}

/** Read QUICKBOOKS_CSV (if set + present) and parse it. Graceful null otherwise. */
export function loadQuickbooks(properties: Property[], now: string = new Date().toISOString()): QbActuals | null {
  const path = process.env.QUICKBOOKS_CSV;
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = parseQuickbooksCsv(readFileSync(path, 'utf8'), properties, now);
    return parsed ? QbActuals.parse({ ...parsed, sourceFile: path }) : null;
  } catch {
    return null;
  }
}
