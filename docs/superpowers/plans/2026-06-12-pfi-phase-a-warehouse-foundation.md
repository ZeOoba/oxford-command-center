# PFI Phase A — Financial Warehouse Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SQLite financial warehouse under `server/warehouse/` that ingests the 32 P&L files in the OneDrive `Property Financials` folder into an immutable, versioned, classified property ledger, with a backfill CLI proving it against real data.

**Architecture:** New `server/warehouse/` domain (better-sqlite3, WAL) beside the existing snapshot pipeline. Flow: detect (filename + content) → parse (QB-style Excel adapter) → map (seed taxonomy from `docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json`) → classify → validate (foot to stated totals) → transactional commit (raw copy + versioned ledger). NOI is *re-derived* from classifications — never taken as stated (owner transfers/distributions/debt service excluded per the ratified canon in `memory/pfi-build-canon.md`).

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — use `import type`), better-sqlite3 (already a dependency), ExcelJS (already a dependency), Zod 3, vitest. No new dependencies.

**Conventions:** Tests in `tests/unit/`, fixture-builder style (see `tests/unit/conditions.test.ts`). Temp dirs via `mkdtempSync(join(tmpdir(), 'wh-'))`. Run a single test file: `npx vitest run tests/unit/<file>.test.ts`. Gate: `npm run gate`. Execution happens in a worktree created via superpowers:using-git-worktrees (never on main); commit after every task.

**Ratified canon constants (do not re-decide):** R&M single item > $5,000 = capex, else opex (assume opex + flag without line detail) · owner transfers never in NOI · AM fees excluded · FVC = entity-level unit · coverage starts 2025 for `3034-westerville-rd-columbus-oh`, `9620-e-state-route-350-raytown-mo`, `2203-2207-northwood-dr-salisbury-md`.

---

### Task 1: Warehouse contracts (`src/contracts/warehouse.ts`)

**Files:**
- Create: `src/contracts/warehouse.ts`
- Test: `tests/unit/warehouse-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-contracts.test.ts
import { describe, expect, it } from 'vitest';
import {
  Classification,
  ImportStatus,
  LedgerEntrySchema,
  NOI_CLASSES,
  PropertyMasterRowSchema,
  RawStatementSchema,
} from '@contracts/warehouse';

describe('warehouse contracts', () => {
  it('accepts a valid property master row', () => {
    const row = PropertyMasterRowSchema.parse({
      id: '1100-rarig-ave-columbus-oh',
      name: '1100 Rarig Ave, Columbus OH',
      market: 'Columbus OH',
      propertyManager: 'Kohr Royer Griffith',
      pmContact: 'Paul Trautman',
      financialMode: 'pnl',
      ownershipPct: 1,
      rentableSf: 21000,
      acquisitionDate: '2023-10-06',
    });
    expect(row.financialMode).toBe('pnl');
  });

  it('rejects an unknown classification', () => {
    expect(() => Classification.parse('operating')).toThrow();
    expect(Classification.parse('opex')).toBe('opex');
  });

  it('NOI classes exclude capex, ti, leasing, debt-service, excluded', () => {
    expect(NOI_CLASSES).toEqual(['revenue', 'recovery', 'other-income', 'opex']);
  });

  it('parses a ledger entry and an import status', () => {
    const e = LedgerEntrySchema.parse({
      importId: 1,
      propertyId: '1100-rarig-ave-columbus-oh',
      period: '2025',
      rawAccount: 'Rent',
      glCode: '5064',
      amount: 111111.11,
      normalizedCategory: 'Rental Revenue',
      classification: 'revenue',
    });
    expect(e.amount).toBeCloseTo(111111.11);
    expect(ImportStatus.parse('pending-review')).toBe('pending-review');
  });

  it('parses a raw statement from an adapter', () => {
    const s = RawStatementSchema.parse({
      propertyRaw: '1100 Rarig Ave',
      periodLabel: '01/01/25 - 12/31/25  (cash basis)',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      grain: 'year',
      basis: 'cash',
      sourceSystem: 'quickbooks',
      accounts: [{ code: '5064', name: 'Rent', section: 'INCOME', parent: 'RENTAL INCOME', total: 111111.11 }],
      totalIncome: 113333.33,
      totalExpense: 25444.44,
    });
    expect(s.accounts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-contracts.test.ts`
Expected: FAIL — cannot resolve `@contracts/warehouse`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/contracts/warehouse.ts
import { z } from 'zod';

export const Classification = z.enum([
  'revenue', 'recovery', 'other-income', 'opex',
  'capex', 'ti', 'leasing', 'debt-service', 'excluded',
]);
export type Classification = z.infer<typeof Classification>;

/** Classes whose active ledger rows participate in NOI: revenue + recovery + other-income − opex. */
export const NOI_CLASSES = ['revenue', 'recovery', 'other-income', 'opex'] as const;

export const Basis = z.enum(['cash', 'accrual', 'tax', 'unknown']);
export const SourceSystem = z.enum(['quickbooks', 'yardi', 'rent-manager', 'appfolio', 'unknown']);
export const PeriodGrain = z.enum(['month', 'year', 'ytd']);
export const ImportStatus = z.enum(['pending-review', 'committed', 'superseded', 'rejected']);
export const FinancialMode = z.enum(['pnl', 'lease-run']);

export const PropertyMasterRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  market: z.string().nullish(),
  address: z.string().nullish(),
  propertyManager: z.string().nullish(),
  pmContact: z.string().nullish(),
  pmPlatform: z.string().nullish(),
  financialMode: FinancialMode.default('pnl'),
  rentableSf: z.number().nonnegative().nullish(),
  acquisitionDate: z.string().nullish(),
  ownershipPct: z.number().gt(0).max(1).default(1),
  ownershipStatus: z.string().default('active'),
  assetClass: z.string().nullish(),
  notes: z.string().nullish(),
});
export type PropertyMasterRow = z.infer<typeof PropertyMasterRowSchema>;

export const RawAccountLineSchema = z.object({
  code: z.string().nullish(),
  name: z.string().min(1),
  section: z.string().min(1),
  parent: z.string().nullish(),
  total: z.number().nullable(),
});
export type RawAccountLine = z.infer<typeof RawAccountLineSchema>;

