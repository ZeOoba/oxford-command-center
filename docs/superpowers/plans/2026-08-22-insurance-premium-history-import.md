# Insurance Premium History Import (Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--policies` mode to `scripts/import-insurance-data.ts` that upserts multi-year insurance premium history into `property_insurance_policies` from the `ora-insurance-premium-dashboard` Cowork artifact, then run it against the live warehouse with a fully source-cited 13-row payload.

**Architecture:** Same shape as the file's existing two modes (`parseXPayload` pure function → `importXRows` DB function → thin CLI wrapper), extended with an upsert-that-preserves-deductible semantic (§5 of the design spec) and a soft unrecognized-`property_id` check (§6) since this table has no FK to lean on.

**Tech Stack:** TypeScript, `better-sqlite3` via `server/warehouse/db.ts`'s `openWarehouse`/`WarehouseDb`, `vitest`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-22-insurance-premium-history-import-design.md` (commit `55c1547`).
- `UNIQUE(property_id, policy_number, effective_date)` on `property_insurance_policies` — unchanged, no migration.
- Never use `INSERT OR REPLACE` for this table — it mints a new `id` and silently wipes any `deductible`/`coverage_limit` already applied by `--dec-pages`.
- `property_id` has no FK — a typo must be caught in application code (§6), not the database.
- Claim slug `oxford-command-center-data` is held by this session, scoped to `scripts/import-insurance-data.ts`, `tests/unit/import-insurance-data.test.ts`, and this plan's new data file. Re-check `git status`/`git log -1` immediately before every commit — 9 unrelated modified files belonging to another session are in this tree; never stage them.
- Isolated commits only (`git add -- <exact paths>`), no push without Gabriel's confirmation.

---

### Task 1: `parsePoliciesPayload` — pure validation

**Files:**
- Modify: `scripts/import-insurance-data.ts` (append after the dec-pages section, before the `// ── CLI ──` divider)
- Test: `tests/unit/import-insurance-data.test.ts` (new `describe` block after `parseDecPagesPayload — deductible must not exceed coverageLimit`)

**Interfaces:**
- Produces: `ParsedPolicyRow` (fields: `propertyId, insurer, policyNumber, effectiveDate, expirationDate, premiumAnnual, coverageTiv, policyType, source, sourceDate` — types below), `ParsePoliciesOutcome { rows: ParsedPolicyRow[]; rejected: RejectedRow[] }`, `parsePoliciesPayload(payload: unknown, defaultSource: string): ParsePoliciesOutcome`. `RejectedRow` and `isRecord` already exist in this file — reuse them.

- [ ] **Step 1: Write the failing tests**

Insert into `tests/unit/import-insurance-data.test.ts`, after the existing `parseDecPagesPayload — deductible must not exceed coverageLimit` block (before `describe('importDecPageRows / importDecPages'`) and add `parsePoliciesPayload` to the import list from `'../../scripts/import-insurance-data'`:

