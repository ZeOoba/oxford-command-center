### Task 12: CLI — ingest and compute

> **Plan rev 2 deltas (authoritative):**
> - Dependencies renumbered: config/ingest = Task 09, owner screen = Task 08, compute = Task 10.
> - `ingest` output line uses the rev 2 `IngestResult` fields: `+${r.insertedSpaces} ~${r.updatedSpaces} props+${r.newProperties} skip=${r.skipped} missing=${r.markedMissing} removed=${r.markedRemoved} events=${JSON.stringify(Object.fromEntries(Object.entries(r.events).filter(([, n]) => n > 0)))}`.
> - `compute` output line: `signals=${r.signals} ${JSON.stringify(r.byKind)} radar=${r.radarCandidates} feed=${r.feedRows}` plus the withheld suffix.
> - Smoke-run expected output: `0 file(s), 0 failed.` then `signals=0 {} radar=0 feed=0`.

**Files:**
- Create: `scripts/lease-market.ts`
- Modify: `package.json` (two script entries — architect-owned; covered by the Task 99 status.json declaration)
- Modify: `.gitignore` (one line)
- Test: `tests/unit/lease-market-cli.test.ts`

**Interfaces:**
- Consumes: Task 08 `loadLeaseMarketConfig`, `loadCostarHeaderMap`, `ingestCostarListingsFile`, `parseListingFileName`; Task 07 `screenOwners`; Task 09 `runCompute`; `openWarehouse`; `referenceDate()` from `server/config.ts`.
- Produces:
  - `listIntakeFiles(dir: string): string[]` — `.xlsx`/`.csv` files (not Excel lock files `~$*`), ordered by export date (file-name date, else mtime date), then name
  - CLI: `tsx scripts/lease-market.ts ingest [--dir <path>]` and `tsx scripts/lease-market.ts compute [--as-of YYYY-MM-DD]`
  - npm scripts `lease-market:ingest`, `lease-market:compute`

Environment: `WAREHOUSE_DB` (default `data/warehouse/finance.sqlite`), `LEASE_MARKET_INTAKE` (default `~/OneDrive - Oxford Capital Partners/Claude_Workspace/lease-market-intake/costar`). Raw copies go to `data/lease-market/raw/` (gitignored). Exit code 1 when any file fails or compute throws; 2 on bad usage.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-cli.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listIntakeFiles } from '../../scripts/lease-market';