export const RawStatementSchema = z.object({
  propertyRaw: z.string(),
  periodLabel: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  grain: PeriodGrain,
  basis: Basis,
  sourceSystem: SourceSystem,
  accounts: z.array(RawAccountLineSchema),
  totalIncome: z.number().nullable(),
  totalExpense: z.number().nullable(),
});
export type RawStatement = z.infer<typeof RawStatementSchema>;

export const LedgerEntrySchema = z.object({
  importId: z.number().int(),
  propertyId: z.string().min(1),
  period: z.string().regex(/^\d{4}(-\d{2})?$/),
  rawAccount: z.string().min(1),
  glCode: z.string().nullish(),
  amount: z.number(),
  normalizedCategory: z.string().min(1),
  classification: Classification,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const AccountMappingSchema = z.object({
  account: z.string().min(1),
  code: z.string().nullish(),
  normalized_category: z.string().min(1),
  classification: Classification,
  confidence: z.string().optional(),
  note: z.string().nullish(),
});
export type AccountMapping = z.infer<typeof AccountMappingSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-contracts.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/warehouse.ts tests/unit/warehouse-contracts.test.ts
git commit -m "feat(warehouse): warehouse Zod contracts (classifications, ledger, raw statement)"
```

---

### Task 2: Database module (`server/warehouse/db.ts`)

**Files:**
- Create: `server/warehouse/db.ts`
- Test: `tests/unit/warehouse-db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-db.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';

describe('warehouse db', () => {
  it('creates the schema idempotently and enforces unique file hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'finance.sqlite'));
    const db2 = openWarehouse(join(dir, 'finance.sqlite')); // idempotent re-open
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'account_mappings', 'data_quality_issues', 'import_batches',
        'ledger_entries', 'property_master',
      ]),
    );
    const ins = db.prepare(
      `INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, status, version)
       VALUES (?, ?, ?, ?, 'committed', 1)`,
    );
    ins.run('a.xlsx', 'hash1', '/raw/a', '2026-06-12T00:00:00Z');
    expect(() => ins.run('b.xlsx', 'hash1', '/raw/b', '2026-06-12T00:00:00Z')).toThrow(/UNIQUE/);
    db2.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-db.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/db.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type WarehouseDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS property_master (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT, address TEXT,
  property_manager TEXT, pm_contact TEXT, pm_platform TEXT,
  financial_mode TEXT NOT NULL DEFAULT 'pnl',
  rentable_sf REAL, acquisition_date TEXT,
  ownership_pct REAL NOT NULL DEFAULT 1.0,
  ownership_status TEXT NOT NULL DEFAULT 'active',
  asset_class TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL UNIQUE,
  raw_path TEXT NOT NULL,
  file_source TEXT NOT NULL DEFAULT 'folder',
  imported_at TEXT NOT NULL,
  imported_by TEXT,
  property_id TEXT REFERENCES property_master(id),
  period_start TEXT, period_end TEXT, period_grain TEXT,
  basis TEXT NOT NULL DEFAULT 'unknown',
  source_system TEXT NOT NULL DEFAULT 'unknown',
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  superseded_by INTEGER REFERENCES import_batches(id),
  confidence REAL, detect_notes TEXT
);
CREATE TABLE IF NOT EXISTS account_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_account_key TEXT NOT NULL,
  source_system TEXT,
  normalized_category TEXT NOT NULL,
  classification TEXT NOT NULL,
  match_kind TEXT NOT NULL DEFAULT 'seed',
  property_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mappings_key ON account_mappings(raw_account_key);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES import_batches(id),
  property_id TEXT NOT NULL,
  period TEXT NOT NULL,
  raw_account TEXT NOT NULL,
  gl_code TEXT,
  amount REAL NOT NULL,
  normalized_category TEXT NOT NULL,
  classification TEXT NOT NULL,
  mapping_id INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ledger_prop_period ON ledger_entries(property_id, period, is_active);
CREATE TABLE IF NOT EXISTS data_quality_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER, property_id TEXT,
  kind TEXT NOT NULL, detail TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`;

export function openWarehouse(path: string): WarehouseDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-db.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/db.ts tests/unit/warehouse-db.test.ts
git commit -m "feat(warehouse): sqlite schema + openWarehouse (WAL, idempotent migration)"
```

---

### Task 3: Property master seed (`server/warehouse/property-master.ts`)

The ratified 14-unit canon, hardcoded as the seed (source: `memory/pfi-build-canon.md`). Snapshot ids reused where they exist; `1851-s-club-solar` is synthetic (no roster entry).

**Files:**
- Create: `server/warehouse/property-master.ts`
- Test: `tests/unit/warehouse-property-master.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-property-master.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { CANON_PROPERTIES, seedPropertyMaster } from '../../server/warehouse/property-master';

describe('property master seed', () => {
  it('seeds exactly the ratified 14 units, idempotently', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    seedPropertyMaster(db); // idempotent
    const rows = db.prepare('SELECT * FROM property_master ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(14);
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    expect(byId.get('9050-red-branch-rd-columbia-md')?.ownership_pct).toBe(0.5);
    expect(byId.get('1851-s-club-solar')?.ownership_pct).toBe(0.25);
    expect(byId.get('401-sunburst-hwy-cambridge-md')?.financial_mode).toBe('lease-run');
    expect(byId.get('7658-fishel-dr-n-dublin-oh')?.financial_mode).toBe('lease-run');
    expect(byId.get('1100-rarig-ave-columbus-oh')?.property_manager).toBe('Kohr Royer Griffith');
    expect(byId.get('2203-2207-northwood-dr-salisbury-md')?.property_manager).toBe('SVN');
    expect(byId.has('9510-persimmon-tree-rd-potomac-md')).toBe(false); // residence excluded
    expect(CANON_PROPERTIES).toHaveLength(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-property-master.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/property-master.ts
import type { PropertyMasterRow } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

const KRG = { propertyManager: 'Kohr Royer Griffith', pmContact: 'Paul Trautman' };

/** Gabriel-ratified 2026-06-12 (memory/pfi-build-canon.md). Do not edit without a new ruling. */
export const CANON_PROPERTIES: PropertyMasterRow[] = [
  { id: '3540-e-5th-ave-columbus-oh', name: '3540 E. 5th Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 35886, acquisitionDate: '2022-01-21', assetClass: 'Flex', ...KRG },
  { id: '3034-westerville-rd-columbus-oh', name: '3034 Westerville Rd, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 18000, acquisitionDate: '2024-09-22', assetClass: 'Flex', notes: 'Coverage starts 2025 (ratified).', ...KRG },
  { id: '3875-3883-e-livingston-ave-columbus-oh', name: '3875-3883 E Livingston Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 10950, acquisitionDate: '2025-06-01', assetClass: 'Flex', ...KRG },
  { id: 'sepich-portfolio-columbus-oh-8-props', name: 'FVC — Fairground Village Center / Sepich Portfolio (8 props)', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 110000, acquisitionDate: '2021-03-16', assetClass: 'Flex', notes: 'ENTITY-LEVEL official unit. FVC 2025 contains $500k one-time cell-tower easement sale (exclude from run-rate). Zettler sale dead — still owned.', ...KRG },
  { id: '1100-rarig-ave-columbus-oh', name: '1100 Rarig Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 21000, acquisitionDate: '2023-10-06', assetClass: 'Flex', ...KRG },
  { id: '29000-information-lane-easton-md', name: '29000 Information Lane, Easton MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 48000, acquisitionDate: '2021-01-01', assetClass: 'Flex', propertyManager: 'Thomas Park', pmContact: 'Civita Peters' },
  { id: '9620-e-state-route-350-raytown-mo', name: '9620 E State Route 350, Raytown MO', market: 'Kansas City MO', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 34560, acquisitionDate: '2024-10-22', assetClass: 'Flex', propertyManager: 'Peak Real Estate Partners', pmContact: 'Hank Simpson; Garrett Alejos', notes: 'Coverage starts 2025 (ratified).' },
  { id: '9050-red-branch-rd-columbia-md', name: '9050 Red Branch Rd, Columbia MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 0.5, ownershipStatus: 'active', rentableSf: 90000, acquisitionDate: '2015-08-27', assetClass: 'Flex', propertyManager: 'CRC', pmContact: 'Steve She' },
  { id: '1900-n-broadway-baltimore-md', name: '1900 N Broadway, Baltimore MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 0.5, ownershipStatus: 'active', rentableSf: 27671, acquisitionDate: '2015-08-31', assetClass: 'Retail', propertyManager: 'CRC', pmContact: 'Steve She' },
  { id: '7658-fishel-dr-n-dublin-oh', name: '7658 Fishel Dr N, Dublin OH', market: 'Columbus OH', financialMode: 'lease-run', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 24000, acquisitionDate: '2026-01-29', assetClass: 'Flex', notes: 'Run off master lease with estimated capex (ratified).' },
  { id: '401-sunburst-hwy-cambridge-md', name: '401 Sunburst Hwy, Cambridge MD', market: 'Mid-Atlantic', financialMode: 'lease-run', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 5100, acquisitionDate: '2026-01-26', assetClass: 'Retail', notes: 'Run off master lease with estimated capex (ratified).' },
  { id: '55-new-plant-ct-owings-mills-md', name: '55 New Plant Ct, Owings Mills MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 34534, acquisitionDate: '2016-12-05', assetClass: 'Flex', notes: 'EGFLLC QuickBooks books; distributions-as-expenses defect — engine excludes.' },
  { id: '2203-2207-northwood-dr-salisbury-md', name: '2203-2207 Northwood Dr, Salisbury MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 53700, acquisitionDate: '2024-10-03', assetClass: 'Flex', propertyManager: 'SVN', pmContact: 'Brady Smith', pmPlatform: 'AppFolio', notes: 'Coverage starts 2025 (ratified). AppFolio Cash Flow reports — reclassify owner transfers/interest on ingest.' },
  { id: '1851-s-club-solar', name: '1851 S Club — Solar (25% roof project)', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 0.25, ownershipStatus: 'active', rentableSf: null, acquisitionDate: null, assetClass: 'Solar', notes: 'No real estate owned — 25% roof/solar project (Perfect Settings PPA). Building sold to RLIF East.' },
];

export function seedPropertyMaster(db: WarehouseDb): void {
  const up = db.prepare(`
    INSERT INTO property_master (id, name, market, property_manager, pm_contact, pm_platform,
      financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status, asset_class, notes)
    VALUES (@id, @name, @market, @propertyManager, @pmContact, @pmPlatform,
      @financialMode, @rentableSf, @acquisitionDate, @ownershipPct, @ownershipStatus, @assetClass, @notes)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, market=excluded.market, property_manager=excluded.property_manager,
      pm_contact=excluded.pm_contact, pm_platform=excluded.pm_platform, financial_mode=excluded.financial_mode,
      rentable_sf=excluded.rentable_sf, acquisition_date=excluded.acquisition_date,
      ownership_pct=excluded.ownership_pct, ownership_status=excluded.ownership_status,
      asset_class=excluded.asset_class, notes=excluded.notes, updated_at=datetime('now')
  `);
  const tx = db.transaction((rows: PropertyMasterRow[]) => {
    for (const r of rows) {
      up.run({
        id: r.id, name: r.name, market: r.market ?? null,
        propertyManager: r.propertyManager ?? null, pmContact: r.pmContact ?? null,
        pmPlatform: r.pmPlatform ?? null, financialMode: r.financialMode,
        rentableSf: r.rentableSf ?? null, acquisitionDate: r.acquisitionDate ?? null,
        ownershipPct: r.ownershipPct, ownershipStatus: r.ownershipStatus,
        assetClass: r.assetClass ?? null, notes: r.notes ?? null,
      });
    }
  });
  tx(CANON_PROPERTIES);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-property-master.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/property-master.ts tests/unit/warehouse-property-master.test.ts
git commit -m "feat(warehouse): ratified 14-unit property master seed (canon 2026-06-12)"
```

---

### Task 4: Mapping engine (`server/warehouse/mapping.ts`)

Loads the verified seed JSON into `account_mappings` and resolves raw account names. Key normalization: strip leading GL code, lowercase, collapse whitespace. Precedence: property-specific manual > global manual > seed. Unmapped → `Unmapped`/`opex` with a data-quality issue (assume-expense rule) — NOI-conservative and visible.

**Files:**
- Create: `server/warehouse/mapping.ts`
- Test: `tests/unit/warehouse-mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-mapping.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { accountKey, resolveMapping, seedMappings } from '../../server/warehouse/mapping';

const SEED = {
  mappings: [
    { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
    { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
    { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  ],
};

describe('mapping engine', () => {
  it('normalizes account keys (strips code, case, whitespace)', () => {
    expect(accountKey('          5064 Rent')).toBe('rent');
    expect(accountKey('HVAC  Repair ')).toBe('hvac repair');
  });

  it('seeds and resolves; manual overrides beat seed; unmapped falls back conservatively', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedMappings(db, SEED.mappings);
    const rent = resolveMapping(db, '5064 Rent');
    expect(rent.normalizedCategory).toBe('Rental Revenue');
    expect(rent.classification).toBe('revenue');
    expect(rent.matchKind).toBe('seed');

    db.prepare(
      `INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind)
       VALUES ('rent', 'Other Income', 'other-income', 'manual')`,
    ).run();
    expect(resolveMapping(db, 'Rent').classification).toBe('other-income'); // manual wins

    const unknown = resolveMapping(db, 'Totally New Account');
    expect(unknown.normalizedCategory).toBe('Unmapped');
    expect(unknown.classification).toBe('opex'); // assume-expense rule (ratified), flagged
    expect(unknown.matchKind).toBe('unmapped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-mapping.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/mapping.ts
import { readFileSync } from 'node:fs';
import type { AccountMapping } from '../../src/contracts/warehouse';
import { AccountMappingSchema } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';

export function accountKey(raw: string): string {
  return raw.trim().replace(/^\d[\d.-]*\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

export function seedMappings(db: WarehouseDb, mappings: unknown[]): number {
  const ins = db.prepare(`
    INSERT INTO account_mappings (raw_account_key, normalized_category, classification, match_kind, note)
    VALUES (?, ?, ?, 'seed', ?)
  `);
  const existing = new Set(
    (db.prepare("SELECT raw_account_key FROM account_mappings WHERE match_kind='seed'").all() as Array<{ raw_account_key: string }>)
      .map((r) => r.raw_account_key),
  );
  let count = 0;
  const tx = db.transaction((rows: AccountMapping[]) => {
    for (const m of rows) {
      const key = accountKey(m.account);
      if (existing.has(key)) continue;
      existing.add(key);
      ins.run(key, m.normalized_category, m.classification, m.note ?? null);
      count++;
    }
  });
  tx(mappings.map((m) => AccountMappingSchema.parse(m)));
  return count;
}

export function seedMappingsFromFile(db: WarehouseDb, path: string): number {
  const seed = JSON.parse(readFileSync(path, 'utf8')) as { mappings: unknown[] };
  return seedMappings(db, seed.mappings);
}

export interface ResolvedMapping {
  normalizedCategory: string;
  classification: string;
  matchKind: 'manual' | 'seed' | 'unmapped';
  mappingId: number | null;
}

export function resolveMapping(db: WarehouseDb, rawAccount: string, propertyId?: string): ResolvedMapping {
  const key = accountKey(rawAccount);
  const row = db.prepare(`
    SELECT id, normalized_category, classification, match_kind FROM account_mappings
    WHERE raw_account_key = ? AND (property_id IS NULL OR property_id = ?)
    ORDER BY CASE match_kind WHEN 'manual' THEN 0 WHEN 'learned' THEN 1 ELSE 2 END,
             property_id IS NULL
    LIMIT 1
  `).get(key, propertyId ?? null) as
    | { id: number; normalized_category: string; classification: string; match_kind: string }
    | undefined;
  if (!row) {
    return { normalizedCategory: 'Unmapped', classification: 'opex', matchKind: 'unmapped', mappingId: null };
  }
  return {
    normalizedCategory: row.normalized_category,
    classification: row.classification,
    matchKind: row.match_kind === 'manual' ? 'manual' : 'seed',
    mappingId: row.id,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-mapping.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/mapping.ts tests/unit/warehouse-mapping.test.ts
git commit -m "feat(warehouse): mapping engine (seed load, key normalization, manual-over-seed, conservative unmapped)"
```

---

### Task 5: Filename + period detection (`server/warehouse/detect.ts`)

**Files:**
- Create: `server/warehouse/detect.ts`
- Test: `tests/unit/warehouse-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-detect.test.ts
import { describe, expect, it } from 'vitest';
import { detectFromFilename } from '../../server/warehouse/detect';

describe('filename detection', () => {
  it('parses "P&L <year> -- <token>" forms', () => {
    const d = detectFromFilename('P&L 2025 -- 1100 Rarig.xlsx');
    expect(d).toMatchObject({
      propertyId: '1100-rarig-ave-columbus-oh', year: 2025, grain: 'year', format: 'xlsx',
    });
    expect(d?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('parses YTD and year-first PDF forms', () => {
    expect(detectFromFilename('P&L 2026 YTD -- FVC.xlsx')).toMatchObject({
      propertyId: 'sepich-portfolio-columbus-oh-8-props', year: 2026, grain: 'ytd',
    });
    expect(detectFromFilename('2025 P&L -- 2203-2207 Northwood.pdf')).toMatchObject({
      propertyId: '2203-2207-northwood-dr-salisbury-md', year: 2025, format: 'pdf',
    });
  });

  it('resolves every real staged token', () => {
    const cases: Array<[string, string]> = [
      ['P&L 2024 -- 1851 South Club Solar.xlsm', '1851-s-club-solar'],
      ['P&L 2024 -- 1900 Broadway.xlsx', '1900-n-broadway-baltimore-md'],
      ['P&L 2024 -- 29000 Info Lane.xlsx', '29000-information-lane-easton-md'],
      ['P&L 2024 -- 3540 E 5th.xlsx', '3540-e-5th-ave-columbus-oh'],
      ['P&L 2024 -- 55 New Plant (EGFLLC).xlsx', '55-new-plant-ct-owings-mills-md'],
      ['P&L 2024 -- 9050 Red Branch.xlsx', '9050-red-branch-rd-columbia-md'],
      ['P&L 2025 -- 3034 Westerville.xlsx', '3034-westerville-rd-columbus-oh'],
      ['P&L 2025 -- 3883 Livingston.xlsx', '3875-3883-e-livingston-ave-columbus-oh'],
      ['P&L 2025 -- 9620 State 350.xlsx', '9620-e-state-route-350-raytown-mo'],
    ];
    for (const [file, id] of cases) expect(detectFromFilename(file)?.propertyId).toBe(id);
  });

  it('returns null for non-financial files and unknown tokens', () => {
    expect(detectFromFilename('Lease Tenant 155 LLC -- 55 New Plant Court 10-2022.pdf')).toBeNull();
    const unknown = detectFromFilename('P&L 2025 -- Mystery Building.xlsx');
    expect(unknown?.propertyId).toBeNull();
    expect(unknown?.confidence).toBeLessThan(0.85);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-detect.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/detect.ts

/** Filename token -> property_master id (staged-corpus aliases, audited 2026-06-12). */
export const PROPERTY_ALIASES: Record<string, string> = {
  '1100 rarig': '1100-rarig-ave-columbus-oh',
  '1851 south club solar': '1851-s-club-solar',
  '1851 s club solar': '1851-s-club-solar',
  '1900 broadway': '1900-n-broadway-baltimore-md',
  '29000 info lane': '29000-information-lane-easton-md',
  '3034 westerville': '3034-westerville-rd-columbus-oh',
  '3540 e 5th': '3540-e-5th-ave-columbus-oh',
  '3883 livingston': '3875-3883-e-livingston-ave-columbus-oh',
  '55 new plant (egfllc)': '55-new-plant-ct-owings-mills-md',
  '55 new plant': '55-new-plant-ct-owings-mills-md',
  '9050 red branch': '9050-red-branch-rd-columbia-md',
  '9620 state 350': '9620-e-state-route-350-raytown-mo',
  'fvc': 'sepich-portfolio-columbus-oh-8-props',
  '2203-2207 northwood': '2203-2207-northwood-dr-salisbury-md',
  '401 sunburst': '401-sunburst-hwy-cambridge-md',
  '7658 fishel': '7658-fishel-dr-n-dublin-oh',
};

export interface FilenameDetection {
  propertyId: string | null;
  propertyToken: string;
  year: number;
  grain: 'year' | 'ytd';
  format: 'xlsx' | 'xlsm' | 'csv' | 'pdf';
  confidence: number;
}

// Forms: "P&L 2025 -- token.ext" | "P&L 2026 YTD -- token.ext" | "2025 P&L -- token.ext" | "2026 YTD P&L -- token.ext"
const PATTERNS = [
  /^P&L\s+(?<year>20\d{2})(?<ytd>\s+YTD)?\s*--\s*(?<token>.+)\.(?<ext>xlsx|xlsm|csv|pdf)$/i,
  /^(?<year>20\d{2})(?<ytd>\s+YTD)?\s+P&L\s*--\s*(?<token>.+)\.(?<ext>xlsx|xlsm|csv|pdf)$/i,
];

export function detectFromFilename(fileName: string): FilenameDetection | null {
  for (const re of PATTERNS) {
    const m = fileName.match(re);
    if (!m?.groups) continue;
    const token = m.groups['token']!.trim();
    const year = Number(m.groups['year']);
    const grain = m.groups['ytd'] ? 'ytd' as const : 'year' as const;
    const ext = m.groups['ext']!.toLowerCase() as FilenameDetection['format'];
    const propertyId = PROPERTY_ALIASES[token.toLowerCase()] ?? null;
    return {
      propertyId, propertyToken: token, year, grain, format: ext,
      confidence: propertyId ? 0.95 : 0.4,
    };
  }
  return null; // not a P&L filename (leases, misc) — skip gracefully
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-detect.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/detect.ts tests/unit/warehouse-detect.test.ts
git commit -m "feat(warehouse): filename detection grammar + audited property alias table"
```

---

### Task 6: QB-style Excel parse adapter (`server/warehouse/parse/qb-excel.ts`)

Parses the verified report shape: title rows, `Property: X` header, period line with optional `(cash basis)`, section labels in one column (INCOME/EXPENSE/TOTAL/...), indented leaf accounts with GL codes, `... Total X` subtotal rows (skipped), values in the rightmost numeric column of each row.

**Files:**
- Create: `server/warehouse/parse/qb-excel.ts`
- Test: `tests/unit/warehouse-qb-excel.test.ts` (builds a synthetic fixture with ExcelJS in-test)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-qb-excel.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseQbExcel } from '../../server/warehouse/parse/qb-excel';