```typescript
describe('parsePoliciesPayload', () => {
  const base = {
    propertyId: 'ins-3540fifth-pckg',
    insurer: 'Erie Insurance',
    policyNumber: 'Q61-0159747',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: 9478,
    coverageTiv: 4393500,
    policyType: 'Package (PCKG)',
    sourceDate: '2026-08-17',
  };

  it('parses a well-formed policy row', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [base] }, 'default-source.json');
    expect(rejected).toEqual([]);
    expect(rows).toEqual([{ ...base, source: 'default-source.json' }]);
  });

  it('uses a per-row source over the top-level default', () => {
    const { rows } = parsePoliciesPayload(
      { policies: [{ ...base, source: 'row-specific.pdf' }] }, 'default-source.json',
    );
    expect(rows[0].source).toBe('row-specific.pdf');
  });

  it('rejects a row missing propertyId', () => {
    const { propertyId, ...rest } = base;
    const { rows, rejected } = parsePoliciesPayload({ policies: [rest] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: 0, id: null, reason: 'missing or invalid "propertyId"' }]);
  });

  it('rejects a non-ISO effectiveDate', () => {
    const { rows, rejected } = parsePoliciesPayload(
      { policies: [{ ...base, effectiveDate: '01/20/2024' }] }, 'd',
    );
    expect(rows).toEqual([]);
    expect(rejected[0].reason).toMatch(/effectiveDate must be ISO YYYY-MM-DD/);
  });

  it('rejects a non-ISO expirationDate when present', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, expirationDate: '1/20/2025' }] }, 'd');
    expect(rejected[0].reason).toMatch(/expirationDate must be ISO YYYY-MM-DD/);
  });

  it('accepts a null expirationDate', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, expirationDate: null }] }, 'd');
    expect(rejected).toEqual([]);
    expect(rows[0].expirationDate).toBeNull();
  });

  it('rejects a negative premiumAnnual', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, premiumAnnual: -1 }] }, 'd');
    expect(rejected[0].reason).toMatch(/premiumAnnual must be a nonnegative number/);
  });

  it('accepts a null coverageTiv (bcl/umbrella lines carry no TIV)', () => {
    const { rows, rejected } = parsePoliciesPayload({ policies: [{ ...base, coverageTiv: null }] }, 'd');
    expect(rejected).toEqual([]);
    expect(rows[0].coverageTiv).toBeNull();
  });

  it('rejects a negative coverageTiv when present', () => {
    const { rejected } = parsePoliciesPayload({ policies: [{ ...base, coverageTiv: -1 }] }, 'd');
    expect(rejected[0].reason).toMatch(/coverageTiv must be a nonnegative number/);
  });

  it('rejects a payload with no "policies" array', () => {
    const { rows, rejected } = parsePoliciesPayload({ notPolicies: [] }, 'd');
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ index: -1, id: null, reason: 'payload must be an object with a "policies" array' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts -t parsePoliciesPayload`
Expected: FAIL — `parsePoliciesPayload is not a function` (not yet exported from `scripts/import-insurance-data.ts`, and not yet imported in the test file's import list).

- [ ] **Step 3: Add `parsePoliciesPayload` to the test file's imports**

In `tests/unit/import-insurance-data.test.ts`, change:

```typescript
import {
  parseLossEventsPayload,
  importLossEventRows,
  importLossRuns,
  parseDecPagesPayload,
  importDecPageRows,
  importDecPages,
  parseArgs,
} from '../../scripts/import-insurance-data';
```

to:

```typescript
import {
  parseLossEventsPayload,
  importLossEventRows,
  importLossRuns,
  parseDecPagesPayload,
  importDecPageRows,
  importDecPages,
  parsePoliciesPayload,
  importPolicyRows,
  importPolicies,
  parseArgs,
} from '../../scripts/import-insurance-data';
```

(`importPolicyRows`/`importPolicies` are added now so Task 3's import doesn't need a second edit to this block.)

- [ ] **Step 4: Implement `parsePoliciesPayload`**

In `scripts/import-insurance-data.ts`, insert this new section after the `// ── Dec pages ──` section's last function (`parseDecPagesPayload`) and before `export interface ImportDecPagesResult`... actually: insert it as its own section, immediately **before** the `// ── CLI ──────` divider comment, so it sits after all three data-mode sections:

```typescript
// ── Policies (premium history) ──────────────────────────────────────────────────────────────

export interface ParsedPolicyRow {
  propertyId: string;
  insurer: string;
  policyNumber: string;
  effectiveDate: string;
  expirationDate: string | null;
  premiumAnnual: number;
  coverageTiv: number | null;
  policyType: string;
  source: string;
  sourceDate: string;
}

export interface ParsePoliciesOutcome {
  rows: ParsedPolicyRow[];
  rejected: RejectedRow[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse + validate the policies JSON payload. Pure — no DB, no I/O. Exported for tests.
 * Mirrors parseLossEventsPayload's per-row source fallback: a row's own `source` wins, else the
 * payload's top-level `source`, else the CLI's file-path argument (passed in as `defaultSource`).
 */
export function parsePoliciesPayload(payload: unknown, defaultSource: string): ParsePoliciesOutcome {
  const rows: ParsedPolicyRow[] = [];
  const rejected: RejectedRow[] = [];

  if (!isRecord(payload) || !Array.isArray(payload.policies)) {
    rejected.push({ index: -1, id: null, reason: 'payload must be an object with a "policies" array' });
    return { rows, rejected };
  }

  const topLevelSource = typeof payload.source === 'string' && payload.source !== '' ? payload.source : undefined;
  const fallbackSource = topLevelSource ?? defaultSource;

  payload.policies.forEach((raw: unknown, index: number) => {
    if (!isRecord(raw)) {
      rejected.push({ index, id: null, reason: 'row is not an object' });
      return;
    }
    const {
      propertyId, insurer, policyNumber, effectiveDate, expirationDate,
      premiumAnnual, coverageTiv, policyType, source, sourceDate,
    } = raw;

    if (typeof propertyId !== 'string' || propertyId === '') {
      rejected.push({ index, id: null, reason: 'missing or invalid "propertyId"' });
      return;
    }
    if (typeof insurer !== 'string' || insurer === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "insurer"' });
      return;
    }
    if (typeof policyNumber !== 'string' || policyNumber === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "policyNumber"' });
      return;
    }
    if (typeof effectiveDate !== 'string' || !ISO_DATE_RE.test(effectiveDate)) {
      rejected.push({ index, id: propertyId, reason: `effectiveDate must be ISO YYYY-MM-DD, got '${String(effectiveDate)}'` });
      return;
    }
    if (expirationDate !== undefined && expirationDate !== null
      && (typeof expirationDate !== 'string' || !ISO_DATE_RE.test(expirationDate))) {
      rejected.push({ index, id: propertyId, reason: `expirationDate must be ISO YYYY-MM-DD when present, got '${String(expirationDate)}'` });
      return;
    }
    if (typeof premiumAnnual !== 'number' || !Number.isFinite(premiumAnnual) || premiumAnnual < 0) {
      rejected.push({ index, id: propertyId, reason: `premiumAnnual must be a nonnegative number, got '${String(premiumAnnual)}'` });
      return;
    }
    if (coverageTiv !== undefined && coverageTiv !== null
      && (typeof coverageTiv !== 'number' || !Number.isFinite(coverageTiv) || coverageTiv < 0)) {
      rejected.push({ index, id: propertyId, reason: `coverageTiv must be a nonnegative number when present, got '${String(coverageTiv)}'` });
      return;
    }
    if (typeof policyType !== 'string' || policyType === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "policyType"' });
      return;
    }
    if (typeof sourceDate !== 'string' || sourceDate === '') {
      rejected.push({ index, id: propertyId, reason: 'missing or invalid "sourceDate"' });
      return;
    }

    rows.push({
      propertyId,
      insurer,
      policyNumber,
      effectiveDate,
      expirationDate: typeof expirationDate === 'string' ? expirationDate : null,
      premiumAnnual,
      coverageTiv: typeof coverageTiv === 'number' ? coverageTiv : null,
      policyType,
      source: typeof source === 'string' && source !== '' ? source : fallbackSource,
      sourceDate,
    });
  });

  return { rows, rejected };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts -t parsePoliciesPayload`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add -- scripts/import-insurance-data.ts tests/unit/import-insurance-data.test.ts
git commit -m "feat(insurance): add parsePoliciesPayload for premium-history import"
```

---

### Task 2: `importPolicyRows` — upsert preserving `deductible`/`coverage_limit`

**Files:**
- Modify: `scripts/import-insurance-data.ts`
- Test: `tests/unit/import-insurance-data.test.ts`

**Interfaces:**
- Consumes: `ParsedPolicyRow` (Task 1), `WarehouseDb` (from `server/warehouse/db`).
- Produces: `ImportPolicyRowsResult { inserted: number; updated: number; unrecognized: number; rejected: number }`, `importPolicyRows(db: WarehouseDb, rows: ParsedPolicyRow[], ingestedBy: string, newLines?: string[]): ImportPolicyRowsResult`.

- [ ] **Step 1: Write the failing tests**

Insert a new `describe` block in `tests/unit/import-insurance-data.test.ts`, after `importDecPageRows / importDecPages` and before `parseArgs`:

```typescript
describe('importPolicyRows', () => {
  const rowFor = (propertyId: string, overrides: Partial<Parameters<typeof parsePoliciesPayload>[0]> = {}) => ({
    propertyId,
    insurer: 'Erie Insurance',
    policyNumber: 'Q61-0159747',
    effectiveDate: '2024-01-20',
    expirationDate: '2025-01-20',
    premiumAnnual: 9478,
    coverageTiv: 4393500,
    policyType: 'Package (PCKG)',
    source: 'test-source.pdf',
    sourceDate: '2026-08-17',
    ...overrides,
  });

  it('inserts a new row for a recognized existing property line', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg'); // establishes the line as "known" (no FK — presence is the signal)

    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });

    const inserted = db.prepare(
      `SELECT premium_annual, coverage_tiv FROM property_insurance_policies
       WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'Q61-0159747', '2024-01-20') as { premium_annual: number; coverage_tiv: number };
    expect(inserted.premium_annual).toBe(9478);
    expect(inserted.coverage_tiv).toBe(4393500);
  });

  it('inserts a new line id when explicitly allowlisted via newLines', () => {
    const db = freshDb();
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-9620state350-umb')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite', ['ins-9620state350-umb']);
    expect(result).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });
  });

  it('records an unrecognized, non-allowlisted propertyId as a data_quality_issues row and skips it', () => {
    const db = freshDb();
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-typo-pckg')] }, 'd');
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 0, updated: 0, unrecognized: 1, rejected: 0 });

    const dq = db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'insurance-policy-unrecognized-line'`)
      .get() as { detail: string };
    expect(dq.detail).toMatch(/ins-typo-pckg/);

    const written = db.prepare('SELECT COUNT(*) c FROM property_insurance_policies WHERE property_id = ?')
      .get('ins-typo-pckg') as { c: number };
    expect(written.c).toBe(0);
  });

  // The core design decision (spec §5): a re-run for the SAME (property_id, policy_number,
  // effective_date) key must UPDATE the existing row's id, never delete-and-reinsert — otherwise
  // any deductible/coverage_limit already applied by --dec-pages is silently wiped.
  it('updates an existing row on a matching key WITHOUT touching a previously-set deductible', () => {
    const db = freshDb();
    const policyId = insertPolicy(db, 'ins-3540fifth-pckg');
    db.prepare(`
      UPDATE property_insurance_policies
      SET policy_number = 'Q61-0159747', effective_date = '2024-01-20', premium_annual = 1, deductible = 25000, coverage_limit = 5000000
      WHERE id = ?
    `).run(policyId);

    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd'); // premiumAnnual: 9478
    const result = importPolicyRows(db, rows, 'test-suite');
    expect(result).toEqual({ inserted: 0, updated: 1, unrecognized: 0, rejected: 0 });

    const row = db.prepare('SELECT id, premium_annual, deductible, coverage_limit FROM property_insurance_policies WHERE id = ?')
      .get(policyId) as { id: number; premium_annual: number; deductible: number; coverage_limit: number };
    expect(row.id).toBe(policyId); // same row, not delete-and-reinsert
    expect(row.premium_annual).toBe(9478); // updated
    expect(row.deductible).toBe(25000); // preserved
    expect(row.coverage_limit).toBe(5000000); // preserved
  });

  it('is idempotent: importing the same file twice reports the second run as all-updated, zero duplicates', () => {
    const db = freshDb();
    insertPolicy(db, 'ins-3540fifth-pckg');
    const { rows } = parsePoliciesPayload({ policies: [rowFor('ins-3540fifth-pckg')] }, 'd');

    const first = importPolicyRows(db, rows, 'test-suite');
    expect(first).toEqual({ inserted: 1, updated: 0, unrecognized: 0, rejected: 0 });

    const second = importPolicyRows(db, rows, 'test-suite');
    expect(second).toEqual({ inserted: 0, updated: 1, unrecognized: 0, rejected: 0 });

    const count = db.prepare(
      `SELECT COUNT(*) c FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?`,
    ).get('ins-3540fifth-pckg', 'Q61-0159747', '2024-01-20') as { c: number };
    expect(count.c).toBe(2); // the fixture row from insertPolicy (blank key) + the one row this test wrote
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts -t importPolicyRows`
Expected: FAIL — `importPolicyRows is not a function`.

- [ ] **Step 3: Implement `importPolicyRows`**

Append immediately after `parsePoliciesPayload` in `scripts/import-insurance-data.ts`:

```typescript
export interface ImportPolicyRowsResult {
  inserted: number;
  updated: number;
  unrecognized: number;
  rejected: number;
}

/**
 * Upsert parsed+validated policy rows into property_insurance_policies. property_id has NO FK
 * (unlike property_tax_assessments/insurance_loss_events), so "recognized" means "an existing row
 * with this property_id already exists" OR "explicitly allowlisted via newLines for this run" —
 * the only two ways this importer will ever mint a property_id, matching the design's identity
 * rule (spec §4.1: reuse an existing line's id, mint a new one only for a genuinely new line).
 *
 * On a (property_id, policy_number, effective_date) match, UPDATE by that row's own `id` rather
 * than INSERT OR REPLACE — REPLACE deletes-and-reinserts under an AUTOINCREMENT PK, which would
 * mint a fresh id and silently null out any deductible/coverage_limit --dec-pages already applied
 * (spec §5). deductible/coverage_limit are never touched by this importer either way.
 */
export function importPolicyRows(
  db: WarehouseDb,
  rows: ParsedPolicyRow[],
  ingestedBy: string,
  newLines: string[] = [],
): ImportPolicyRowsResult {
  const knownPropertyIds = new Set(
    (db.prepare('SELECT DISTINCT property_id FROM property_insurance_policies').all() as { property_id: string }[])
      .map((r) => r.property_id),
  );
  const allowedNewLines = new Set(newLines);

  const findExisting = db.prepare(`
    SELECT id FROM property_insurance_policies WHERE property_id = ? AND policy_number = ? AND effective_date = ?
  `);
  const update = db.prepare(`
    UPDATE property_insurance_policies
    SET insurer = ?, expiration_date = ?, premium_annual = ?, coverage_tiv = ?, policy_type = ?,
        source = ?, source_date = ?, ingested_by = ?, ingested_at = datetime('now')
    WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO property_insurance_policies
      (property_id, insurer, policy_number, effective_date, expiration_date, premium_annual,
       coverage_tiv, policy_type, source, source_date, ingested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDqUnrecognized = db.prepare(`
    INSERT INTO data_quality_issues (property_id, kind, detail, severity)
    VALUES (?, 'insurance-policy-unrecognized-line', ?, 'warn')
  `);

  let inserted = 0;
  let updated = 0;
  let unrecognized = 0;
  let rejected = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!knownPropertyIds.has(r.propertyId) && !allowedNewLines.has(r.propertyId)) {
        unrecognized += 1;
        insertDqUnrecognized.run(
          r.propertyId,
          `import-insurance-data --policies: property_id '${r.propertyId}' has no existing policy line and is not in this run's newLines allowlist — row skipped`,
        );
        continue; // this row's own failure must never block any other row in the batch
      }
      try {
        const existing = findExisting.get(r.propertyId, r.policyNumber, r.effectiveDate) as { id: number } | undefined;
        if (existing) {
          update.run(
            r.insurer, r.expirationDate, r.premiumAnnual, r.coverageTiv, r.policyType,
            r.source, r.sourceDate, ingestedBy, existing.id,
          );
          updated += 1;
        } else {
          insert.run(
            r.propertyId, r.insurer, r.policyNumber, r.effectiveDate, r.expirationDate,
            r.premiumAnnual, r.coverageTiv, r.policyType, r.source, r.sourceDate, ingestedBy,
          );
          inserted += 1;
          knownPropertyIds.add(r.propertyId); // a newLines row counts as known for a later row in this same batch
        }
      } catch (e) {
        rejected += 1;
        const detail = e instanceof Error ? e.message : String(e);
        console.warn(`import-insurance-data --policies: row for '${r.propertyId}' (${r.policyNumber}, ${r.effectiveDate}) failed: ${detail}`);
      }
    }
  });
  tx();

  return { inserted, updated, unrecognized, rejected };
}

