// tests/unit/warehouse-open-sites.test.ts
//
// openWarehouse() applies pending migrations as a side effect, and runMigrations tracks them by
// FILENAME with no checksum. Any script that opens the LIVE warehouse through it from an unmerged
// branch therefore writes that branch's schema into the live database and records it as applied —
// later edits to the file never apply. This happened on 2026-09-17: the unattended bake migrated the
// live warehouse to 030/031, and the weekly sweep of 2026-09-21 found four more readers/CLIs still
// doing it (reconcile-noi-crosscheck, the daily brief, seed-entity-xref, lease-market).
//
// Fixing four call sites does not stop the fifth, so this pins the SET of migrating call sites: a new
// `openWarehouse(` in scripts/ or server/ fails here until it is added below WITH a reason, which makes
// "should this be allowed to migrate the live database?" a reviewed decision instead of an accident.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

/** Reviewed migrating call sites. Every entry must say why a schema change from it is acceptable.
 *  Anything that runs UNATTENDED (a scheduled task, the bake) belongs on openWarehouseNoMigrate /
 *  openWarehouseReadOnly instead -- scripts/calibration-snapshot.ts and scripts/debt-scores-snapshot.ts
 *  were moved off this list for exactly that reason (the quarterly ora-calibration-snapshot task runs
 *  the former unattended). */
const ALLOWED_MIGRATING_OPENS: Record<string, string> = {
  'server/index.ts': 'The dev server on main is the SANCTIONED migrator of the live warehouse.',
  'scripts/warehouse-backfill.ts':
    'Deliberate operator command (npm run warehouse:backfill) that ingests into the warehouse.',
  'scripts/warehouse-verify.ts': 'Opens fresh sqlite files in os.tmpdir() only — never the live DB.',
  'scripts/warehouse-live-drift-check.ts':
    'Migrates a fresh tmpdir DB to compare against; the live DB is opened read-only.',
  'scripts/calibration-refit.ts': 'Deliberate operator command (a refit is run by hand); a schema change from it is intended.',
  'scripts/debt-snapshot-backfill.ts': 'Deliberate operator backfill run by hand; a schema change from it is intended.',
  'scripts/import-assessments.ts': 'Deliberate operator import (npm run import:assessments) run by hand.',
  'scripts/import-insurance-data.ts': 'Deliberate operator import of loss runs, run by hand.',
};

const NEWLINE = /\r?\n/;
const CALL = /\bopenWarehouse\s*\(/;
const TRAILING_LINE_COMMENT = /\s\/\/.*$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'archive') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(full);
  }
}

/** Files with a code line that CALLS openWarehouse(...) — comments and imports do not count. */
function migratingCallSites(): string[] {
  const files: string[] = [];
  walk(join(root, 'scripts'), files);
  walk(join(root, 'server'), files);
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(root, f).split('\\').join('/');
    if (rel === 'server/warehouse/db.ts') continue; // the definition
    for (const raw of readFileSync(f, 'utf8').split(NEWLINE)) {
      // Comment-only lines (`//`, `/*`, ` * ...`) never count. Deliberately NOT a block-comment
      // state machine: a `/*` inside a string or glob would swallow the rest of the file and hide a
      // real call site — this test must fail toward MORE hits, never fewer.
      const trimmed = raw.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
      if (CALL.test(raw.replace(TRAILING_LINE_COMMENT, ''))) {
        hits.push(rel);
        break;
      }
    }
  }
  return hits.sort();
}

describe('openWarehouse() call sites (weekly sweep 2026-09-21)', () => {
  it('only reviewed writers migrate the warehouse on open', () => {
    expect(migratingCallSites()).toEqual(Object.keys(ALLOWED_MIGRATING_OPENS).sort());
  });

  it('the readers/CLIs the sweep named no longer migrate', () => {
    const sites = new Set(migratingCallSites());
    for (const f of [
      'scripts/reconcile-noi-crosscheck.ts',
      'server/brief/run.ts',
      'scripts/seed-entity-xref.ts',
      'scripts/lease-market.ts',
      'scripts/calibration-snapshot.ts',
      'scripts/debt-scores-snapshot.ts',
      'scripts/warehouse-backup.ts',
      'scripts/bake-warehouse.ts',
    ]) {
      expect(sites.has(f), `${f} must not call the migrating openWarehouse()`).toBe(false);
    }
  });
});
