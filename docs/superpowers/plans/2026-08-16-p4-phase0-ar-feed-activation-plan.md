# P4 Phase 0 — AR Feed Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the existing, never-run AR ingestion pipeline so the accounts receivable currently invisible to the Command Center flows into `tenantArrears` → `arBalances[]` → the dormant `arrears-*` / `ar-stale` conditions → the daily brief's Section 4c.

**Architecture:** No new subsystem. `scripts/ar-import-headless.ts` and `server/ar/*` already implement parsing, tenant→lease matching, confidence partitioning, and overlay writes; they have simply never been fed. This plan creates the inbox, proves the chain end-to-end on the format already supported, then adds the two missing formats in ascending order of difficulty.

**Tech Stack:** TypeScript · tsx · ExcelJS · vitest · existing `server/ar/` modules

**Scope:** Phase 0 only (spec v03 §4), per Gabriel's ruling 2026-08-16. Phases 1–3 are re-assessed after real AR data is flowing.

## Global Constraints

- **Read-only on `Business/`** — Invariant 5. AR files are **copied** into the inbox, never moved.
- **Dry-run before any live write** — ruled 2026-08-16. Worktree-local `AR_INBOX` and `SNAPSHOT_PATH` until a run is inspected and approved by Gabriel.
- **Dev server must be stopped** during any run that writes the real overlay. `Brain` loads `data/overlay.json` once at construction and never re-reads it; a server-mediated write afterwards calls `saveOverlay()` with its stale in-memory copy and durably erases everything this script wrote. Documented in `scripts/ar-import-headless.ts` lines 40–50.
- **Never modify** `server/anomaly-floor.ts` (canonical, consolidated 2026-07-26 after two reverts), `server/ar/match-tenant.ts`, or `server/ar/partition-confidence.ts`.
- **Auto-write rule is already correct** — exact / high-≥2-token / cache-confirmed writes; everything else to review queue. Do not loosen it.
- **All work on branch `feat/p4-pm-reconciliation`**, worktree `.claude/worktrees/p4-pm-reconciliation`. Re-check `git status` immediately before each commit.
- **Scheduling only via supervised `create_scheduled_task`** — never registry JSON splicing.
- **No real tenant delinquency data in the repo.** Every test fixture is synthetic, per the convention stated in `server/ar/ar-aging.ts`'s module doc.
- Test: `npm test` · single file: `npx vitest run tests/unit/<name>.test.ts` · `npm run typecheck` · `npm run lint` (`--max-warnings 0`).

## Source Data — verified 2026-08-16

Eight files in `Business/A.R. Reports/`, all dated 7.15.2026, in three formats:

| Format | Row-1 marker | Files | Tenant identity | Parser status | `_pipeline` count |
|---|---|---|---|---|---|
| **A** | `Delinquency (Detail)` | 1100 Rarig · 3034 Westerville · 3540 E 5th · 9620 State 350 · Sepich | Tenant Name column | **Supported today** | 26 |
| **C** | `DB Caption:` | 29000 Info Lane · 1900 Broadway + 9050 Red Branch | `Lease` column (names) | Missing | 11 |
| **B** | `Delinquency` + `Exported On:` | 2203-2207 Northwood | **Unit only — no name** | Missing + needs new match path | 6 |

Independent cross-check from `_pipeline/output/sync_log.json` (built 2026-07-17 from these same files): **`ar_total` $REDACTED-AMT · `ar_total_active` $REDACTED-AMT · `ar_tenants` 31 · 0 unmapped.**

**Format A needs no code.** It is 26 of 31 tenants — the bulk of the value — and Task 1 delivers it.

### The Format B complication

The Northwood export's columns are `Unit | Amount Receivable | Last Payment | Payment Amount | Tenant Status | Move In | Move Out | Deposit | 0-30 | 30+`. There is **no tenant name anywhere on the report.** Rows are identified by unit (`4A`, `11-12A`, `15A`, `01B`, `04B`, `C 1-2`) beneath property group headers (`nbc-a - 2207 Nothwood…`, `nbc-b - 2205 Nor…`, `nbc-c - 2203 Mar…` — note the source misspells "Northwood").

`server/ar/match-tenant.ts` matches on tenant name. Fed a nameless row it scores zero, so **every Northwood row would route to the review queue on every run, forever.** Format B therefore needs a different resolution path — (property, unit) against the lease roster — not just a parser. That is Task 4, and it is the largest piece of work here. It is also *stronger* evidence than name matching when it succeeds.

Format B also carries **two** explicit buckets (`0-30`, `30+`), per-property subtotal rows (blank Unit, populated Amount Receivable), and a final `Total` row — all of which must be excluded or balances double-count.

## File Structure