describe('listIntakeFiles', () => {
  it('orders exports by date and ignores lock files and other types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-cli-'));
    for (const f of ['costar-listings_columbus_2026-03-01.xlsx', 'costar-listings_columbus_2026-01-01.xlsx', '~$lock.xlsx', 'notes.txt', 'Export.csv']) {
      writeFileSync(join(dir, f), 'x');
    }
    const feb = new Date('2026-02-01T12:00:00Z');
    utimesSync(join(dir, 'Export.csv'), feb, feb);
    expect(listIntakeFiles(dir)).toEqual([
      'costar-listings_columbus_2026-01-01.xlsx',
      'Export.csv',
      'costar-listings_columbus_2026-03-01.xlsx',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-cli.test.ts`
Expected: FAIL — cannot resolve `scripts/lease-market`.

- [ ] **Step 3: Write the CLI**

Importing the module in a test must NOT run `main()`. Use the same direct-execution guard as `scripts/check-refute-required.ts` (open it and copy its bottom-of-file guard exactly). The version below assumes that guard compares `import.meta.url` with `process.argv[1]`; if that file uses a different idiom, use that idiom instead.

```ts
// scripts/lease-market.ts
//
// Lease Market Intelligence CLI (spec §3).
//   tsx scripts/lease-market.ts ingest [--dir <path>]          ingest every CoStar listings export in the intake folder, oldest first
//   tsx scripts/lease-market.ts compute [--as-of YYYY-MM-DD]   recompute signals + market-rent feed
// Exit 1 when any file fails to ingest or compute throws; 2 on bad usage.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWarehouse } from '../server/warehouse/db';
import { referenceDate } from '../server/config';
import { loadCostarHeaderMap, loadLeaseMarketConfig } from '../server/warehouse/lease-market/config';
import { ingestCostarListingsFile, parseListingFileName } from '../server/warehouse/lease-market/ingest';
import { screenOwners } from '../server/warehouse/lease-market/owner-screen';
import { runCompute } from '../server/warehouse/lease-market/compute';

const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
const RAW_DIR = join(process.cwd(), 'data', 'lease-market', 'raw');
const DEFAULT_INTAKE =
  process.env.LEASE_MARKET_INTAKE ?? join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', 'lease-market-intake', 'costar');

export function listIntakeFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ['.xlsx', '.csv'].includes(extname(f).toLowerCase()) && !f.startsWith('~$'))
    .map((f) => ({ f, date: parseListingFileName(f)?.exportDate ?? statSync(join(dir, f)).mtime.toISOString().slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.f.localeCompare(b.f))
    .map((x) => x.f);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ingest(): Promise<number> {
  const dir = argValue('--dir') ?? DEFAULT_INTAKE;
  const config = loadLeaseMarketConfig();
  const headerMap = loadCostarHeaderMap();
  const files = listIntakeFiles(dir);
  const db = openWarehouse(DB_PATH);
  let failures = 0;
  try {
    for (const f of files) {
      const r = await ingestCostarListingsFile(db, join(dir, f), {
        config,
        headerMap,
        rawDir: RAW_DIR,
        now: () => new Date().toISOString(),
        screen: (names) => screenOwners(names, config.ownerScreenModulePath),
      });
      if (r.status === 'failed') failures++;
      console.log(
        `${r.status.padEnd(9)} ${f} market=${r.marketId ?? '?'} ${r.completeness ?? '-'} +${r.inserted} ~${r.updated} skip=${r.skipped} missing=${r.markedMissing} removed=${r.markedRemoved}` +
          (r.partialReason ? ` | partial: ${r.partialReason}` : '') +
          (r.error ? ` | ERROR: ${r.error}` : ''),
      );
    }
  } finally {
    db.close();
  }
  console.log(`${files.length} file(s), ${failures} failed.`);
  return failures > 0 ? 1 : 0;
}

function compute(): number {
  const config = loadLeaseMarketConfig();
  const db = openWarehouse(DB_PATH);
  try {
    const r = runCompute(db, config, argValue('--as-of') ?? referenceDate());
    console.log(
      `signals=${r.signals} ${JSON.stringify(r.byKind)} feed=${r.feedRows}` +
        (r.withheldMarkets.length ? ` | candidates withheld: ${r.withheldMarkets.join(', ')}` : ''),
    );
    return 0;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'ingest') process.exitCode = await ingest();
  else if (cmd === 'compute') process.exitCode = compute();
  else {
    console.error('usage: tsx scripts/lease-market.ts <ingest [--dir <path>] | compute [--as-of YYYY-MM-DD]>');
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Wire package.json and .gitignore**

In `package.json` `"scripts"`, add right after the `"warehouse:import-loss-runs"` entry:

```json
    "lease-market:ingest": "tsx scripts/lease-market.ts ingest",
    "lease-market:compute": "tsx scripts/lease-market.ts compute",
```

In `.gitignore`, directly under the `data/warehouse/` line, add:

```
# Lease market raw CoStar export copies (licensed data; never committed)
data/lease-market/
```

- [ ] **Step 5: Run the test and a smoke run against an empty intake folder**

Run: `npx vitest run tests/unit/lease-market-cli.test.ts`
Expected: PASS.

Run (Git Bash):
```bash
TMP=$(mktemp -d) && WAREHOUSE_DB="$TMP/t.sqlite" LEASE_MARKET_INTAKE="$TMP" npm run lease-market:ingest && WAREHOUSE_DB="$TMP/t.sqlite" npm run lease-market:compute -- --as-of 2026-03-01
```
Expected output ends with `0 file(s), 0 failed.` then `signals=0 {} feed=0`; both exit 0. Never run these against the real `data/warehouse/finance.sqlite` in this task.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npx eslint scripts/lease-market.ts tests/unit/lease-market-cli.test.ts --max-warnings 0`

```bash
git add scripts/lease-market.ts package.json .gitignore tests/unit/lease-market-cli.test.ts
git commit -F <message-file>   # "feat(scripts): lease-market ingest/compute CLI"
```
