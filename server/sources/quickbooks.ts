import { existsSync, readFileSync } from 'node:fs';
import type { Property } from '../../src/contracts/index';
import { QbActuals, type QbProperty } from '../../src/contracts/quickbooks';
import { resolvePropertyId } from '../workbook/parse';

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

  const out: QbProperty[] = [...byProp.values()].map((a) => ({
    propertyKey: a.key,
    // Route through the same whole-token + number-gate + alias-table resolver rent-roll/lease
    // parsing already uses (server/workbook/parse.ts's resolvePropertyId), not a bidirectional
    // raw-substring/first-match check. The old inline resolveId() was the exact failure shape
    // fa27d4c/ead629d/1c7d17b fixed elsewhere this week (2026-08-24 integrity sweep, Finding 3).
    //
    // CORRECTED 2026-08-24 (PR #302 review, initially a false-positive fix): routing through
    // resolvePropertyId alone did NOT recover the Sepich/FVC NOI this comment originally
    // claimed -- the alias table had no entry matching the QB export's actual class-key string, and
    // the token/number-gate path independently fails on this key (see RENT_ROLL_PROPERTY_ALIASES'
    // own comment in parse.ts). The FVC/Sepich key is now explicitly aliased and verified against
    // the live QUICKBOOKS_CSV export to resolve correctly. The '1851 S Club Solar' NOI
    // remains propertyId:null -- verified DELIBERATE, not a residual bug: no property_master row
    // exists for that entity (see the alias table's comment). This routing change is still correct
    // and load-bearing (the alias table is now the actual source of truth for these two QB class
    // keys), it just does not by itself explain the recovery -- the alias entries do.
    propertyId: resolvePropertyId(a.key, properties),
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

export interface ResolvedQuickbooks {
  quickbooks: QbActuals | null;
  /** Non-null iff `quickbooks` came from carrying the previous snapshot forward rather than a
   *  fresh CSV parse -- set to the snapshot path it was read from, for logging. */
  preservedFrom: string | null;
}

/**
 * 2026-08-17 fix: `quickbooks` is SERVER-ATTACHED (loadQuickbooks() was called only from
 * server/brain.ts) while both CLI writers (scripts/extract-workbook.ts and
 * scripts/lease-snapshot-drift-check.ts) build their output via applyOverlay(snapshot, overlay)
 * alone, with no attach step at all. Because src/contracts/index.ts declares
 * `quickbooks: QbActuals.nullable().default(null)`, that meant every committed CLI-driven refresh
 * legitimately zod-defaulted the section to null and DELETED whatever the server path had
 * written -- on 2026-08-17 that silently destroyed 8 populated per-property P&L rows (828 deleted
 * lines in one commit), and the section-shrink guard in ora-cc-snapshot-refresh's SKILL.md could
 * not see it: that guard only counts leases/deals/counterparties/properties/loans.
 *
 * This is the single point both CLI writers now call instead of leaving `quickbooks` unset (which
 * zod would default to null): try a fresh parse first (CSV takes priority when it's actually
 * readable -- fresher data should win), and if that comes back null AND the previous on-disk
 * snapshot carries a populated, schema-valid quickbooks block, carry that block forward rather
 * than destroying it. `parsedAt` is preserved as-is (not restamped to `now`) so the carried block
 * self-documents its own staleness for the next reader -- never silently posing as fresh.
 *
 * A quickbooks block with an empty `properties` array is NOT preserved: an empty block is
 * indistinguishable from "nothing to lose" and preserving a husk would just perpetuate a prior
 * failed parse forever instead of surfacing it. Any read failure (missing file, corrupt JSON,
 * schema mismatch) degrades to null exactly like loadQuickbooks()'s own catch-all -- this must
 * never THROW and abort an unattended scheduled run over a stale/corrupt previous snapshot.
 */
export function resolveQuickbooks(properties: Property[], snapshotPath: string, now: string = new Date().toISOString()): ResolvedQuickbooks {
  const fresh = loadQuickbooks(properties, now);
  if (fresh) return { quickbooks: fresh, preservedFrom: null };

  try {
    if (!existsSync(snapshotPath)) return { quickbooks: null, preservedFrom: null };
    const parsed: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const candidate = (parsed as { quickbooks?: unknown } | null)?.quickbooks;
    if (!candidate) return { quickbooks: null, preservedFrom: null };
    const result = QbActuals.safeParse(candidate);
    if (!result.success || result.data.properties.length === 0) return { quickbooks: null, preservedFrom: null };
    return { quickbooks: result.data, preservedFrom: snapshotPath };
  } catch {
    return { quickbooks: null, preservedFrom: null };
  }
}