| File | Responsibility |
|---|---|
| `server/ar/delinquency-transactional.ts` | **Create** — Format C detector + parser. Per-charge rows aged against report as-of. Emits `ArAgingRow` (has tenant names, so existing matching applies). |
| `server/ar/delinquency-bucketed.ts` | **Create** — Format B detector + parser. Emits its own `BucketedUnitRow` type, because identity is unit-not-name. |
| `server/ar/resolve-by-unit.ts` | **Create** — `(property, unit) → leaseId` resolver against the lease roster, for Format B. |
| `scripts/ar-import-headless.ts` | **Modify** — extend the xlsx branch to try three detectors in order; route Format B through the unit resolver. |
| `tests/unit/ar-delinquency-transactional.test.ts` | **Create** |
| `tests/unit/ar-delinquency-bucketed.test.ts` | **Create** |
| `tests/unit/ar-resolve-by-unit.test.ts` | **Create** |
| `data/ar/{inbox,processed,failed}` | **Create** — runtime, gitignored |

---

### Task 1: Prove the chain end-to-end on Format A

Five of eight files already parse. This establishes that parse → match → partition → overlay → `arBalances` works against real data before any code is written. **This task delivers 26 of 31 tenants.**

**Files:** Create `data/ar-dryrun/` (worktree-local, gitignored). Read `Business/A.R. Reports/*.xlsx`.

- [ ] **Step 1: Create the dry-run inbox and copy the five Format-A files**

```bash
cd .claude/worktrees/p4-pm-reconciliation
mkdir -p data/ar-dryrun/inbox
SRC="/c/Users/Owner/OneDrive - Oxford Capital Partners/Business/A.R. Reports"
for f in "1100 Rarig" "3034 Westerville" "3540 E 5th" "9620 State 350" "Sepich Portfolio"; do
  cp "$SRC/$f Delinquency 7.15.2026.xlsx" data/ar-dryrun/inbox/
done
ls data/ar-dryrun/inbox/ | wc -l
```

Expected: `5`. Source directory unchanged.

- [ ] **Step 2: Copy the snapshot so the dry run cannot touch the real one**

```bash
cp data/snapshots/portfolio.json data/ar-dryrun/portfolio.json
```

- [ ] **Step 3: Confirm the dev server is stopped**

```bash
npx tsx -e "fetch('http://localhost:5173').then(()=>{console.log('SERVER UP - STOP IT');process.exit(1)}).catch(()=>console.log('server down - safe'))"
```

Expected: `server down - safe`. If `SERVER UP`, stop it — see Global Constraints.

- [ ] **Step 4: Run the importer against the dry-run copies**

```bash
cp data/overlay.json data/ar-dryrun/overlay.json
AR_INBOX="$PWD/data/ar-dryrun/inbox" \
SNAPSHOT_PATH="$PWD/data/ar-dryrun/portfolio.json" \
OVERLAY_PATH="$PWD/data/ar-dryrun/overlay.json" \
AR_MAPPING_CACHE="$PWD/data/ar-dryrun/mapping-cache.json" \
npx tsx scripts/ar-import-headless.ts
```

**`OVERLAY_PATH` is not optional.** The importer writes the overlay as the canonical store and only *then* patches the snapshot, so redirecting `SNAPSHOT_PATH` alone still writes the live `data/overlay.json` — a "dry" run that mutates production state. `overlayPath()` reads `process.env.OVERLAY_PATH` at call time (`server/overlay.ts:54`), so the redirect works. Verify isolation by checksumming `data/overlay.json` and `data/snapshots/portfolio.json` before and after; both must be byte-identical.

**Run from the main checkout, not the worktree.** `node_modules` is gitignored and does not propagate into a worktree, so `npx tsx` fails there. Task 1 changes no code, so running the unmodified script from the main checkout with all four paths redirected into the worktree's `data/ar-dryrun/` is equivalent and fully isolated.

Expected: exit 0, log showing `5 file(s) · 138 lease(s) loaded`. Any file landing in `data/ar-dryrun/failed/` is a finding — record the quarantine reason verbatim and stop.

**Actual result, 2026-08-16 (run completed):** all five parsed as `rent-manager-delinquency`, `18 lease(s) written · 8 queued for review · 0 skipped · 5/5 archived` — 26 rows total, exactly matching `_pipeline`'s count for these five files. Written $54,762.78; review queue $75,213.11; combined **$129,975.89**, leaving $74,812.59 for Formats B and C. **`AR Tenant 022` surfaced in the review queue at $20,457.24**, matching the documented balance to the cent — acceptance criterion (a) satisfied. Both real files verified byte-identical before and after.

- [ ] **Step 5: Verify what was written**

```bash
npx tsx -e "
const s=require('./data/ar-dryrun/portfolio.json');
const ta=s.tenantArrears??{};
const tot=Object.values(ta).reduce((a,b)=>a+b.d30+b.d60+b.d90+b.d90plus,0);
console.log('leases with arrears:',Object.keys(ta).length,'| written total \$'+tot.toFixed(2));
"
```

`_pipeline` parsed **26 tenant rows** from these five files. Fewer written here is expected, not a failure — below-high-confidence rows go to review by design. Record the number.

- [ ] **Step 6: Read the review queue**

```bash
cat data/ar-dryrun/review-queue.json 2>/dev/null || echo "(none written)"
```

Inspect every proposed tenant→lease attribution. Confirm `written count + review count` accounts for all 26.

- [ ] **Step 7: Commit the harness ignore**

```bash
echo "data/ar-dryrun/" >> .gitignore
git add .gitignore
git commit -m "chore(ar): gitignore the Phase 0 dry-run harness directory"
```

