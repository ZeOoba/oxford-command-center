# Command Center Phase 3 (②) — NOI Variance + QuickBooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** A `/close` module showing **budget-vs-actual NOI** per property — budgets entered in-app (overlay), actuals parsed from a **QuickBooks Desktop → SharePoint CSV export** by a defensive, header-driven parser that no-ops gracefully when the file is absent. KPI strip + property table (editable budget) + per-property drawer (monthly budget-vs-actual chart + GL expense breakdown).

**Architecture:** Same overlay pattern proven 3× this phase. **(1)** `noiBudgets: Record<propertyId, number>` overlay key → snapshot field → `POST /api/actions/noi-budget`. **(2)** `server/sources/quickbooks.ts` — a pure, fixture-tested CSV parser (`parseQuickbooksCsv`) + a graceful `loadQuickbooks()` reading `QUICKBOOKS_CSV` env; attached to the snapshot as `quickbooks: QbActuals | null` in `brain.refresh` (the workbook stays canonical; QB is a separate read). **(3)** pure `noiVariance(snapshot)` selector. **(4)** `/close` module + per-property drawer. **Fixtures-first** (Gabriel): build to a documented CSV schema; real export wired via env later.

**Tech Stack:** Node 24 ESM, Zod, Hono, React 19, @tanstack/react-query, BarChart, Vitest, `noUncheckedIndexedAccess` ON.

