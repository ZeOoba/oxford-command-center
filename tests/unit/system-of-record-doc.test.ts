import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

/** Pulls every `backtick-quoted` token from the "Warehouse table" column of the matrix. */
function tablesNamedInDoc(md: string): string[] {
  const section =
    md.split('<!-- TABLE-CHECK:START -->')[1]?.split('<!-- TABLE-CHECK:END -->')[0] ?? '';
  const names = new Set<string>();
  for (const row of section.split('\n')) {
    // A markdown row starts with '|', so split() yields an empty cell at index 0 and the
    // "Warehouse table" column — the third visible one — lands at index 3, not 2. Getting this
    // wrong silently parses the "System of record" column instead, which holds no backticked
    // names, so every assertion below passes against an empty set.
    const cells = row.split('|');
    if (cells.length < 4) continue;
    for (const m of cells[3]!.matchAll(/`([a-z_][a-z0-9_]*)`/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

describe('system-of-record matrix', () => {
  const md = readFileSync(join(process.cwd(), 'architecture', 'system-of-record.md'), 'utf8');

  it('names at least the seven spine tables', () => {
    const named = tablesNamedInDoc(md);
    for (const t of [
      'entity_xref',
      'documents',
      'lease_facts',
      'obligations',
      'deal_decisions',
      'agent_runs',
      'audit_log',
    ]) {
      expect(named).toContain(t);
    }
  });

  it('names only tables that actually exist in the migrated schema', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const real = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    const missing = tablesNamedInDoc(md).filter((t) => !real.has(t));
    expect(missing).toEqual([]);
  });

  it('records a ratification line for Gabriel', () => {
    expect(md).toMatch(/\*\*Ratified by Gabriel:\*\*/);
  });
});