---

### Task 2: Format C parser — transactional "DB Caption" export

Adds 11 tenants. Straightforward: the `Lease` column carries tenant names, so existing matching applies unchanged.

**Files:**
- Create: `server/ar/delinquency-transactional.ts`
- Create: `tests/unit/ar-delinquency-transactional.test.ts`

**Interfaces:**
- Consumes: `ArAgingRow` from `server/ar/ar-aging.ts` — exactly `{tenant: string; property: string | null; d30: number; d60: number; d90: number; d90plus: number}`. **There is no `unit` field.**
- Produces: `detectDelinquencyTransactional(ws: ExcelJS.Worksheet): boolean` and `parseDelinquencyTransactional(ws: ExcelJS.Worksheet, asOf: Date): ArAgingRow[]`. Note the second parameter — Format A's parser takes no as-of.

Verified shape: row 1 `DB Caption: …`; row 2 header `Property | Customer | Lease | Status | Tran# | Charge | Date | Month | Current`; row 3 a continuation header (`Code`, `Owed`); then per-charge rows. Detail rows populate both `Property` (col 1) and `Lease` (col 3). Per-tenant subtotal rows have a **blank** `Property` and must be skipped.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/ar-delinquency-transactional.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { detectDelinquencyTransactional, parseDelinquencyTransactional } from '../../server/ar/delinquency-transactional';