**Deferred (documented, not built):** activating the Tenant Scorecard Health column from QB (cross-feature wire-up — its own follow-up); A/R aging detail; auto-watch of the CSV (it's read on each `brain.refresh`; a workbook change or manual refresh re-reads it — a dedicated chokidar watch on the CSV is a later optimization).

## Documented QB CSV schema (defensive)

The parser is **header-driven and tolerant** (per spec: "renders whatever GL categories QB exports — no hardcoded assumptions"). Expected **long format**, one row per property × account × period (export QB "P&L Detail by Class/Property" reshaped, or adapt the parser when the real file arrives):

```
Property,Month,Account,Type,Amount
1100 Rarig,2026-01,Rental Income,Income,42000
1100 Rarig,2026-01,Repairs & Maintenance,Expense,3100
1100 Rarig,2026-02,Rental Income,Income,42000
2207 Northwood,2026-01,Rental Income,Income,38000
...
```

- Column detection is case-insensitive by header substring: **Property** (`property|class|customer`), **Month** (`month|period|date`), **Account** (`account|gl|category`), **Type** (`type|income/expense`) — optional, **Amount** (`amount|total`).
- **Type inference** when no Type column: account matching `/income|revenue|rent/i` → income, else expense. Amounts parsed tolerantly (`$`, commas, parens-as-negative stripped).
- **Property resolution:** `propertyKey` (raw) → `Property.id` by case-insensitive containment against `Property.name`; unmatched stays `propertyId: null` (still shown by key).
- **Graceful:** missing/empty/unparseable file → `loadQuickbooks` returns `null` (module shows a "Connect QuickBooks" state; budgets still editable).

## File Structure

| File | Track | Responsibility |
|---|---|---|
| `src/contracts/quickbooks.ts` (create) | A | Zod `QbMonthly`/`QbGlLine`/`QbProperty`/`QbActuals` + `NoiBudgetInput` |
| `src/contracts/index.ts` (modify) | A | Re-export `./quickbooks`; add `noiBudgets` + `quickbooks` to `PortfolioSnapshot` |
| `server/sources/quickbooks.ts` (create) | A | `parseQuickbooksCsv(text, properties, now)` (pure) + `loadQuickbooks(properties)` (env, graceful) |
| `tests/unit/quickbooks.test.ts` (create) | A | Parser: grouping, type inference, property resolution, tolerant amounts, absent-file no-op |
| `server/config.ts` (modify) | A | `QUICKBOOKS_CSV` env path |
| `server/overlay.ts` (modify) | B | `noiBudgets` overlay key; merge in `applyOverlay` |
| `server/brain.ts` (modify) | B | `setNoiBudget`; attach `quickbooks` in `refresh` |
| `server/index.ts` (modify) | B | `POST /api/actions/noi-budget` |
| `src/data/actions.ts` (modify) | B | `saveNoiBudget` client |
| `tests/unit/overlay.test.ts` (modify) | B | `applyOverlay` merges `noiBudgets` |
| `src/brain/noi-variance.ts` (create) | C | Pure `noiVariance(snapshot)` → per-property + portfolio variance |
| `tests/unit/noi-variance.test.ts` (create) | C | Variance math, below-budget, expense ratio, no-QB/no-budget cases |
| `src/modules/close/CloseModule.tsx` (create) | C | KPI strip + property table (editable budget) + per-property drawer |
| `src/shell/modules.tsx` (modify) | C | Register `/close` (Capital group) |

---

# TRACK A — Contract + QB parser

## Task A1: QuickBooks contract

**Files:** Create `src/contracts/quickbooks.ts`; Test `tests/unit/quickbooks.test.ts` (created here).

- [ ] **Step 1: Failing test.** Create `tests/unit/quickbooks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { QbActuals, NoiBudgetInput } from '../../src/contracts/quickbooks';

describe('QuickBooks contract', () => {
  it('defaults a QbActuals with empty properties', () => {
    const a = QbActuals.parse({ parsedAt: '2026-06-05T00:00:00.000Z' });
    expect(a.properties).toEqual([]);
    expect(a.sourceFile).toBeNull();
  });
  it('validates the budget action input', () => {
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: 250000 }).success).toBe(true);
    expect(NoiBudgetInput.safeParse({ propertyId: '', amount: 1 }).success).toBe(false);
    expect(NoiBudgetInput.safeParse({ propertyId: 'p1', amount: -5 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Create `src/contracts/quickbooks.ts`:

```typescript
import { z } from 'zod';

export const QbMonthly = z.object({
  month: z.string(), // YYYY-MM
  income: z.number().default(0),
  expense: z.number().default(0),
  noi: z.number().default(0),
});
export type QbMonthly = z.infer<typeof QbMonthly>;

export const QbGlLine = z.object({ account: z.string(), amount: z.number() });
export type QbGlLine = z.infer<typeof QbGlLine>;

export const QbProperty = z.object({
  propertyKey: z.string(), // raw QB property/class name
  propertyId: z.string().nullable().default(null), // resolved to Property.id, best-effort
  annualIncome: z.number().default(0),
  annualExpense: z.number().default(0),
  annualNoi: z.number().default(0),
  monthly: z.array(QbMonthly).default([]),
  glExpense: z.array(QbGlLine).default([]),
});
export type QbProperty = z.infer<typeof QbProperty>;

/** Parsed QuickBooks actuals (server-attached, not from the workbook). Null when no export present. */
export const QbActuals = z.object({
  sourceFile: z.string().nullable().default(null),
  parsedAt: z.string(),
  properties: z.array(QbProperty).default([]),
});
export type QbActuals = z.infer<typeof QbActuals>;

/** POST /api/actions/noi-budget body. */
export const NoiBudgetInput = z.object({ propertyId: z.string().min(1), amount: z.number().nonnegative() });
export type NoiBudgetInput = z.infer<typeof NoiBudgetInput>;
```

- [ ] **Step 4: Run** → PASS. `npx tsc --noEmit -p tsconfig.json` → 0.
- [ ] **Step 5: Commit.** `git add src/contracts/quickbooks.ts tests/unit/quickbooks.test.ts && git commit -m "feat(close): QuickBooks actuals contract + NoiBudgetInput"`

## Task A2: Defensive CSV parser

**Files:** Create `server/sources/quickbooks.ts`; modify `server/config.ts`; append to `tests/unit/quickbooks.test.ts`.

- [ ] **Step 1: Failing tests.** Append to `tests/unit/quickbooks.test.ts`:

```typescript
import { parseQuickbooksCsv } from '../../server/sources/quickbooks';
import type { Property } from '../../src/contracts/index';

const props = [
  { id: 'rarig', name: '1100 Rarig Ave' },
  { id: 'northwood', name: '2207 Northwood' },
] as unknown as Property[];

const CSV = `Property,Month,Account,Type,Amount
1100 Rarig,2026-01,Rental Income,Income,"$42,000"
1100 Rarig,2026-01,Repairs & Maintenance,Expense,3100
1100 Rarig,2026-02,Rental Income,Income,42000
1100 Rarig,2026-02,Insurance,Expense,900
2207 Northwood,2026-01,Rental Income,Income,38000
Unknown Strip Mall,2026-01,Rental Income,Income,5000`;

const NOW = '2026-06-05T00:00:00.000Z';

describe('parseQuickbooksCsv', () => {
  const qb = parseQuickbooksCsv(CSV, props, NOW)!;

  it('groups by property and sums annual income/expense/NOI', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.annualIncome).toBe(84000); // 42k + 42k
    expect(rarig.annualExpense).toBe(4000); // 3100 + 900
    expect(rarig.annualNoi).toBe(80000);
    expect(rarig.monthly).toHaveLength(2);
  });

  it('resolves propertyId by name containment; leaves unmatched null', () => {
    expect(qb.properties.find((p) => p.propertyKey === '1100 Rarig')!.propertyId).toBe('rarig');
    expect(qb.properties.find((p) => p.propertyKey === 'Unknown Strip Mall')!.propertyId).toBeNull();
  });

  it('itemizes GL expense per property (no hardcoded categories)', () => {
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.glExpense.map((g) => g.account).sort()).toEqual(['Insurance', 'Repairs & Maintenance']);
  });

  it('parses tolerant amounts ($ and commas) and stamps parsedAt', () => {
    expect(qb.parsedAt).toBe(NOW);
    const rarig = qb.properties.find((p) => p.propertyKey === '1100 Rarig')!;
    expect(rarig.monthly.find((m) => m.month === '2026-01')!.income).toBe(42000);
  });

  it('infers type from the account when no Type column is present', () => {
    const noType = `Property,Month,Account,Amount\n1100 Rarig,2026-01,Rental Income,1000\n1100 Rarig,2026-01,Landscaping,200`;
    const r = parseQuickbooksCsv(noType, props, NOW)!.properties[0]!;
    expect(r.annualIncome).toBe(1000); // "Rental Income" → income
    expect(r.annualExpense).toBe(200); // "Landscaping" → expense
  });

  it('returns null for empty/headerless content', () => {
    expect(parseQuickbooksCsv('', props, NOW)).toBeNull();
    expect(parseQuickbooksCsv('not,a,recognized,header', props, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Create `server/sources/quickbooks.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import type { Property } from '../../src/contracts/index';
import { QbActuals, type QbProperty } from '../../src/contracts/index';

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
```

- [ ] **Step 4:** Add to `server/config.ts`:

```typescript
/** QuickBooks Desktop → SharePoint CSV export (P&L by property). Unset → /close shows no actuals. */
export const QUICKBOOKS_CSV = process.env.QUICKBOOKS_CSV ?? null;
```

(The parser reads `process.env.QUICKBOOKS_CSV` directly; this export documents it + is available if brain wants it.)

- [ ] **Step 5: Run** `npx vitest run tests/unit/quickbooks.test.ts` → PASS. `npm run typecheck` → 0. `npx eslint server/sources/quickbooks.ts` → clean.
- [ ] **Step 6: Commit.** `git add server/sources/quickbooks.ts server/config.ts tests/unit/quickbooks.test.ts && git commit -m "feat(close): defensive QuickBooks CSV parser (header-driven, graceful)"`

## Task A3: Snapshot contract fields

**Files:** modify `src/contracts/index.ts`.

- [ ] **Step 1:** Add re-export `export * from './quickbooks';` and import `import { QbActuals } from './quickbooks';`. In `PortfolioSnapshot`, after `dealComps`, add:

```typescript
  /** Overlay-sourced per-property annual NOI budget targets (Phase 3 ②). */
  noiBudgets: z.record(z.string(), z.number()).default({}),
  /** Server-attached QuickBooks actuals (Phase 3 ②); null when no export configured. */
  quickbooks: QbActuals.nullable().default(null),
```

- [ ] **Step 2:** `npm run typecheck`. Expect ripple: add `noiBudgets: {}` (and `quickbooks: null` is `.default` so optional, but a non-cast literal needs it too) to `tests/unit/analytics.test.ts` `snap()` and any `Overlay`/snapshot literals flagged. Add minimal fields. Run `npm run gate` → green.
- [ ] **Step 3: Commit.** `git add src/contracts/index.ts tests/unit/analytics.test.ts && git commit -m "feat(close): noiBudgets + quickbooks snapshot fields"`

---

# TRACK B — Overlay + brain + endpoint

## Task B1: noiBudgets overlay + brain + endpoint + client (TDD on overlay)

**Files:** `server/overlay.ts`, `server/brain.ts`, `server/index.ts`, `src/data/actions.ts`, `tests/unit/overlay.test.ts`.

- [ ] **Step 1: Failing overlay test.** Append to `tests/unit/overlay.test.ts`:

```typescript
describe('applyOverlay — noiBudgets (Phase 3 ②)', () => {
  const baseP = { deals: [], tasks: [], leases: [], properties: [{ id: 'p1' }] } as unknown as PortfolioSnapshot;
  it('surfaces noiBudgets onto the snapshot', () => {
    const out = applyOverlay(baseP, { ...EMPTY_OVERLAY, noiBudgets: { p1: 250000 } });
    expect(out.noiBudgets).toEqual({ p1: 250000 });
  });
  it('defaults empty and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseP, EMPTY_OVERLAY).noiBudgets).toEqual({});
    expect(EMPTY_OVERLAY.noiBudgets).toEqual({});
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Overlay.** In `server/overlay.ts`: `Overlay` gains `noiBudgets: Record<string, number>`; `EMPTY_OVERLAY` adds `noiBudgets: {}`; both `loadOverlay` returns add `noiBudgets: raw.noiBudgets ?? {}` / `{}`; `applyOverlay` final return adds `noiBudgets: o.noiBudgets`. (Note: `quickbooks` is NOT overlay — it's attached by brain in step 5, so `applyOverlay` does NOT set it; the base snapshot's `.default(null)` holds until brain attaches it.)

- [ ] **Step 4: Brain mutator + QB attach.** In `server/brain.ts`:
  - Import `loadQuickbooks` from `./sources/quickbooks` and `QUICKBOOKS_CSV` is read via env inside loadQuickbooks.
  - Add `setNoiBudget(propertyId, amount)` after the other mutators (mirror `setDealComps`; validate the property exists in `this.base.properties`).
  - In `refresh()`, after computing `merged` and before `this.snapshot = ...`, attach QB:
    ```typescript
    const qb = loadQuickbooks(merged.properties);
    const withQb = { ...merged, quickbooks: qb };
    ```
    then use `withQb` where `merged` was used for the reconcile + assignment. **In `rederive()`** also attach: `this.snapshot = { ...applyOverlay(this.base, this.overlay), quickbooks: loadQuickbooks(this.base.properties) };` (so budget edits keep QB).
  - `setNoiBudget`:
    ```typescript
    setNoiBudget(propertyId: string, amount: number): boolean {
      if (!this.base?.properties.some((p) => p.id === propertyId)) return false;
      this.overlay = { ...this.overlay, noiBudgets: { ...this.overlay.noiBudgets, [propertyId]: amount } };
      this.rederive('action:noi-budget');
      return true;
    }
    ```

- [ ] **Step 5: Endpoint.** In `server/index.ts`, import `NoiBudgetInput`; add after the other actions:

```typescript
app.post('/api/actions/noi-budget', async (c) => {
  const parsed = NoiBudgetInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid propertyId or amount' }, 400);
  const ok = brain.setNoiBudget(parsed.data.propertyId, parsed.data.amount);
  return c.json({ ok, state: brain.getState() }, ok ? 200 : 404);
});
```

- [ ] **Step 6: Client.** In `src/data/actions.ts`: `export const saveNoiBudget = (propertyId: string, amount: number): Promise<void> => postAction('/api/actions/noi-budget', { propertyId, amount });`

- [ ] **Step 7:** `npm run typecheck` → 0; `npx vitest run tests/unit/overlay.test.ts` → PASS; `npm run gate` → green.
- [ ] **Step 8: Commit.** `git add server/overlay.ts server/brain.ts server/index.ts src/data/actions.ts tests/unit/overlay.test.ts && git commit -m "feat(close): noiBudgets overlay + brain QB attach + budget endpoint"`

---

# TRACK C — Variance selector + /close module

## Task C1: Pure NOI variance selector (TDD)

**Files:** Create `src/brain/noi-variance.ts`; Test `tests/unit/noi-variance.test.ts`.

- [ ] **Step 1: Failing test.** Create `tests/unit/noi-variance.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { noiVariance } from '../../src/brain/noi-variance';

const snap = {
  properties: [
    { id: 'a', name: 'Prop A' },
    { id: 'b', name: 'Prop B' },
    { id: 'c', name: 'Prop C' },
  ],
  noiBudgets: { a: 100000, b: 50000 }, // c has no budget
  quickbooks: {
    sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z',
    properties: [
      { propertyKey: 'Prop A', propertyId: 'a', annualIncome: 130000, annualExpense: 40000, annualNoi: 90000, monthly: [], glExpense: [] },
      { propertyKey: 'Prop B', propertyId: 'b', annualIncome: 70000, annualExpense: 10000, annualNoi: 60000, monthly: [], glExpense: [] },
    ],
  },
} as unknown as PortfolioSnapshot;

describe('noiVariance', () => {
  const v = noiVariance(snap);

  it('computes per-property budget/actual/variance for budgeted+actual rows', () => {
    const a = v.rows.find((r) => r.propertyId === 'a')!;
    expect(a.budget).toBe(100000);
    expect(a.actual).toBe(90000);
    expect(a.variance).toBe(-10000); // under budget
    expect(a.belowBudget).toBe(true);
    const b = v.rows.find((r) => r.propertyId === 'b')!;
    expect(b.variance).toBe(10000); // over budget (favorable)
    expect(b.belowBudget).toBe(false);
  });

  it('includes properties with a budget but no actual (actual null)', () => {
    const c = v.rows.find((r) => r.propertyId === 'c')!;
    expect(c.budget).toBeNull();
    expect(c.actual).toBeNull();
  });

  it('totals portfolio budget/actual/variance and counts below-budget', () => {
    expect(v.totalBudget).toBe(150000);
    expect(v.totalActual).toBe(150000); // 90k + 60k
    expect(v.belowBudgetCount).toBe(1); // only A
  });

  it('computes a portfolio expense ratio from QB actuals', () => {
    // total expense 50k / total income 200k = 0.25
    expect(v.expenseRatio).toBeCloseTo(0.25, 4);
  });

  it('is null-safe when quickbooks is absent', () => {
    const noQb = { properties: [{ id: 'a', name: 'A' }], noiBudgets: { a: 1 }, quickbooks: null } as unknown as PortfolioSnapshot;
    const r = noiVariance(noQb);
    expect(r.totalActual).toBe(0);
    expect(r.rows.find((x) => x.propertyId === 'a')!.actual).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Create `src/brain/noi-variance.ts`:

```typescript
import type { PortfolioSnapshot } from '../contracts/index';

export interface NoiVarianceRow {
  propertyId: string;
  name: string;
  budget: number | null;
  actual: number | null; // QB annual NOI
  variance: number | null; // actual − budget
  variancePct: number | null; // variance / budget
  belowBudget: boolean;
}

export interface NoiVarianceSummary {
  rows: NoiVarianceRow[];
  totalBudget: number;
  totalActual: number;
  totalVariance: number;
  belowBudgetCount: number;
  expenseRatio: number | null; // Σ expense / Σ income (QB)
  hasActuals: boolean;
}

export function noiVariance(s: PortfolioSnapshot): NoiVarianceSummary {
  const qbByProp = new Map<string, { noi: number; income: number; expense: number }>();
  let totalIncome = 0;
  let totalExpense = 0;
  for (const p of s.quickbooks?.properties ?? []) {
    if (p.propertyId) qbByProp.set(p.propertyId, { noi: p.annualNoi, income: p.annualIncome, expense: p.annualExpense });
    totalIncome += p.annualIncome;
    totalExpense += p.annualExpense;
  }

  const rows: NoiVarianceRow[] = s.properties.map((p) => {
    const budgetRaw = s.noiBudgets[p.id];
    const budget = typeof budgetRaw === 'number' ? budgetRaw : null;
    const qb = qbByProp.get(p.id);
    const actual = qb ? qb.noi : null;
    const variance = budget !== null && actual !== null ? actual - budget : null;
    const variancePct = variance !== null && budget ? variance / budget : null;
    return { propertyId: p.id, name: p.name, budget, actual, variance, variancePct, belowBudget: variance !== null && variance < 0 };
  });

  const totalBudget = rows.reduce((n, r) => n + (r.budget ?? 0), 0);
  const totalActual = rows.reduce((n, r) => n + (r.actual ?? 0), 0);
  return {
    rows,
    totalBudget,
    totalActual,
    totalVariance: totalActual - totalBudget,
    belowBudgetCount: rows.filter((r) => r.belowBudget).length,
    expenseRatio: totalIncome > 0 ? totalExpense / totalIncome : null,
    hasActuals: qbByProp.size > 0 || (s.quickbooks?.properties.length ?? 0) > 0,
  };
}
```

- [ ] **Step 4: Run** → PASS. `npm run typecheck` → 0.
- [ ] **Step 5: Commit.** `git add src/brain/noi-variance.ts tests/unit/noi-variance.test.ts && git commit -m "feat(close): pure NOI budget-vs-actual variance selector"`

## Task C2: /close module + registration

**Files:** Create `src/modules/close/CloseModule.tsx`; modify `src/shell/modules.tsx`.

- [ ] **Step 1: Implement the module.** Create `src/modules/close/CloseModule.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnapshot, SNAPSHOT_KEY } from '@/data/queries';
import { saveNoiBudget } from '@/data/actions';
import { fmtUsd, fmtUsdCompact, fmtPct } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { noiVariance, type NoiVarianceRow } from '@/brain/noi-variance';

export function CloseModule() {
  const { data } = useSnapshot();
  const qc = useQueryClient();
  const budgetMut = useMutation({
    mutationFn: (v: { propertyId: string; amount: number }) => saveNoiBudget(v.propertyId, v.amount),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });
  const v = useMemo(() => (data ? noiVariance(data.snapshot) : null), [data]);
  const [selected, setSelected] = useState<string | null>(null);
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
        <KpiStat label="Actual NOI" value={qb ? v.totalActual : null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor="var(--color-pos)" />
        <KpiStat label="Budget NOI" value={v.totalBudget || null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor="var(--accent)" />
        <KpiStat label="Portfolio Variance" value={qb ? v.totalVariance : null} format={(n) => (n === null ? '—' : fmtUsdCompact(n))} accentColor={v.totalVariance < 0 ? 'var(--color-neg)' : 'var(--color-pos)'} sublabel={qb ? `${v.belowBudgetCount} below budget` : undefined} />
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
      <td className="num px-3 py-2 text-right text-xs" style={{ color: row.variance !== null ? (row.variance < 0 ? 'var(--color-neg)' : 'var(--color-pos)') : 'var(--text-tertiary)' }}>{row.variance !== null ? fmtUsd(row.variance) : '—'}</td>
      <td className="num px-3 py-2 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>{row.variancePct !== null ? fmtPct(row.variancePct) : '—'}</td>
      <td className="px-3 py-2 text-right">{row.belowBudget && <Badge tone="red">under</Badge>}</td>
    </tr>
  );
}
```

- [ ] **Step 2: Register.** In `src/shell/modules.tsx`: add `Scale` to the `lucide-react` imports; add the lazy import `const CloseModule = lazy(() => import('@/modules/close/CloseModule').then((m) => ({ default: m.CloseModule })));` after the others; add to `MODULES` in the **Capital** group (after `cash`): `{ id: 'close', label: 'Monthly Close', icon: Scale, group: 'Capital', Component: CloseModule },`.

- [ ] **Step 3: Verify.** `npx tsc --noEmit -p tsconfig.json` → 0. `npm run gate` → green. `npx eslint src/modules/close/CloseModule.tsx src/shell/modules.tsx` → clean. (Confirm `BarChart`'s props are `data`/`valueFormat`/`height`/`color` — match `LeasesModule.tsx`'s usage; adjust if the signature differs.)
- [ ] **Step 4: Commit.** `git add src/modules/close/CloseModule.tsx src/shell/modules.tsx && git commit -m "feat(close): /close NOI budget-vs-actual module + registration"`

## Task C3: Verify end-to-end (fresh server, fixture CSV)

- [ ] **Step 1:** Write a throwaway QB CSV fixture (the schema above) to a temp path with property names matching real `Property.name`s (curl `/api/snapshot` for names). Start the Brain Server fresh with `QUICKBOOKS_CSV=<tmp>`.
- [ ] **Step 2:** `curl /api/snapshot` → confirm `quickbooks.properties` populated + `noiBudgets` present. `curl -X POST /api/actions/noi-budget -d '{"propertyId":"<id>","amount":250000}'` → 200, persists; bad id → 404; negative amount → 400.
- [ ] **Step 3:** Fresh browser: open **Monthly Close** (Capital group). Confirm KPI strip, the table (edit a budget → blur → variance updates after refetch), row click → drawer with monthly BarChart + GL expense list. With `QUICKBOOKS_CSV` unset, confirm the "No QuickBooks export" state + budgets still editable. No console errors.
- [ ] **Step 4:** Delete the temp CSV; reset `data/overlay.json` if a test budget was written; confirm `git status` clean.

---

# Final verification
- [ ] `npm run gate` green; `npm run build` succeeds (server-only `quickbooks.ts` not in client bundle — it's imported only by `server/`).
- [ ] `git status --porcelain` clean; `data/` gitignored.
- [ ] **Confidentiality:** no confidential codename in any new file; QB parser reads only the configured CSV.
- [ ] Final review vs ② design: QB CSV → parser (graceful no-op) ✓; budget overlay per property ✓; KPI strip (actual/budget/variance/expense-ratio) ✓; property table + per-property drawer (monthly chart + GL detail) ✓. Deferred (documented): Tenant Health activation, A/R aging, dedicated CSV watch.
- [ ] **Push + PR — pause for Gabriel's confirmation.**

## Self-review notes
- Overlay discipline: `noiBudgets` additive overlay key (merged in `applyOverlay`); `quickbooks` is server-attached in `refresh`/`rederive` (NOT overlay — it's parsed data, not a user mutation), surfaced as a `.default(null)` snapshot field baked into the mirror.
- `noUncheckedIndexedAccess`: `s.noiBudgets[p.id]` typed `number | undefined` → guarded via `typeof === 'number'`; `qbByProp.get` guarded; test indexing uses `!`.
- Parser is pure + injected (`now`, `properties`) → hermetic tests; `loadQuickbooks` is the only I/O, graceful-null on absence/parse failure.
- CI-safe: no new heavy deps (CSV parsed by hand); fast tests.
- Deferred items explicitly listed; nothing silently dropped.