async function buildFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 111111.11],
    [null, null, '          5002 Total RENTAL INCOME', 111111.11],
    [null, null, '     5090 MISC INCOME', null],
    [null, null, '          5046 Miscellaneous', 2222.22],
    [null, null, '          5090 Total MISC INCOME', 2222.22],
    [null, 'TOTAL', null, null],
    [null, null, null, 113333.33],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 444.44],
    [null, null, '          6160 Total REPAIR', 444.44],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
    [null, 'TOTAL', null, null],
    [null, null, null, 25444.44],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

describe('qb-excel adapter', () => {
  it('extracts header, basis, leaf accounts (skipping subtotals), sections', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'fixture.xlsx');
    await buildFixture(file);
    const s = await parseQbExcel(file);
    expect(s.propertyRaw).toBe('1100 Rarig Ave');
    expect(s.basis).toBe('cash');
    expect(s.periodStart).toBe('2025-01-01');
    expect(s.periodEnd).toBe('2025-12-31');
    expect(s.grain).toBe('year');
    const names = s.accounts.map((a) => a.name);
    expect(names).toEqual(['Rent', 'Miscellaneous', 'HVAC Repair', 'Distribution to Owner']);
    expect(names.some((n) => /Total/.test(n))).toBe(false);
    const rent = s.accounts[0]!;
    expect(rent.code).toBe('5064');
    expect(rent.section).toBe('INCOME');
    expect(rent.parent).toBe('RENTAL INCOME');
    expect(rent.total).toBeCloseTo(111111.11);
    const dist = s.accounts[3]!;
    expect(dist.section).toBe('NON OPERATING EXPENSE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-qb-excel.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/parse/qb-excel.ts
import ExcelJS from 'exceljs';
import type { RawAccountLine, RawStatement } from '../../../src/contracts/warehouse';
import { RawStatementSchema } from '../../../src/contracts/warehouse';

function cellText(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return cellText(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
  return null;
}

function cellNum(v: ExcelJS.CellValue): number | null {
  if (typeof v === 'number') return v;
  if (v != null && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'number') {
    return (v as { result: number }).result;
  }
  const t = cellText(v);
  if (!t) return null;
  const cleaned = t.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== '' ? n : null;
}

function toIso(mdy: string): string {
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mdy;
  const yy = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${yy}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

const SECTION_RE = /^(INCOME|EXPENSE|TOTAL|NON OPERATING EXPENSE|OPERATING EXPENSES?|REVENUE|OTHER ITEMS)$/i;

export async function parseQbExcel(filePath: string): Promise<RawStatement> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`no worksheet in ${filePath}`);

  let propertyRaw = '';
  let periodLabel = '';
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let basis: RawStatement['basis'] = 'unknown';
  let section = '';
  let parent: string | null = null;
  const accounts: RawAccountLine[] = [];

  ws.eachRow({ includeEmpty: false }, (row) => {
    // gather all non-empty cells in the row
    const texts: Array<{ col: number; text: string }> = [];
    let rowNum: number | null = null;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value);
      if (t && t.trim() !== '') texts.push({ col, text: t });
      const n = cellNum(cell.value);
      if (n !== null) rowNum = n; // rightmost numeric wins
    });
    if (texts.length === 0) return;
    const first = texts[0]!.text.trim();

    // header rows
    const propMatch = first.match(/^Property:\s*(.+)$/i);
    if (propMatch) { propertyRaw = propMatch[1]!.trim(); return; }
    const periodMatch = first.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\((\w+)\s+basis\))?/i);
    if (periodMatch) {
      periodLabel = first;
      periodStart = toIso(periodMatch[1]!);
      periodEnd = toIso(periodMatch[2]!);
      const b = periodMatch[4]?.toLowerCase();
      if (b === 'cash' || b === 'accrual' || b === 'tax') basis = b;
      return;
    }
    // also accept "Jan - Dec 24" style period labels without dates
    if (!periodLabel && /^[A-Z][a-z]{2}\s*-\s*[A-Z][a-z]{2}\s+\d{2}$/.test(first)) { periodLabel = first; return; }

    // section labels (column B in real exports — any short all-caps cell that matches)
    for (const t of texts) {
      const trimmed = t.text.trim();
      if (SECTION_RE.test(trimmed)) { section = trimmed.toUpperCase(); return; }
    }

    // account rows: "     5002 RENTAL INCOME" (group), "          5064 Rent" (leaf), "          5002 Total X" (subtotal)
    const acctCell = texts.find((t) => /^\s/.test(t.text) || /^\d/.test(t.text.trim()));
    if (!acctCell || !section || section === 'TOTAL') return;
    const raw = acctCell.text;
    const indent = (raw.match(/^\s*/)?.[0] ?? '').length;
    const trimmed = raw.trim();
    const m = trimmed.match(/^(?<code>\d[\d.-]*)?\s*(?<name>.+)$/);
    if (!m?.groups) return;
    const name = m.groups['name']!.trim();
    if (/^Total\b/i.test(name) || /\bTotal\b/.test(name.split(/\s+/).slice(0, 2).join(' '))) {
      return; // subtotal row
    }
    if (rowNum === null) {
      // group header (no value) — becomes parent for subsequent leaves
      parent = name.replace(/^\d[\d.-]*\s*/, '');
      return;
    }
    accounts.push({
      code: m.groups['code'] ?? null,
      name,
      section,
      parent,
      total: rowNum,
    });
  });

  const grain: RawStatement['grain'] =
    periodEnd && !/12-31$/.test(periodEnd.slice(5).replace('-', '-')) && periodEnd.slice(5) !== '12-31'
      ? 'ytd' : 'year';

  return RawStatementSchema.parse({
    propertyRaw, periodLabel, periodStart, periodEnd, grain,
    basis, sourceSystem: 'quickbooks',
    accounts, totalIncome: null, totalExpense: null,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-qb-excel.test.ts` — Expected: PASS. (Iterate on the adapter, not the test, until the fixture parses; the fixture mirrors the verified real shape.)

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/parse/qb-excel.ts tests/unit/warehouse-qb-excel.test.ts
git commit -m "feat(warehouse): QB-style Excel parse adapter (header/basis/sections/leaf accounts)"
```

---

### Task 7: Raw store + import versioning (`server/warehouse/raw-store.ts`)

**Files:**
- Create: `server/warehouse/raw-store.ts`
- Test: `tests/unit/warehouse-raw-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-raw-store.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { registerImport, sha256File } from '../../server/warehouse/raw-store';

describe('raw store + versioning', () => {
  it('copies bytes immutably, dedups by hash, versions by (property, period)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    const rawDir = join(dir, 'raw');
    const src = join(dir, 'P&L 2025 -- X.xlsx');
    writeFileSync(src, 'v1-bytes');

    const a = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T00:00:00Z' });
    expect(a.kind).toBe('new');
    if (a.kind !== 'new') throw new Error('expected new');
    expect(a.version).toBe(1);
    expect(readFileSync(a.rawPath, 'utf8')).toBe('v1-bytes');

    // exact duplicate bytes → rejected as duplicate
    const dup = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T01:00:00Z' });
    expect(dup.kind).toBe('duplicate');

    // corrected file, same logical period → version 2; v1 stays on disk and in the table
    writeFileSync(src, 'v2-bytes');
    const b = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T02:00:00Z' });
    if (b.kind !== 'new') throw new Error('expected new');
    expect(b.version).toBe(2);
    const rows = db.prepare('SELECT id, version, status FROM import_batches ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(sha256File(src)).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-raw-store.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/raw-store.ts
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WarehouseDb } from './db';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface RegisterInput {
  sourcePath: string;
  rawDir: string;
  propertyId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grain: string;
  basis: string;
  sourceSystem: string;
  confidence: number;
  importedAt: string;
  importedBy?: string;
  detectNotes?: string;
}

export type RegisterResult =
  | { kind: 'new'; importId: number; version: number; rawPath: string; hash: string }
  | { kind: 'duplicate'; existingImportId: number; hash: string };

export function registerImport(db: WarehouseDb, input: RegisterInput): RegisterResult {
  const hash = sha256File(input.sourcePath);
  const existing = db.prepare('SELECT id FROM import_batches WHERE file_hash = ?').get(hash) as { id: number } | undefined;
  if (existing) return { kind: 'duplicate', existingImportId: existing.id, hash };

  mkdirSync(input.rawDir, { recursive: true });
  const fileName = basename(input.sourcePath);
  const rawPath = join(input.rawDir, `${hash.slice(0, 16)}__${fileName}`);
  copyFileSync(input.sourcePath, rawPath); // immutable copy; never overwritten (hash-named)

  const prior = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM import_batches
    WHERE property_id IS ? AND period_start IS ? AND period_end IS ?
  `).get(input.propertyId, input.periodStart, input.periodEnd) as { v: number };
  const version = prior.v + 1;

  const res = db.prepare(`
    INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, imported_by, property_id,
      period_start, period_end, period_grain, basis, source_system, version, status, confidence, detect_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending-review', ?, ?)
  `).run(
    fileName, hash, rawPath, input.importedAt, input.importedBy ?? null, input.propertyId,
    input.periodStart, input.periodEnd, input.grain, input.basis, input.sourceSystem,
    version, input.confidence, input.detectNotes ?? null,
  );
  return { kind: 'new', importId: Number(res.lastInsertRowid), version, rawPath, hash };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-raw-store.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/raw-store.ts tests/unit/warehouse-raw-store.test.ts
git commit -m "feat(warehouse): immutable raw store (sha256 dedup, per-period versioning)"
```

---

### Task 8: Commit pipeline (`server/warehouse/ingest.ts`)

Orchestrates detect → parse → map → ledger insert → supersede prior versions, in one transaction. Auto-commit at confidence ≥ 0.85 with no validation errors; otherwise stays `pending-review`. Unmapped accounts and excluded-class anomalies create `data_quality_issues` rows.

**Files:**
- Create: `server/warehouse/ingest.ts`
- Test: `tests/unit/warehouse-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/warehouse-ingest.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

async function writeFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 5000],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