function sheet(rows: (string | number | Date | null)[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet('Report1');
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

const H = ['Property', 'Customer', 'Lease', 'Status', 'Tran#', 'Charge', 'Date', 'Month', 'Current'];
const AS_OF = new Date('2026-07-15T00:00:00Z');
const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

describe('detectDelinquencyTransactional', () => {
  it('recognizes the DB Caption export', () => {
    expect(detectDelinquencyTransactional(sheet([['DB Caption:  LIVE   All Selected P'], H]))).toBe(true);
  });

  it('rejects Format A and Format B so detectors cannot collide', () => {
    expect(detectDelinquencyTransactional(sheet([['Delinquency (Detail)']]))).toBe(false);
    expect(detectDelinquencyTransactional(sheet([['Delinquency'], ['Exported On: 07/15/2026']]))).toBe(false);
  });
});

describe('parseDelinquencyTransactional', () => {
  it('ages each charge into the right bucket relative to as-of', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Acme LLC', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      ['prop1', null, 'Acme LLC', 'Current', 'R-2', 'Rent', d('2026-06-01'), '06/2026', 200],
      ['prop1', null, 'Acme LLC', 'Current', 'R-3', 'Rent', d('2026-05-01'), '05/2026', 400],
      ['prop1', null, 'Acme LLC', 'Current', 'R-4', 'Rent', d('2026-01-01'), '01/2026', 800],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant: 'Acme LLC', property: 'prop1', d30: 100, d60: 200, d90: 400, d90plus: 800 });
  });

  it('skips subtotal rows (blank Property) so balances are not doubled', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Acme LLC', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      [null, null, 'Acme LLC', null, null, null, null, null, 100],
    ]);
    expect(parseDelinquencyTransactional(ws, AS_OF)[0].d30).toBe(100);
  });

  it('treats an undated charge as oldest, never as current', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'No Date Co', 'Current', 'R-7', 'Rent', null, '', 300],
    ]);
    const r = parseDelinquencyTransactional(ws, AS_OF)[0];
    expect(r.d30).toBe(0);
    expect(r.d90plus).toBe(300);
  });

  it('clamps a net credit to zero and drops tenants netting to nothing', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Prepay Co', 'Current', 'R-9', 'Prepay', d('2026-07-01'), '07/2026', -500],
      ['prop1', null, 'Even Steven', 'Current', 'R-8', 'Rent', d('2026-07-01'), '07/2026', 0],
    ]);
    expect(parseDelinquencyTransactional(ws, AS_OF)).toHaveLength(0);
  });

  it('aggregates multiple charges for one tenant into a single row', () => {
    const ws = sheet([
      ['DB Caption:  LIVE'], H, [null, null, null, null, null, 'Code', null, null, 'Owed'],
      ['prop1', null, 'Multi Co', 'Current', 'R-1', 'Rent', d('2026-07-01'), '07/2026', 100],
      ['prop1', null, 'Multi Co', 'Current', 'R-2', 'CAM', d('2026-07-05'), '07/2026', 50],
    ]);
    const rows = parseDelinquencyTransactional(ws, AS_OF);
    expect(rows).toHaveLength(1);
    expect(rows[0].d30).toBe(150);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/unit/ar-delinquency-transactional.test.ts
```

Expected: FAIL — `Failed to resolve import ".../delinquency-transactional"`.

- [ ] **Step 3: Implement the parser**

```typescript
// server/ar/delinquency-transactional.ts
//
// Format C parser: the "DB Caption" transactional export (29000 Info Lane, CRC). One row PER CHARGE
// rather than per tenant, so aging is computed here from each charge's Date against the report's
// as-of date — the same reason ar-aging.ts refuses bucket-less formats rather than guessing.
//
// Subtotal rows (blank Property, repeated Lease) are skipped: they restate the tenant's total and
// would double every balance if summed alongside the detail rows.

import type ExcelJS from 'exceljs';
import type { ArAgingRow } from './ar-aging';

const COL = { property: 1, lease: 3, date: 7, owed: 9 } as const;
const DAY_MS = 86_400_000;

function text(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v: ExcelJS.CellValue): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const p = Number.parseFloat(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

function asDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function detectDelinquencyTransactional(ws: ExcelJS.Worksheet): boolean {
  return text(ws, 1, 1).toLowerCase().startsWith('db caption:');
}

/** Bucket a charge by age in days. An UNDATED charge is treated as oldest — an unknown age must
 *  never be reported as current, which would understate a genuinely aged balance. */
function bucketOf(charge: Date | null, asOf: Date): 'd30' | 'd60' | 'd90' | 'd90plus' {
  if (charge === null) return 'd90plus';
  const days = Math.floor((asOf.getTime() - charge.getTime()) / DAY_MS);
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90plus';
}

export function parseDelinquencyTransactional(ws: ExcelJS.Worksheet, asOf: Date): ArAgingRow[] {
  const byTenant = new Map<string, ArAgingRow>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const property = text(ws, r, COL.property);
    const lease = text(ws, r, COL.lease);
    // Detail rows carry BOTH. A blank property with a lease is a per-tenant subtotal.
    if (property === '' || lease === '') continue;

    const owed = num(ws.getRow(r).getCell(COL.owed).value);
    if (owed === 0) continue;

    let row = byTenant.get(lease);
    if (row === undefined) {
      row = { tenant: lease, property, d30: 0, d60: 0, d90: 0, d90plus: 0 };
      byTenant.set(lease, row);
    }
    row[bucketOf(asDate(ws.getRow(r).getCell(COL.date).value), asOf)] += owed;
  }

  // Clamp per bucket AFTER summation so an in-period credit can offset a charge, but a net credit
  // never reports as negative past-due. Drop tenants netting to nothing — a zero is not a delinquency.
  const out: ArAgingRow[] = [];
  for (const row of byTenant.values()) {
    row.d30 = Math.max(0, row.d30);
    row.d60 = Math.max(0, row.d60);
    row.d90 = Math.max(0, row.d90);
    row.d90plus = Math.max(0, row.d90plus);
    if (row.d30 + row.d60 + row.d90 + row.d90plus > 0) out.push(row);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/unit/ar-delinquency-transactional.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add server/ar/delinquency-transactional.ts tests/unit/ar-delinquency-transactional.test.ts
git commit -m "feat(ar): parse the transactional DB Caption xlsx export (Format C)"
```

---

### Task 3: Format B parser — bucketed unit-level export

Parses the Northwood file into unit-keyed rows. **Does not resolve them to leases** — that is Task 4.

**Files:**
- Create: `server/ar/delinquency-bucketed.ts`
- Create: `tests/unit/ar-delinquency-bucketed.test.ts`

**Interfaces:**
- Produces: `detectDelinquencyBucketed(ws: ExcelJS.Worksheet): boolean` and `parseDelinquencyBucketed(ws: ExcelJS.Worksheet): BucketedUnitRow[]`, where

```typescript
export interface BucketedUnitRow {
  unit: string;
  property: string | null;
  d30: number;
  d30plus: number;
}
```

This is deliberately **not** `ArAgingRow`: there is no tenant name to put in `tenant`, and emitting an empty string there would let a nameless row enter the name matcher and silently score zero.

Verified shape: row 1 `Delinquency`; row 2 `Exported On: …`; header row 8 starting `Unit`; columns `Unit(1) | Amount Receivable(2) | … | Deposit(8) | 0-30(9) | 30+(10)`. Property group headers have a label in col 1 and blank col 2. Subtotal rows have blank col 1 and populated col 2. The final row is labelled `Total`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/ar-delinquency-bucketed.test.ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { detectDelinquencyBucketed, parseDelinquencyBucketed } from '../../server/ar/delinquency-bucketed';

function sheet(rows: (string | number | null)[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet('Sheet1');
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

const HEADER = ['Unit', 'Amount Receivable', 'Last Payment', 'Payment Amount', 'Tenant Status', 'Move In', 'Move Out', 'Deposit', '0-30', '30+'];
const PREAMBLE = [['Delinquency'], ['Exported On: 07/15/2026 11:58 AM'], [], [], [], [], []];

describe('detectDelinquencyBucketed', () => {
  it('recognizes the bucketed Delinquency export', () => {
    expect(detectDelinquencyBucketed(sheet([...PREAMBLE, HEADER]))).toBe(true);
  });

  it('rejects Delinquency (Detail) — the titles share a prefix', () => {
    expect(detectDelinquencyBucketed(sheet([['Delinquency (Detail)'], ['All Properties']]))).toBe(false);
  });

  it('rejects a DB Caption export', () => {
    expect(detectDelinquencyBucketed(sheet([['DB Caption:  LIVE'], ['Property', 'Customer']]))).toBe(false);
  });
});

describe('parseDelinquencyBucketed', () => {
  it('parses unit rows under their property group header', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr'],
      ['4A', 1111.25, null, 1100, 'Current', null, null, 900, 1111.25, 0],
      ['11-12A', 2222.5, null, 2000, 'Current', null, null, 1500, 2222.5, 0],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ unit: '4A', property: 'grp-a - 100 Example Dr', d30: 1111.25, d30plus: 0 });
    expect(rows[1].unit).toBe('11-12A');
  });

  it('switches property on each new group header', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr'],
      ['4A', 1111.25, null, 1100, 'Current', null, null, 900, 1111.25, 0],
      ['grp-b - 200 Example Dr'],
      ['01B', 1050.03, null, 950, 'Current', null, null, 800, 1050, 0.03],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows[1].property).toBe('grp-b - 200 Example Dr');
    expect(rows[1].d30plus).toBeCloseTo(0.03, 2);
  });

  it('skips per-property subtotal rows (blank Unit)', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr'],
      ['4A', 1111.25, null, 1100, 'Current', null, null, 900, 1111.25, 0],
      [null, 4444.75, null, 3300, null, null, null, 3600, 4244.75, 200],
    ]);
    expect(parseDelinquencyBucketed(ws)).toHaveLength(1);
  });

  it('excludes the final Total row', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr'],
      ['4A', 1111.25, null, 1100, 'Current', null, null, 900, 1111.25, 0],
      ['Total', 12345.67, null, 5000, null, null, null, 7000, 11111.11, 1234.56],
    ]);
    const rows = parseDelinquencyBucketed(ws);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.unit.toLowerCase() === 'total')).toBe(false);
  });

  it('clamps credit balances to zero', () => {
    const ws = sheet([...PREAMBLE, HEADER,
      ['grp-a - 100 Example Dr'],
      ['9B', -250, null, 0, 'Current', null, null, 0, -250, 0],
    ]);
    expect(parseDelinquencyBucketed(ws)[0].d30).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/unit/ar-delinquency-bucketed.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

```typescript
// server/ar/delinquency-bucketed.ts
//
// Format B parser: the two-bucket "Delinquency" export (2203-2207 Northwood) named as an unsupported
// shape in ar-aging.ts's module doc.
//
// This export carries NO TENANT NAME — identity is unit-only, under a property group header. It
// therefore emits BucketedUnitRow, NOT ArAgingRow: putting an empty string in ArAgingRow.tenant would
// let a nameless row enter match-tenant.ts, score zero against every lease, and route to review
// forever while looking like it parsed fine. Resolution to a Lease.id is resolve-by-unit.ts's job.
//
// Buckets: the export gives '0-30' and '30+' only. d30plus is left unsplit rather than guessed into
// d60/d90/d90plus — the report does not say, and inventing an age would feed a wrong number to the
// collections alert.

import type ExcelJS from 'exceljs';

export interface BucketedUnitRow {
  /** Unit/suite label exactly as printed (e.g. '4A', '11-12A', 'C 1-2'). */
  unit: string;
  /** Property group header this unit appeared under, verbatim (may carry source typos). */
  property: string | null;
  /** 1-30 days past due. */
  d30: number;
  /** 30+ days past due, age not further resolvable from this export. */
  d30plus: number;
}

const COL = { unit: 1, receivable: 2, d30: 9, d30plus: 10 } as const;

function text(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v: ExcelJS.CellValue): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const p = Number.parseFloat(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

/** True only for the two-bucket 'Delinquency' export. Row 1 must match EXACTLY — Format A's title
 *  ('Delinquency (Detail)') shares the prefix, so a startsWith check would steal its files. */
export function detectDelinquencyBucketed(ws: ExcelJS.Worksheet): boolean {
  if (text(ws, 1, 1).toLowerCase() !== 'delinquency') return false;
  return text(ws, 2, 1).toLowerCase().startsWith('exported on:');
}

function headerRow(ws: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
    if (text(ws, r, COL.unit).toLowerCase() === 'unit') return r;
  }
  return -1;
}

export function parseDelinquencyBucketed(ws: ExcelJS.Worksheet): BucketedUnitRow[] {
  const hdr = headerRow(ws);
  if (hdr === -1) return [];

  const out: BucketedUnitRow[] = [];
  let property: string | null = null;

  for (let r = hdr + 1; r <= ws.rowCount; r++) {
    const label = text(ws, r, COL.unit);
    if (label === '') continue;               // per-property subtotal row
    if (label.toLowerCase() === 'total') continue; // grand total row

    const receivable = ws.getRow(r).getCell(COL.receivable).value;
    // A label with no receivable is a property group header, not a unit.
    if (receivable === null || receivable === undefined || String(receivable).trim() === '') {
      property = label;
      continue;
    }

    out.push({
      unit: label,
      property,
      d30: Math.max(0, num(ws.getRow(r).getCell(COL.d30).value)),
      d30plus: Math.max(0, num(ws.getRow(r).getCell(COL.d30plus).value)),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/unit/ar-delinquency-bucketed.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add server/ar/delinquency-bucketed.ts tests/unit/ar-delinquency-bucketed.test.ts
git commit -m "feat(ar): parse the two-bucket unit-level Delinquency export (Format B)"
```

---

### Task 4: Unit-based lease resolution for Format B

The piece that makes Format B usable. Resolves `(property, unit)` to a `Lease.id` without touching `match-tenant.ts`.

**Files:**
- Create: `server/ar/resolve-by-unit.ts`
- Create: `tests/unit/ar-resolve-by-unit.test.ts`

**Interfaces:**
- Consumes: `BucketedUnitRow` (Task 3). Lease roster rows shaped `{id: string; unit: string | null; propertyId: string}` — `portfolio.json.leases[]` carries `unit` and `propertyId`.
- Produces:

```typescript
export interface UnitResolution {
  leaseId: string | null;
  /** 'exact' when one lease matched on normalized (propertyId, unit); 'none' otherwise. */
  confidence: 'exact' | 'none';
  /** True when ≥2 leases matched — never auto-written. */
  ambiguous: boolean;
}
export function resolveByUnit(row: BucketedUnitRow, leases: readonly UnitLease[], propertyId: string | null): UnitResolution;
```

**Deliberately no fuzzy tier.** A unit label is short and low-entropy: `4A` vs `4B` differ by one character but are different tenants. Anything not an exact normalized match goes to review, which is the same conservative posture `partition-confidence.ts` already takes.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/ar-resolve-by-unit.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeUnit, resolveByUnit, type UnitLease } from '../../server/ar/resolve-by-unit';

const LEASES: UnitLease[] = [
  { id: 'L1', unit: '4A', propertyId: 'northwood' },
  { id: 'L2', unit: '11-12A', propertyId: 'northwood' },
  { id: 'L3', unit: '4B', propertyId: 'northwood' },
  { id: 'L4', unit: 'C 1-2', propertyId: 'northwood' },
  { id: 'L5', unit: '4A', propertyId: 'other-prop' },
];

describe('normalizeUnit', () => {
  it('uppercases and strips punctuation, whitespace, and Suite/Ste/Unit prefixes', () => {
    expect(normalizeUnit('  ste. 4a ')).toBe('4A');
    expect(normalizeUnit('Unit C 1-2')).toBe('C12');
    expect(normalizeUnit('#11-12A')).toBe('1112A');
  });
});

describe('resolveByUnit', () => {
  it('resolves an exact normalized unit within the right property', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r).toEqual({ leaseId: 'L1', confidence: 'exact', ambiguous: false });
  });

  it('does not cross property boundaries', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'other-prop');
    expect(r.leaseId).toBe('L5');
  });

  it('returns none when the property is unresolved — never guesses across the portfolio', () => {
    const r = resolveByUnit({ unit: '4A', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, null);
    expect(r).toEqual({ leaseId: null, confidence: 'none', ambiguous: false });
  });

  it('never near-matches a one-character-different unit', () => {
    const r = resolveByUnit({ unit: '4C', property: 'nbc-a', d30: 1, d30plus: 0 }, LEASES, 'northwood');
    expect(r.leaseId).toBeNull();
    expect(r.confidence).toBe('none');
  });

  it('flags ambiguity and refuses to pick when two leases share a unit', () => {
    const dupes: UnitLease[] = [
      { id: 'A', unit: '7A', propertyId: 'northwood' },
      { id: 'B', unit: '7a', propertyId: 'northwood' },
    ];
    const r = resolveByUnit({ unit: '7A', property: 'nbc-a', d30: 1, d30plus: 0 }, dupes, 'northwood');
    expect(r.ambiguous).toBe(true);
    expect(r.leaseId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/unit/ar-resolve-by-unit.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```typescript
// server/ar/resolve-by-unit.ts
//
// (property, unit) → Lease.id resolution for Format B, whose export carries no tenant name.
// Separate from match-tenant.ts, which is name-based and must not be weakened to accept nameless rows.
//
// EXACT ONLY, by design. Unit labels are short and low-entropy — '4A' and '4B' differ by one
// character and are different tenants — so a fuzzy tier here would silently mis-attribute a
// delinquency, the worst failure mode this pipeline has. Anything not exact goes to review.

import type { BucketedUnitRow } from './delinquency-bucketed';

export interface UnitLease {
  id: string;
  unit: string | null;
  propertyId: string;
}

export interface UnitResolution {
  leaseId: string | null;
  confidence: 'exact' | 'none';
  ambiguous: boolean;
}

/** Uppercase, drop Suite/Ste/Unit/# prefixes, strip all non-alphanumerics. */
export function normalizeUnit(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/^\s*(SUITE|STE|UNIT|#)\s*\.?\s*/i, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function resolveByUnit(
  row: BucketedUnitRow,
  leases: readonly UnitLease[],
  propertyId: string | null,
): UnitResolution {
  // An unresolved property means we cannot scope the unit. Matching portfolio-wide would let
  // Northwood's '4A' collect another property's '4A' — exactly the Columbus-vs-Salisbury collision
  // class. Refuse rather than guess.
  if (propertyId === null) return { leaseId: null, confidence: 'none', ambiguous: false };

  const target = normalizeUnit(row.unit);
  if (target === '') return { leaseId: null, confidence: 'none', ambiguous: false };

  const hits = leases.filter(
    (l) => l.propertyId === propertyId && l.unit !== null && normalizeUnit(l.unit) === target,
  );

  if (hits.length === 1) return { leaseId: hits[0].id, confidence: 'exact', ambiguous: false };
  if (hits.length > 1) return { leaseId: null, confidence: 'none', ambiguous: true };
  return { leaseId: null, confidence: 'none', ambiguous: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/unit/ar-resolve-by-unit.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, lint, full suite, commit**

```bash
npm run typecheck && npm run lint && npm test
git add server/ar/resolve-by-unit.ts tests/unit/ar-resolve-by-unit.test.ts
git commit -m "feat(ar): exact (property, unit) lease resolution for nameless AR exports"
```

---

### Task 5: Wire all three formats into the headless importer

**Files:**
- Modify: `scripts/ar-import-headless.ts`, the xlsx branch (currently around lines 249–280, beginning `const worksheet = workbook.worksheets.find((ws) => detectRentManagerDelinquencyDetail(ws));`)

- [ ] **Step 1: Add the imports**

```typescript
import { detectDelinquencyBucketed, parseDelinquencyBucketed } from '../server/ar/delinquency-bucketed';
import { detectDelinquencyTransactional, parseDelinquencyTransactional } from '../server/ar/delinquency-transactional';
import { resolveByUnit, type UnitLease } from '../server/ar/resolve-by-unit';
```

- [ ] **Step 2: Replace the single-format lookup with ordered three-format resolution**

Take the existing block that reads

```typescript
const worksheet = workbook.worksheets.find((ws) => detectRentManagerDelinquencyDetail(ws));
if (worksheet === undefined) {
  quarantine(file, 'xlsx format not recognized as Rent Manager "Delinquency (Detail)" — other RM/Yardi bucketed xlsx exports are not yet supported');
  continue;
}
```

and replace it with the following. **Keep the existing Format A body exactly as it is** — only its worksheet variable is renamed from `worksheet` to `wsA`, and it moves into the final `else` branch.

```typescript
      // Ordered detection: A → C → B. Format A is tried first because Format B's title is a prefix
      // of its own; detectDelinquencyBucketed requires an EXACT row-1 match so the two cannot collide.
      const wsA = workbook.worksheets.find((ws) => detectRentManagerDelinquencyDetail(ws));
      const wsC = wsA ? undefined : workbook.worksheets.find((ws) => detectDelinquencyTransactional(ws));
      const wsB = wsA || wsC ? undefined : workbook.worksheets.find((ws) => detectDelinquencyBucketed(ws));

      if (wsA === undefined && wsB === undefined && wsC === undefined) {
        quarantine(file, 'xlsx format not recognized as Delinquency (Detail), DB Caption transactional, or two-bucket Delinquency');
        continue;
      }

      if (wsC !== undefined) {
        // Format C has no in-file as-of line, so aging is relative to the filename date. Without one
        // every charge would be aged against "now", silently reporting stale balances as current.
        const asOf = extractAsOfDateFromFilename(sourceFile);
        if (asOf === null) {
          quarantine(file, 'DB Caption export carries no in-file as-of date and none could be derived from the filename — refusing to age charges against an assumed date');
          continue;
        }
        rows = parseDelinquencyTransactional(wsC, asOf);
        format = 'delinquency-transactional';
        xlsxAsOfDate = asOf;
      } else if (wsB !== undefined) {
        // Format B is nameless. Resolve (property, unit) → leaseId here and emit rows already
        // carrying an identity; unresolved rows become review entries rather than entering the
        // name matcher, where they would score zero against every lease.
        const unitLeases: UnitLease[] = leases.map((l) => ({
          id: l.id,
          unit: (l as unknown as { unit?: string | null }).unit ?? null,
          propertyId: (l as unknown as { propertyId?: string }).propertyId ?? '',
        }));
        const parsed = parseDelinquencyBucketed(wsB);
        rows = [];
        for (const b of parsed) {
          const propertyId = resolvePropertyId(b.property);
          const res = resolveByUnit(b, unitLeases, propertyId);
          if (res.leaseId === null) {
            allReviews.push(buildUnresolvedUnitReview(b, sourceFile, res.ambiguous));
            continue;
          }
          allWrites.push({
            leaseId: res.leaseId,
            arrears: { d30: b.d30, d60: 0, d90: 0, d90plus: b.d30plus },
            tenant: `${b.property ?? 'unknown'} / ${b.unit}`,
          });
        }
        format = 'delinquency-bucketed';
        xlsxAsOfDate = extractAsOfDateFromFilename(sourceFile);
        processed.push(file);
        continue; // rows already routed; skip the shared name-matching path below
      } else {
        // ... existing Format A body, unchanged, with `worksheet` renamed to `wsA`
      }
```

**Note for the implementer:** `resolvePropertyId(label)` and `buildUnresolvedUnitReview(row, sourceFile, ambiguous)` do not exist yet. Implement both as local helpers in this file:
- `resolvePropertyId` maps a Format-B group header (`nbc-a - 2207 Nothwood…`) to a `portfolio.json` property id. Seed it from the group headers actually present in the Northwood file and return `null` for anything unrecognized — an unmapped label must produce a review entry, never a portfolio-wide unit match.
- `buildUnresolvedUnitReview` mirrors the existing `QueuedReview` shape already used in this file for name-based reviews; set the tenant field to `"<property> / <unit>"` and note `ambiguous` in the reason.

- [ ] **Step 3: Re-run the dry run with all eight files**

```bash
rm -rf data/ar-dryrun/inbox data/ar-dryrun/processed data/ar-dryrun/failed
mkdir -p data/ar-dryrun/inbox
cp "/c/Users/Owner/OneDrive - Oxford Capital Partners/Business/A.R. Reports/"*.xlsx data/ar-dryrun/inbox/
cp data/snapshots/portfolio.json data/ar-dryrun/portfolio.json
cp data/overlay.json data/ar-dryrun/overlay.json
AR_INBOX="$PWD/data/ar-dryrun/inbox" \
SNAPSHOT_PATH="$PWD/data/ar-dryrun/portfolio.json" \
OVERLAY_PATH="$PWD/data/ar-dryrun/overlay.json" \
AR_MAPPING_CACHE="$PWD/data/ar-dryrun/mapping-cache.json" \
npx tsx scripts/ar-import-headless.ts
```

`OVERLAY_PATH` is mandatory here for the same reason as Task 1 — without it a dry run writes the live overlay. Re-checksum both real files afterwards.

Expected: `8 file(s)` loaded, exit 0, `data/ar-dryrun/failed/` empty.

- [ ] **Step 4: Cross-check against the independent `_pipeline` figure**

```bash
npx tsx -e "
const s=require('./data/ar-dryrun/portfolio.json');
const ta=s.tenantArrears??{};
const tot=Object.values(ta).reduce((a,b)=>a+b.d30+b.d60+b.d90+b.d90plus,0);
console.log('tenants written:',Object.keys(ta).length,'| total \$'+tot.toFixed(2));
console.log('_pipeline reference: 31 tenants | compare total and active against the _pipeline sheet');
"
```

The written total will be **lower** than the `_pipeline` reference total — review-queue rows are deliberately unwritten. Confirm `written + review ≈` that reference total. **A material unexplained gap is a finding: stop and report it rather than proceeding to a live run.**

- [ ] **Step 5: Full suite and commit**

```bash
npm run typecheck && npm run lint && npm test
git add scripts/ar-import-headless.ts
git commit -m "feat(ar): route all three xlsx delinquency formats through the headless import"
```

---

### Task 6: Live run and scheduling

- [ ] **Step 1: Gabriel reviews the dry-run output**

Present every written attribution and the full review queue. **Do not proceed without explicit approval** — this is the ruled dry-run gate.

- [ ] **Step 2: Confirm the server is stopped, then run live**

```bash
npx tsx -e "fetch('http://localhost:5173').then(()=>{console.log('SERVER UP - STOP IT');process.exit(1)}).catch(()=>console.log('server down - safe'))"
mkdir -p data/ar/inbox
cp "/c/Users/Owner/OneDrive - Oxford Capital Partners/Business/A.R. Reports/"*.xlsx data/ar/inbox/
npx tsx scripts/ar-import-headless.ts
```

Expected: exit 0; `data/overlay.json` → `tenantArrears` non-empty; eight files in `data/ar/processed/`; `data/ar/failed/` empty.

- [ ] **Step 3: Verify the dormant conditions light up**

```bash
npx tsx -e "
const s=require('./data/snapshots/portfolio.json');
const b=s.arBalances??[];
console.log('arBalances:',b.length);
console.log(b.slice(0,5).map(x=>x.tenantName+' \$'+x.total).join('\n'));
"
```

Expected: non-empty, sorted worst-first. `arrears-*` and `ar-stale` now have data.

- [ ] **Step 4: Commit the runtime ignore**

```bash
echo "data/ar/" >> .gitignore
git add .gitignore
git commit -m "chore(ar): gitignore the live AR inbox/processed/failed directories"
```

- [ ] **Step 5: Register the scheduled sweep**

Use the `register-scheduled-task` skill and the supervised `create_scheduled_task` MCP tool — **never** registry JSON splicing. Weekly, after the Monday `ora-master-workbook-ingest` refresh (PM exports are at best biweekly; daily would mostly re-report). The task must copy fresh files from `Business/A.R. Reports/` into the inbox before invoking the sweep, and must not run while the dev server is up. Routing: `ggoldberg@oxfordra.net` only.

- [ ] **Step 6: Verify the fire time and record**

Confirm the registered cron against the live registry, then append one line to `event_log.md` via `python ~/.claude/maintenance/append-event-log.py` — never by editing the header anchor.

---

## Out of Scope

- Convention ledger, calibrated tripwire, run manifest, three-state rendering, outside-in probe — spec v03 Phase 1.
- PM rent-roll ingestion — Phase 2, external dependency on five PM firms.
- Self-managed regime, `property_master` repair (9510 Persimmon absent, `1851-s-club-solar` miscategorized), `mapping-cache.ts` collision fix — Phase 3.
- CAM under-recovery — deferred, no source fields.
- Any change to `_pipeline` beyond a README pointer, and only after Task 5's cross-check passes.
- Splitting Format B's `d30plus` into true 60/90/90+ buckets — the export does not carry the data.