/** Combined parse+import entry point used by the CLI. */
export function importPolicies(db: WarehouseDb, payload: unknown, defaultSource: string): ImportPolicyRowsResult {
  const { rows, rejected } = parsePoliciesPayload(payload, defaultSource);
  const newLines = isRecord(payload) && Array.isArray(payload.newLines)
    ? payload.newLines.filter((x): x is string => typeof x === 'string')
    : [];
  const ingestedBy = isRecord(payload) && typeof payload.ingestedBy === 'string' && payload.ingestedBy !== ''
    ? payload.ingestedBy
    : 'import-insurance-data.ts --policies';
  const dbResult = importPolicyRows(db, rows, ingestedBy, newLines);
  return {
    inserted: dbResult.inserted,
    updated: dbResult.updated,
    unrecognized: dbResult.unrecognized,
    rejected: rejected.length + dbResult.rejected,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts -t importPolicyRows`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -- scripts/import-insurance-data.ts tests/unit/import-insurance-data.test.ts
git commit -m "feat(insurance): add importPolicyRows with deductible-preserving upsert"
```

---

### Task 3: Wire the `--policies` CLI mode

**Files:**
- Modify: `scripts/import-insurance-data.ts` (the `// ── CLI ──` section: `CliArgs`, `parseArgs`, `main`)
- Test: `tests/unit/import-insurance-data.test.ts`

**Interfaces:**
- Consumes: `importPolicies` (Task 2).
- Produces: `CliArgs.mode` widened to include `'policies'`.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('parseArgs', ...)` block in `tests/unit/import-insurance-data.test.ts`:

```typescript
  it('parses --policies <path> as policies mode', () => {
    const args = parseArgs(['--policies', 'policies.json']);
    expect(args).toEqual({ mode: 'policies', filePath: 'policies.json', db: undefined });
  });

  it('combines --policies with --db', () => {
    const args = parseArgs(['--policies', 'policies.json', '--db', '/tmp/test.sqlite']);
    expect(args).toEqual({ mode: 'policies', filePath: 'policies.json', db: '/tmp/test.sqlite' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts -t "policies mode"`
Expected: FAIL — `parseArgs` throws or returns a `dec-pages`/`loss-events` mode instead of `policies` (flag not yet recognized).

- [ ] **Step 3: Implement the CLI wiring**

In `scripts/import-insurance-data.ts`, change:

```typescript
export interface CliArgs {
  mode: 'loss-events' | 'dec-pages';
  filePath: string;
  db?: string;
}
```

to:

```typescript
export interface CliArgs {
  mode: 'loss-events' | 'dec-pages' | 'policies';
  filePath: string;
  db?: string;
}
```

Then in `parseArgs`, change:

```typescript
export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let db: string | undefined;
  let decPagesPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else if (arg === '--dec-pages') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --dec-pages');
      decPagesPath = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  if (decPagesPath !== undefined) {
    return { mode: 'dec-pages', filePath: decPagesPath, db };
  }

  const filePath = positional[0];
  if (filePath === undefined) {
    throw new Error(
      'Usage: npx tsx scripts/import-insurance-data.ts <events.json> [--db <path>]\n'
      + '   or: npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json> [--db <path>]',
    );
  }
  return { mode: 'loss-events', filePath, db };
}
```

to:

```typescript
export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let db: string | undefined;
  let decPagesPath: string | undefined;
  let policiesPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --db');
      db = next;
      i += 1;
    } else if (arg === '--dec-pages') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --dec-pages');
      decPagesPath = next;
      i += 1;
    } else if (arg === '--policies') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('missing value for --policies');
      policiesPath = next;
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  if (decPagesPath !== undefined) {
    return { mode: 'dec-pages', filePath: decPagesPath, db };
  }
  if (policiesPath !== undefined) {
    return { mode: 'policies', filePath: policiesPath, db };
  }

  const filePath = positional[0];
  if (filePath === undefined) {
    throw new Error(
      'Usage: npx tsx scripts/import-insurance-data.ts <events.json> [--db <path>]\n'
      + '   or: npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json> [--db <path>]\n'
      + '   or: npx tsx scripts/import-insurance-data.ts --policies <policies.json> [--db <path>]',
    );
  }
  return { mode: 'loss-events', filePath, db };
}
```

Finally, in `main`, change:

```typescript
  try {
    if (args.mode === 'dec-pages') {
      const result = importDecPages(db, payload);
      console.log(`import-insurance-data (dec-pages): ${result.updated} polic${result.updated === 1 ? 'y' : 'ies'} updated from ${args.filePath}`);
      console.log(`  ${result.missing} missing policy id(s), ${result.rejected} rejected row(s)`);
    } else {
      const result = importLossRuns(db, payload, args.filePath);
      console.log(`import-insurance-data (loss-events): ${result.inserted} row(s) inserted from ${args.filePath}`);
      console.log(`  ${result.ignored} already-present (ignored) row(s), ${result.rejected} rejected row(s)`);
      if (result.inserted > 0) {
        console.log('  insurance_loss_events is no longer empty — placeholder-data.ts resolvers now read the warehouse, not the fixture.');
      }
    }
  } catch (e) {
```

to:

```typescript
  try {
    if (args.mode === 'dec-pages') {
      const result = importDecPages(db, payload);
      console.log(`import-insurance-data (dec-pages): ${result.updated} polic${result.updated === 1 ? 'y' : 'ies'} updated from ${args.filePath}`);
      console.log(`  ${result.missing} missing policy id(s), ${result.rejected} rejected row(s)`);
    } else if (args.mode === 'policies') {
      const result = importPolicies(db, payload, args.filePath);
      console.log(`import-insurance-data (policies): ${result.inserted} inserted, ${result.updated} updated from ${args.filePath}`);
      console.log(`  ${result.unrecognized} unrecognized property_id row(s), ${result.rejected} rejected row(s)`);
    } else {
      const result = importLossRuns(db, payload, args.filePath);
      console.log(`import-insurance-data (loss-events): ${result.inserted} row(s) inserted from ${args.filePath}`);
      console.log(`  ${result.ignored} already-present (ignored) row(s), ${result.rejected} rejected row(s)`);
      if (result.inserted > 0) {
        console.log('  insurance_loss_events is no longer empty — placeholder-data.ts resolvers now read the warehouse, not the fixture.');
      }
    }
  } catch (e) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts`
Expected: PASS — full file, all `describe` blocks including the two new ones from Tasks 1–2 and these two new cases.

- [ ] **Step 5: Run the full suite once to catch any regression**

Run: `npx vitest run tests/unit/import-insurance-data.test.ts`
Expected: PASS, 0 failures, same total test count as Step 4 (this step is a repeat-for-safety after touching the CLI's shared `main`/`CliArgs` surface — no new tests here).

- [ ] **Step 6: Commit**

```bash
git add -- scripts/import-insurance-data.ts tests/unit/import-insurance-data.test.ts
git commit -m "feat(insurance): wire --policies CLI mode"
```

---

### Task 4: Build the source-cited payload data file

**Files:**
- Create: `scripts/data/2026-08-22-insurance-premium-history.json`

**Interfaces:**
- Consumes: nothing (static data file).
- Produces: the exact input `importPolicies` (Task 2) expects — `{ policies: [...], newLines: string[], ingestedBy: string }`.

This is the fully-reconciled payload from the design spec's §4.1 mapping, cross-referenced row-by-row against the `ora-insurance-premium-dashboard` artifact's `PROPS` array and the `2026-08-17_InsurancePremiumHistory_Analysis_v03.xlsx` Source Index tab. **13 rows land cleanly; two items are explicitly deferred, not guessed** (see Task 5).

- [ ] **Step 1: Write the data file**

```json
{
  "ingestedBy": "import-insurance-data.ts --policies (Track A, 2026-08-22)",
  "newLines": [],
  "policies": [
    {
      "propertyId": "ins-1900broadway-ufx",
      "insurer": "Erie Insurance",
      "policyNumber": "Q44-2750780",
      "effectiveDate": "2024-08-27",
      "expirationDate": "2025-08-27",
      "premiumAnnual": 10784,
      "coverageTiv": 4541000,
      "policyType": "Unoccupied/Flex Package (UFX PCKG)",
      "source": "1900 N Broadway 2024-2025 Insurance.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-1900broadway-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q32-2770246",
      "effectiveDate": "2024-08-27",
      "expirationDate": "2025-08-27",
      "premiumAnnual": 1992,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "1900 N Broadway 2024-2025 Umbrella Insurance.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-3540fifth-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0159747",
      "effectiveDate": "2024-01-20",
      "expirationDate": "2025-01-20",
      "premiumAnnual": 9478,
      "coverageTiv": 4393500,
      "policyType": "Package (PCKG)",
      "source": "35402425.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-3540fifth-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q25-2070432",
      "effectiveDate": "2024-01-20",
      "expirationDate": "2025-01-20",
      "premiumAnnual": 878,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "3540UM2425.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-3540fifth-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0159747",
      "effectiveDate": "2025-01-20",
      "expirationDate": "2026-01-20",
      "premiumAnnual": 10903,
      "coverageTiv": 4613500,
      "policyType": "Package (PCKG)",
      "source": "35402526.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-3540fifth-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q25-2070432",
      "effectiveDate": "2025-01-20",
      "expirationDate": "2026-01-20",
      "premiumAnnual": 964,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "3540UM2526.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-fvc-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0076471",
      "effectiveDate": "2024-02-03",
      "expirationDate": "2025-02-03",
      "premiumAnnual": 20345,
      "coverageTiv": 10715500,
      "policyType": "Package (PCKG)",
      "source": "Fairground Insurance 2024-2025.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-fvc-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q26-0370289",
      "effectiveDate": "2024-02-03",
      "expirationDate": "2025-02-03",
      "premiumAnnual": 1813,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "FairIM24.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-3034westerville-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0456794",
      "effectiveDate": "2024-09-24",
      "expirationDate": "2025-09-24",
      "premiumAnnual": 7838,
      "coverageTiv": 2495750,
      "policyType": "Package (PCKG)",
      "source": "2425 Package  3034 Westerville New.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-55newplant-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0246004",
      "effectiveDate": "2024-01-01",
      "expirationDate": "2025-01-01",
      "premiumAnnual": 7907,
      "coverageTiv": 5256000,
      "policyType": "Package (PCKG)",
      "source": "Eric Goldberg Family 2024-2025 Insurance.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-55newplant-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q25-0177359",
      "effectiveDate": "2024-01-01",
      "expirationDate": "2025-01-01",
      "premiumAnnual": 536,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "Eric Goldberg Family 2024-2025 Umbrella Insurance.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-55newplant-pckg",
      "insurer": "Erie Insurance",
      "policyNumber": "Q61-0246004",
      "effectiveDate": "2025-01-01",
      "expirationDate": "2026-01-01",
      "premiumAnnual": 8236,
      "coverageTiv": 5624000,
      "policyType": "Package (PCKG)",
      "source": "Eric Goldberg Family 2025-2026 Insurance.pdf",
      "sourceDate": "2026-08-17"
    },
    {
      "propertyId": "ins-55newplant-bcl",
      "insurer": "Erie Insurance",
      "policyNumber": "Q25-0177359",
      "effectiveDate": "2025-01-01",
      "expirationDate": "2026-01-01",
      "premiumAnnual": 584,
      "coverageTiv": null,
      "policyType": "Business Crime Liability (BCL)",
      "source": "Eric Goldberg Family 2025-2026 Umbrella Insurance.pdf",
      "sourceDate": "2026-08-17"
    }
  ]
}
```

**Why only 13 rows across 5 of the 7 `PROPS` properties, not ~19–20 across all 7 — one property needed zero rows, two items deferred, none guessed:**

0. **3875-3883 Livingston needed zero new rows — not a gap, verified against the live DB.** `PROPS['3883']` has only two policy years (`2025-2026`, `2026-2027`) because the property is new business (Source Index: "New business 06/11/2025" — there is no 2024-25 term to have ever existed). Both years are already present in `property_insurance_policies` exactly matching `PROPS`: `ins-3883livingston-pckg`/`-bcl`, policy numbers `Q61-0566802`/`Q30-1170446`, `2025-06-11`→5815/614 and `2026-06-11`→5687/614. Re-confirmed against the live warehouse before closing this track (2026-08-22) after the whole-branch review flagged Livingston's absence from the payload as unexplained — it's fully covered, not missed.
1. **3034 Westerville's 2025-26 and 2026-27 terms are withheld.** The *existing* `ins-3034westerville-pckg` row (`effective_date '2025-09-18'`, `premium_annual 7838`) pairs a 2024-25 premium ($7,838, confirmed by Source Index's "new dec 09/24/2024; premium $7,838") with what looks like a 2025-26-dated key. Inserting the true 2025-26 term ($7,831) at the same `2025-09-18` date this importer would treat as an UPDATE to that existing (likely mis-dated) row — silently overwriting a discrepancy instead of surfacing it. Task 5 logs this as a `data_quality_issues` row for Gabriel/a follow-up session to resolve against the source PDF; this plan does not guess at the true date. **Update (2026-08-22, post-merge-review):** the Track A import also added a *new* row for the confirmed 2024-25 term (`effective_date '2024-09-24'`, same premium $7,838, id 1360) — two rows now carry the same $7,838 figure at different dates. `data_quality_issues` id=3's detail was amended to name both rows explicitly so a follow-up session isn't misled by the original text, which predated the second row.
2. **9620 State 350 is entirely out of scope for this payload**, per spec §3 — it has a documented carrier-naming discrepancy (broker name recorded where a carrier name belongs, in the 2 existing 2025-10-18 rows), an unresolved mid-term cancellation (superseded 05/28/2026, `expiration_date` on the existing row still shows the original term end), and a Hartford 2026-27 bundle whose GL/Umbrella/fees breakdown doesn't cleanly map ($329 GL + $336 new umbrella + an unexplained $599 remainder ≠ the dashboard's single $1,264 "umbrella" figure). All three are already tracked in `reference_insurance_9620_state350_and_deductible_ladder_2026-08-17.md` — this track does not reopen them.

**Constraint for any future history import into this table (surfaced by the final whole-branch review, 2026-08-22):** `server/warehouse/insurance-analysis.ts`'s `collapseToCurrentTerm`/`isMoreCurrent` picks the "current" term of a policy line by `source_date` DESC first, `effective_date` only as a tiebreak. This track's 13 rows are safe only because they all carry `source_date = '2026-08-17'`, which ties the existing `brain-server` rows and falls back to the (correct) effective-date ordering. A *future* history backfill whose `source_date` is newer than the live capture's, importing an *older* policy term, would make that older term win its cluster and surface as "current" in `renewalCalendar`/`premiumAnnualTotal`/`policiesN`/the `insurance-expiry-soon` insight. Any future `--policies` import of back-dated history must keep `sourceDate` no newer than the most recent live capture for that property, or `collapseToCurrentTerm` needs a real "is this superseded history" signal instead of relying on capture recency.

- [ ] **Step 2: Validate the JSON is well-formed**

Run: `node -e "JSON.parse(require('fs').readFileSync('scripts/data/2026-08-22-insurance-premium-history.json', 'utf8')); console.log('valid JSON')"`
Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add -- scripts/data/2026-08-22-insurance-premium-history.json
git commit -m "data(insurance): source-cited premium-history payload for 7 properties"
```

---

### Task 5: Log the Westerville data-quality finding

**Files:**
- No file — a single SQL statement against the live warehouse (this is a data-quality flag, not a code change, so it isn't test-covered).

**Interfaces:**
- Consumes: `data_quality_issues` table (migration 001).

- [ ] **Step 1: Insert the flag**

Run:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/warehouse/finance.sqlite');
db.prepare(\`INSERT INTO data_quality_issues (property_id, kind, detail, severity)
  VALUES (?, 'insurance-policy-suspected-year-mismatch', ?, 'warn')\`).run(
  'ins-3034westerville-pckg',
  'Existing row (policy Q61-0456794, effective_date 2025-09-18, premium_annual 7838) pairs a 2024-25 premium figure (Source Index: new dec 09/24/2024, premium \$7,838) with what should likely be a 2025-09-18-or-later key. The confirmed 2025-26 term (\$7,831, renewal cert 07/05/2025) and 2026-27 term (\$7,522, renewal cert 07/05/2026, deductible raised to \$25,000) from ora-insurance-premium-dashboard were withheld from the 2026-08-22 Track A import rather than risk silently overwriting this row via upsert. Needs the source PDF (2425 Package 3034 Westerville New.pdf) checked against the actual policy anniversary before the 2025-26/2026-27 rows are added.'
);
console.log('logged');
"
```

Expected: `logged`

- [ ] **Step 2: Verify**

Run: `node -e "const Database=require('better-sqlite3'); const db=new Database('data/warehouse/finance.sqlite',{readonly:true}); console.log(db.prepare(\"SELECT id, kind, status FROM data_quality_issues WHERE kind='insurance-policy-suspected-year-mismatch'\").all())"`
Expected: one row, `status: 'open'`.

(No commit — this only touches the gitignored `data/warehouse/finance.sqlite`, not a tracked file.)

---

### Task 6: Run the import and verify

**Files:** none (execution + verification only).

- [ ] **Step 1: Dry-run count check before writing**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('scripts/data/2026-08-22-insurance-premium-history.json','utf8')).policies.length)"`
Expected: `13`

- [ ] **Step 2: Run the importer against the live warehouse**

Run: `npx tsx scripts/import-insurance-data.ts --policies scripts/data/2026-08-22-insurance-premium-history.json`
Expected: `import-insurance-data (policies): 13 inserted, 0 updated from scripts/data/2026-08-22-insurance-premium-history.json` and `0 unrecognized property_id row(s), 0 rejected row(s)`. (0 updated is expected on a clean first run — none of these 13 keys exist yet, per Task 4's reconciliation.)

- [ ] **Step 3: Verify row count and spot-check one row**

Run: `node -e "const Database=require('better-sqlite3'); const db=new Database('data/warehouse/finance.sqlite',{readonly:true}); console.log('total:', db.prepare('SELECT COUNT(*) c FROM property_insurance_policies').get()); console.log(db.prepare(\"SELECT * FROM property_insurance_policies WHERE property_id='ins-fvc-pckg' ORDER BY effective_date\").all())"`
Expected: `total: { c: 47 }` (34 pre-existing + 13 new). The `ins-fvc-pckg` query returns 3 rows now (the pre-existing 2025-02-03 and 2026-02-03 rows, plus the new 2024-02-03 row), each with the correct `id` (the two pre-existing ids unchanged — proof the upsert never touched them).

- [ ] **Step 4: Re-run to prove idempotency**

Run: `npx tsx scripts/import-insurance-data.ts --policies scripts/data/2026-08-22-insurance-premium-history.json`
Expected: `import-insurance-data (policies): 0 inserted, 13 updated ...` — same 13 rows, now all resolve as updates. Re-run the Step 3 count query and confirm `total: { c: 47 }` is unchanged (no duplicates).

- [ ] **Step 5: Run the repo gate**

Run: `npm run gate`
Expected: typecheck, lint, tests all pass; `reconcile` passes ($0 tolerance vs. workbook totals — this import doesn't touch any workbook-sourced total, so reconcile should be unaffected. If reconcile fails, stop and investigate before proceeding — do not override).

- [ ] **Step 6: Final isolated commit and report**

```bash
git status --short
```

Confirm only this plan's files show as committed/clean (the spec, the script changes, the test changes, the data file) and the other session's 9 unrelated modified files are still present and untouched. Report to Gabriel: rows imported, `data_quality_issues` id logged in Task 5, and the two explicitly-deferred items (Westerville terms, all of 9620) with a pointer to this plan for follow-up scope.

---

## Self-Review Notes

- **Spec coverage:** §5 upsert semantics → Task 2. §6 validation + unrecognized-line DQ check → Tasks 1 & 2. §7 testing → Tasks 1–3. §4.1 identity mapping → Task 4's payload. §8 rollout → Tasks 4–6. §3/§9 non-goals (9620, the 4 non-PROPS entities, `--dec-pages`) → explicitly not attempted; Task 4's "why only 13 rows" note documents the 9620 exclusion and the one new Westerville finding.
- **Type consistency:** `ParsedPolicyRow`, `ImportPolicyRowsResult`, `importPolicyRows`, `importPolicies`, `parsePoliciesPayload` are named identically everywhere they're referenced across Tasks 1–3 and in the "Interfaces" blocks.
- **No placeholders:** every step has literal code, exact commands, and exact expected output; the payload in Task 4 is the actual final data, not a sample.