describe('ingest pipeline', () => {
  it('commits a confident file: versioned import, classified ledger, NOI excludes distributions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const ledger = db.prepare(
      "SELECT raw_account, classification, amount FROM ledger_entries WHERE is_active=1 ORDER BY raw_account",
    ).all() as Array<{ raw_account: string; classification: string; amount: number }>;
    expect(ledger).toHaveLength(3);

    // NOI from active NOI-class rows only: 100000 (revenue) - 5000 (opex) = 95000; distribution excluded
    const noi = db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1 AND property_id = '1100-rarig-ave-columbus-oh' AND period = '2025'
    `).get() as { noi: number };
    expect(noi.noi).toBe(95000);
  });

  it('re-import of a corrected file supersedes prior ledger rows (rollback-able, never deleted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });

    // corrected file: different bytes (regenerate with one changed amount)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0]!;
    ws.getCell('D6').value = 110000; // Rent corrected
    await wb.xlsx.writeFile(file);

    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(r2.status).toBe('committed');
    expect(r2.version).toBe(2);

    const active = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=1").get() as { c: number };
    const inactive = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=0").get() as { c: number };
    expect(active.c).toBe(3);
    expect(inactive.c).toBe(3); // v1 preserved, deactivated
    const v1 = db.prepare("SELECT status FROM import_batches WHERE version=1").get() as { status: string };
    expect(v1.status).toBe('superseded');
  });

  it('unmapped accounts flag data quality and downgrade to pending-review', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED.slice(0, 1)); // only Rent mapped
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const issues = db.prepare("SELECT kind FROM data_quality_issues").all() as Array<{ kind: string }>;
    expect(issues.map((i) => i.kind)).toContain('unmapped-account');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/warehouse-ingest.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// server/warehouse/ingest.ts
import { basename } from 'node:path';
import { detectFromFilename } from './detect';
import type { WarehouseDb } from './db';
import { resolveMapping } from './mapping';
import { parseQbExcel } from './parse/qb-excel';
import { registerImport } from './raw-store';

export interface IngestOptions {
  rawDir: string;
  importedAt: string;
  importedBy?: string;
  autoCommitThreshold?: number; // ratified default 0.85
}

export interface IngestResult {
  file: string;
  status: 'committed' | 'pending-review' | 'duplicate' | 'skipped' | 'needs-adapter';
  importId?: number;
  version?: number;
  reason?: string;
  unmapped?: string[];
}

export async function ingestFile(db: WarehouseDb, filePath: string, opts: IngestOptions): Promise<IngestResult> {
  const fileName = basename(filePath);
  const det = detectFromFilename(fileName);
  if (!det) return { file: fileName, status: 'skipped', reason: 'not a P&L filename' };
  if (det.format === 'pdf' || det.format === 'csv') {
    return { file: fileName, status: 'needs-adapter', reason: `${det.format} adapter not in Phase A` };
  }

  const stmt = await parseQbExcel(filePath);
  const periodStart = stmt.periodStart ?? `${det.year}-01-01`;
  const periodEnd = stmt.periodEnd ?? (det.grain === 'year' ? `${det.year}-12-31` : null);
  const period = String(det.year);

  const reg = registerImport(db, {
    sourcePath: filePath, rawDir: opts.rawDir,
    propertyId: det.propertyId, periodStart, periodEnd,
    grain: det.grain, basis: stmt.basis, sourceSystem: stmt.sourceSystem,
    confidence: det.confidence, importedAt: opts.importedAt, importedBy: opts.importedBy,
    detectNotes: `token=${det.propertyToken}; propertyRaw=${stmt.propertyRaw}`,
  });
  if (reg.kind === 'duplicate') {
    return { file: fileName, status: 'duplicate', importId: reg.existingImportId };
  }

  const unmapped: string[] = [];
  const insLedger = db.prepare(`
    INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount,
      normalized_category, classification, mapping_id, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insIssue = db.prepare(`
    INSERT INTO data_quality_issues (import_id, property_id, kind, detail, severity) VALUES (?, ?, ?, ?, ?)
  `);

  const threshold = opts.autoCommitThreshold ?? 0.85;
  const tx = db.transaction(() => {
    for (const a of stmt.accounts) {
      if (a.total === null) continue;
      const m = resolveMapping(db, a.name, det.propertyId ?? undefined);
      if (m.matchKind === 'unmapped') {
        unmapped.push(a.name);
        insIssue.run(reg.importId, det.propertyId, 'unmapped-account', `${a.name} (section ${a.section}) defaulted to Unmapped/opex`, 'warn');
      }
      insLedger.run(reg.importId, det.propertyId ?? 'unknown', period, a.name, a.code ?? null, a.total, m.normalizedCategory, m.classification, m.mappingId);
    }
    const commit = det.propertyId !== null && det.confidence >= threshold && unmapped.length === 0;
    if (commit) {
      // supersede prior committed versions for the same logical period
      const priors = db.prepare(`
        SELECT id FROM import_batches
        WHERE property_id = ? AND period_start IS ? AND period_end IS ? AND id != ? AND status = 'committed'
      `).all(det.propertyId, periodStart, periodEnd, reg.importId) as Array<{ id: number }>;
      for (const p of priors) {
        db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(p.id);
        db.prepare("UPDATE import_batches SET status = 'superseded', superseded_by = ? WHERE id = ?").run(reg.importId, p.id);
      }
      db.prepare("UPDATE import_batches SET status = 'committed' WHERE id = ?").run(reg.importId);
    } else {
      // pending-review rows are not active until approved
      db.prepare("UPDATE ledger_entries SET is_active = 0 WHERE import_id = ?").run(reg.importId);
    }
    return commit;
  });
  const committed = tx();

  return {
    file: fileName,
    status: committed ? 'committed' : 'pending-review',
    importId: reg.importId,
    version: reg.version,
    unmapped: unmapped.length ? unmapped : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/warehouse-ingest.test.ts` — Expected: PASS (3 tests). Note the second test expects active=3/inactive=3 — the v2 commit must activate v2 rows and deactivate v1 rows.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/ingest.ts tests/unit/warehouse-ingest.test.ts
git commit -m "feat(warehouse): transactional ingest (detect->parse->map->ledger, versioned supersede, DQ flags)"
```

---

### Task 9: Backfill CLI (`scripts/warehouse-backfill.ts`)

**Files:**
- Create: `scripts/warehouse-backfill.ts`
- Modify: `package.json` (add script `"warehouse:backfill": "tsx scripts/warehouse-backfill.ts"`)

- [ ] **Step 1: Write the CLI** (thin orchestration over tested modules — no unit test; the live run is the verification)

```typescript
// scripts/warehouse-backfill.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(process.cwd(), 'data', 'warehouse', 'raw');
const SEED_PATH = join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-12-pfi-account-mapping-seed.json');

async function main(): Promise<void> {
  const db = openWarehouse(DB_PATH);
  seedPropertyMaster(db);
  const seeded = seedMappingsFromFile(db, SEED_PATH);
  console.log(`property master seeded (14 units); ${seeded} new seed mappings loaded`);

  const files = readdirSync(FINANCIALS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const counts: Record<string, number> = {};
  for (const f of files) {
    const r = await ingestFile(db, join(FINANCIALS_DIR, f), {
      rawDir: RAW_DIR,
      importedAt: new Date().toISOString(),
      importedBy: 'warehouse-backfill',
    });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const extra = r.unmapped ? ` unmapped=[${r.unmapped.join('; ')}]` : '';
    console.log(`${r.status.padEnd(15)} v${r.version ?? '-'} ${r.file}${extra}`);
  }
  console.log('\nSummary:', JSON.stringify(counts));

  const noi = db.prepare(`
    SELECT property_id, period,
      ROUND(SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                     WHEN classification='opex' THEN -amount ELSE 0 END), 2) AS noi
    FROM ledger_entries WHERE is_active = 1
    GROUP BY property_id, period ORDER BY property_id, period
  `).all();
  console.table(noi);
  db.close();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the backfill against the real folder**

Run: `npm run warehouse:backfill`
Expected: ~30 Excel files `committed` or `pending-review` (pending only where unmapped accounts or low confidence), 2 Northwood PDFs `needs-adapter`, 6 lease PDFs in the subfolder ignored (readdir is non-recursive), and a per-property/period NOI table that is *plausible* (Rarig 2024 NOI ≈ 105–106k — i.e., the stated 80.6k net income PLUS the excluded 25k distribution).

- [ ] **Step 3: Re-run to verify idempotency**

Run: `npm run warehouse:backfill` again — Expected: every file reports `duplicate`; ledger row counts unchanged.

- [ ] **Step 4: Verify data/warehouse is gitignored**

`data/` artifacts must not be committed. Check `.gitignore` covers `data/warehouse/` (the repo already ignores overlay/snapshots; add `data/warehouse/` if missing).

- [ ] **Step 5: Commit**

```bash
git add scripts/warehouse-backfill.ts package.json .gitignore
git commit -m "feat(warehouse): backfill CLI + npm script; gitignore warehouse data"
```

---

### Task 10: Gate + changelog

- [ ] **Step 1:** Run `npm run gate` — Expected: typecheck 0, lint 0, all tests green (existing 271+ plus new warehouse suites), reconcile PASS.
- [ ] **Step 2:** Add a CHANGELOG.md entry under a new "PFI Phase A" heading: warehouse foundation (schema, property master canon, mapping engine, QB-Excel adapter, raw store/versioning, ingest pipeline, backfill CLI).
- [ ] **Step 3:** Commit: `git commit -am "docs: changelog for PFI Phase A warehouse foundation"`.

---

## Out of scope for this plan (next plans)

- **Imports/Data-Quality UI module** (Phase A.2): review queue (approve/correct/reject `pending-review` imports), audit trail view, mapping-override editor.
- **AppFolio cash-flow PDF adapter** (Northwood) and lease-run pro formas (Sunburst/Fishel) — Phase B inputs.
- **Layer 4 metrics + analytics engine wiring** (`period_metrics`), per the architecture spec §10 — Phase B.
- **Brain server route exposure** (`/api/warehouse/*`) — lands with the UI plan.

## Self-review notes

- Spec coverage: Layers 1–3 + property master + versioning + dedup + classification + backfill all have tasks; Layers 4–5 and UI are explicitly deferred (rollout phases B–D).
- Types: `RawStatement`/`RawAccountLine`/`LedgerEntry` defined in Task 1 and used consistently in Tasks 6/8; `WarehouseDb` exported from Task 2 and imported by 3/4/7/8.
- The ingest test's NOI assertion enforces the single most important canon rule (owner transfers/distributions never in NOI) at the pipeline level, not just in mapping data.
