// @vitest-environment node
// check-write-schema-drift.ts is a pure Node script (fs/path only). node environment required —
// vi.mock('node:fs') is a silent no-op under jsdom (see governance-check.test.ts for the same note).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

import {
  matchDelimited,
  splitTopLevel,
  camelToSnake,
  applyCreateTables,
  applyAlterTables,
  collectMigrationColumns,
  parseObjectLiteralFields,
  parseKeySet,
  collectDeclarations,
  resolveSchema,
  extractBoundFieldName,
  normalizePath,
  findRouteWrites,
  checkWriteSchemaDrift,
  type TableMap,
} from '../../scripts/check-write-schema-drift';

// ── Pure text-scanning primitives ───────────────────────────────────────────────────────────────

describe('matchDelimited', () => {
  it('finds the matching close paren, skipping nested brackets', () => {
    const src = 'foo(a, {b: [1, 2]}, c)';
    const { inner, endIdx } = matchDelimited(src, 3);
    expect(inner).toBe('a, {b: [1, 2]}, c');
    expect(endIdx).toBe(src.length);
  });

  it('skips over a string literal containing an unbalanced bracket', () => {
    const src = "foo('a) weird ( string', b)";
    const { inner } = matchDelimited(src, 3);
    expect(inner).toBe("'a) weird ( string', b");
  });

  it('skips over a comment containing an unbalanced bracket', () => {
    const src = 'foo(\n  // a comment with a ( stray paren\n  a\n)';
    const { inner } = matchDelimited(src, 3);
    expect(inner.trim().endsWith('a')).toBe(true);
  });
});

describe('splitTopLevel', () => {
  it('splits only at depth-0 commas', () => {
    expect(splitTopLevel('a, f(b, c), d')).toEqual(['a', ' f(b, c)', ' d']);
  });

  it('does not split on a comma inside a comment', () => {
    const text = 'a: 1,\n  // a comment, with a comma\n  b: 2';
    expect(splitTopLevel(text, ',')).toEqual(['a: 1', '\n  // a comment, with a comma\n  b: 2']);
  });

  it('does not split on a comma inside a string', () => {
    expect(splitTopLevel("a: 'x, y', b: 2")).toEqual(["a: 'x, y'", ' b: 2']);
  });
});

describe('camelToSnake', () => {
  it('converts camelCase to snake_case', () => {
    expect(camelToSnake('rentableSf')).toBe('rentable_sf');
    expect(camelToSnake('estSavingsAnnual')).toBe('est_savings_annual');
    expect(camelToSnake('id')).toBe('id');
  });
});

// ── Migration column extraction ───────────────────────────────────────────────────────────────

describe('applyCreateTables / applyAlterTables', () => {
  it('parses columns, NOT NULL and DEFAULT flags, skipping table-level constraints', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        foo_bar TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(id, foo_bar)
      );
    `;
    const tables: TableMap = new Map();
    applyCreateTables(sql, tables);
    const cols = tables.get('widgets')!;
    expect([...cols.keys()]).toEqual(['id', 'foo_bar', 'note', 'created_at']);
    expect(cols.get('foo_bar')).toEqual({ notNull: true, hasDefault: false });
    expect(cols.get('note')).toEqual({ notNull: false, hasDefault: false });
    expect(cols.get('created_at')).toEqual({ notNull: true, hasDefault: true });
  });

  it('a later CREATE TABLE for the same name replaces the prior definition (table rebuild)', () => {
    const tables: TableMap = new Map();
    applyCreateTables('CREATE TABLE widgets (id TEXT, old_col TEXT);', tables);
    applyCreateTables('CREATE TABLE widgets (id TEXT, new_col TEXT);', tables);
    expect([...tables.get('widgets')!.keys()]).toEqual(['id', 'new_col']);
  });

  it('ALTER TABLE ADD COLUMN merges into the existing table', () => {
    const tables: TableMap = new Map();
    applyCreateTables('CREATE TABLE widgets (id TEXT PRIMARY KEY);', tables);
    applyAlterTables('ALTER TABLE widgets ADD COLUMN extra TEXT NOT NULL DEFAULT 0;', tables);
    expect(tables.get('widgets')!.get('extra')).toEqual({ notNull: true, hasDefault: true });
  });

  it('ignores a SQL line comment (--) containing a colon or comma next to a real column', () => {
    // Matches the real pattern in e.g. 003_capital_config.sql: an inline `-- comment` immediately
    // after a column definition, sometimes containing punctuation of its own.
    const sql = `
      CREATE TABLE IF NOT EXISTS onboard (
        id TEXT PRIMARY KEY,
        effective_from TEXT NOT NULL,   -- ISO date (YYYY-MM-DD): ratified this: date, with a comma,
        ownership_pct REAL NOT NULL     -- fraction, e.g. 0.5 for a 50% JV
      );
    `;
    const tables: TableMap = new Map();
    applyCreateTables(sql, tables);
    const cols = tables.get('onboard')!;
    expect([...cols.keys()]).toEqual(['id', 'effective_from', 'ownership_pct']);
  });

  it('ignores a SQL block comment (/* */) inside a table body', () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS onboard (
        id TEXT PRIMARY KEY,
        /* a block comment, with a comma and a colon: right here */
        ownership_pct REAL NOT NULL
      );
    `;
    const tables: TableMap = new Map();
    applyCreateTables(sql, tables);
    expect([...tables.get('onboard')!.keys()]).toEqual(['id', 'ownership_pct']);
  });
});

describe('collectMigrationColumns', () => {
  beforeEach(() => vi.resetAllMocks());

  it('applies migrations in numeric filename order, not lexicographic', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['002_second.sql', '010_tenth.sql', '001_first.sql'] as never);
    mockReadFileSync.mockImplementation((p) => {
      const name = String(p);
      if (name.endsWith('001_first.sql')) return 'CREATE TABLE t (id TEXT);';
      if (name.endsWith('002_second.sql')) return 'ALTER TABLE t ADD COLUMN a TEXT;';
      if (name.endsWith('010_tenth.sql')) return 'ALTER TABLE t ADD COLUMN b TEXT;';
      throw new Error('unexpected file ' + name);
    });
    const tables = collectMigrationColumns('/fake/root');
    expect([...tables.get('t')!.keys()]).toEqual(['id', 'a', 'b']);
  });

  it('returns an empty map when the migrations directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(collectMigrationColumns('/fake/root').size).toBe(0);
  });
});

// ── Zod schema field extraction ───────────────────────────────────────────────────────────────

describe('parseObjectLiteralFields', () => {
  it('extracts keys with optional/default/nullable flags', () => {
    const fields = parseObjectLiteralFields(`
      id: z.string(),
      note: z.string().nullable().default(null),
      tag: z.string().optional(),
    `);
    expect([...fields.keys()]).toEqual(['id', 'note', 'tag']);
    expect(fields.get('note')).toEqual({ optional: false, hasDefault: true, nullable: true });
    expect(fields.get('tag')).toEqual({ optional: true, hasDefault: false, nullable: false });
  });

  it('does not drop a field preceded by an explanatory comment (regression)', () => {
    // A field with a leading // comment previously vanished entirely: findTopLevelColon correctly
    // skips the comment to find the real colon, but a naive slice-by-index still included the
    // comment's raw characters in the "key" text, failing the identifier check silently.
    const fields = parseObjectLiteralFields(`
      sfTotal: z.number().nullable(),
      // Required, no default: this field didn't exist before, so it's easy to miss in review.
      // Second line of the comment, with more punctuation: like this, and this.
      ownershipPct: z.number().gt(0).lte(1),
      pmSystem: z.enum(['a', 'b']),
    `);
    expect([...fields.keys()]).toEqual(['sfTotal', 'ownershipPct', 'pmSystem']);
  });

  it('handles CRLF line endings the same as LF', () => {
    const fields = parseObjectLiteralFields('id: z.string(),\r\n  // a comment\r\n  name: z.string(),\r\n');
    expect([...fields.keys()]).toEqual(['id', 'name']);
  });

  it('skips spread entries', () => {
    const fields = parseObjectLiteralFields('...Base.shape,\n  extra: z.string(),');
    expect([...fields.keys()]).toEqual(['extra']);
  });
});

describe('parseKeySet', () => {
  it('extracts key names regardless of their boolean value', () => {
    expect([...parseKeySet('a: true, b: true, c: false')]).toEqual(['a', 'b', 'c']);
  });
});

// ── Chain resolution: pick / omit / partial / extend ────────────────────────────────────────────

describe('resolveSchema', () => {
  it('resolves a plain z.object', () => {
    const registry = new Map();
    collectDeclarations("export const Foo = z.object({ a: z.string(), b: z.number() });", 'f.ts', registry);
    const schema = resolveSchema('Foo', registry);
    expect([...schema!.fields.keys()]).toEqual(['a', 'b']);
  });

  it('resolves .pick(...) to a field subset', () => {
    const registry = new Map();
    collectDeclarations(
      `export const Base = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
       export const Sub = Base.pick({ a: true, c: true });`,
      'f.ts',
      registry,
    );
    expect([...resolveSchema('Sub', registry)!.fields.keys()]).toEqual(['a', 'c']);
  });

  it('resolves .omit(...) to the complementary subset', () => {
    const registry = new Map();
    collectDeclarations(
      `export const Base = z.object({ a: z.string(), b: z.number() });
       export const Sub = Base.omit({ b: true });`,
      'f.ts',
      registry,
    );
    expect([...resolveSchema('Sub', registry)!.fields.keys()]).toEqual(['a']);
  });

  it('resolves .partial() by marking every field optional', () => {
    const registry = new Map();
    collectDeclarations(
      `export const Base = z.object({ a: z.string(), b: z.number() });
       export const Sub = Base.pick({ a: true }).partial();`,
      'f.ts',
      registry,
    );
    const schema = resolveSchema('Sub', registry)!;
    expect(schema.fields.get('a')!.optional).toBe(true);
  });

  it('resolves .extend(...) by adding new fields', () => {
    const registry = new Map();
    collectDeclarations(
      `export const Base = z.object({ a: z.string() });
       export const Sub = Base.extend({ b: z.number() });`,
      'f.ts',
      registry,
    );
    expect([...resolveSchema('Sub', registry)!.fields.keys()].sort()).toEqual(['a', 'b']);
  });

  it('resolves a base schema declared in a different file', () => {
    const registry = new Map();
    collectDeclarations('export const Base = z.object({ a: z.string() });', 'contracts/base.ts', registry);
    collectDeclarations('const Sub = Base.pick({ a: true });', 'server/route.ts', registry);
    expect([...resolveSchema('Sub', registry)!.fields.keys()]).toEqual(['a']);
  });

  it('returns null for an unknown name', () => {
    expect(resolveSchema('Nope', new Map())).toBeNull();
  });
});

// ── Bound-expression field extraction ────────────────────────────────────────────────────────

describe('extractBoundFieldName', () => {
  it('extracts the last segment of a direct dotted chain', () => {
    expect(extractBoundFieldName('parsed.data.propertyId')).toBe('propertyId');
    expect(extractBoundFieldName('input.taxYear')).toBe('taxYear');
  });

  it('strips a trailing nullish-coalescing default', () => {
    expect(extractBoundFieldName('input.sfTotal ?? null')).toBe('sfTotal');
  });

  it('unwraps a single-argument transform call', () => {
    expect(extractBoundFieldName('JSON.stringify(input.aliases)')).toBe('aliases');
    expect(extractBoundFieldName('String(input.x)')).toBe('x');
  });

  it('returns null for a literal or a bare identifier', () => {
    expect(extractBoundFieldName("'manual'")).toBeNull();
    expect(extractBoundFieldName('candidateId')).toBeNull();
    expect(extractBoundFieldName('null')).toBeNull();
  });

  it('returns null for a derived array/RunResult property, not a schema field', () => {
    expect(extractBoundFieldName('req.candidates.length')).toBeNull();
    expect(extractBoundFieldName('ins.lastInsertRowid')).toBeNull();
    expect(extractBoundFieldName('Number(ins.lastInsertRowid)')).toBeNull();
  });

  it('returns null for a multi-argument call (not a simple passthrough)', () => {
    expect(extractBoundFieldName('Math.max(input.a, input.b)')).toBeNull();
  });
});

describe('normalizePath', () => {
  it('collapses :param and ${...} segments to a wildcard', () => {
    expect(normalizePath('/acq/candidates/:candidateId/status')).toBe('/acq/candidates/*/status');
    expect(normalizePath('/api/warehouse/acq/candidates/${encodeURIComponent(v.candidateId)}/status')).toBe(
      '/api/warehouse/acq/candidates/*/status',
    );
  });

  it('drops a trailing slash', () => {
    expect(normalizePath('/api/foo/')).toBe('/api/foo');
  });
});

// ── Route + write-target extraction ──────────────────────────────────────────────────────────

describe('findRouteWrites', () => {
  it('extracts the route path, validating schema, and INSERT column/bound-arg pairing', () => {
    const content = `
      app.post('/widgets', (c) =>
        withDb(async (db) => {
          const parsed = WidgetInput.safeParse(await c.req.json());
          if (!parsed.success) return c.json({ error: 'bad' }, 400);
          db.prepare(\`
            INSERT INTO widgets (id, foo_bar)
            VALUES (?, ?)
          \`).run(parsed.data.id, parsed.data.fooBar);
          return c.json({ ok: true });
        }),
      );
    `;
    const routes = findRouteWrites(content, 'server/widgets.ts');
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.method).toBe('post');
    expect(route.routePath).toBe('/widgets');
    expect(route.schemaName).toBe('WidgetInput');
    expect(route.writeTargets).toHaveLength(1);
    const target = route.writeTargets[0]!;
    expect(target.table).toBe('widgets');
    expect(target.kind).toBe('INSERT');
    expect(target.bound).toEqual([
      { column: 'id', boundExpr: 'parsed.data.id' },
      { column: 'foo_bar', boundExpr: 'parsed.data.fooBar' },
    ]);
  });

  it('finds a .run() called later on a prepared statement assigned to a variable (loop reuse)', () => {
    const content = `
      app.post('/batch', (c) =>
        withDb(async (db) => {
          const parsed = BatchInput.safeParse(await c.req.json());
          if (!parsed.success) return c.json({ error: 'bad' }, 400);
          const insertItem = db.prepare(\`INSERT INTO items (id, label) VALUES (?, ?)\`);
          for (const item of parsed.data.items) {
            insertItem.run(item.id, item.label);
          }
          return c.json({ ok: true });
        }),
      );
    `;
    const routes = findRouteWrites(content, 'server/batch.ts');
    const target = routes[0]!.writeTargets[0]!;
    // item.id / item.label are ARRAY-ELEMENT fields (the loop iterates parsed.data.items), not
    // top-level schema fields — they must not be reported as direct field-name matches.
    expect(target.bound.every((b) => b.boundExpr === null)).toBe(true);
    expect(target.arrayFieldsTouched).toEqual(['items', 'items']);
  });
});

// ── End-to-end: checkWriteSchemaDrift over a small mocked repo ──────────────────────────────────

interface FakeFile {
  content: string;
}
function makeFakeFs(files: Record<string, string>) {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const entries: Record<string, FakeFile> = {};
  for (const [path, content] of Object.entries(files)) entries[norm(path)] = { content };

  mockExistsSync.mockImplementation(((p: unknown) =>
    norm(String(p)) in entries || dirHasChildren(norm(String(p)))) as never);
  mockReadFileSync.mockImplementation(((p: unknown) => {
    const key = norm(String(p));
    if (key in entries) return entries[key]!.content;
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
  }) as never);
  mockReaddirSync.mockImplementation(((p: unknown, opts: unknown) => {
    const dir = norm(String(p)).replace(/\/$/, '');
    const childNames = new Set<string>();
    for (const path of Object.keys(entries)) {
      if (!path.startsWith(dir + '/')) continue;
      const rest = path.slice(dir.length + 1);
      childNames.add(rest.split('/')[0]!);
    }
    const names = [...childNames];
    if (opts && typeof opts === 'object' && 'withFileTypes' in opts && opts.withFileTypes) {
      return names.map((name) => ({
        name,
        isDirectory: () => !(`${dir}/${name}` in entries),
        isFile: () => `${dir}/${name}` in entries,
      }));
    }
    return names;
  }) as never);

  function dirHasChildren(dir: string): boolean {
    const d = dir.replace(/\/$/, '');
    return Object.keys(entries).some((p) => p.startsWith(d + '/'));
  }
}

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    foo_bar TEXT NOT NULL
  );
`;

describe('checkWriteSchemaDrift (end to end)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('passes on a route whose schema, SQL columns, and bindings all agree', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': MIGRATION_SQL,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (id, foo_bar) VALUES (?, ?)\`)
              .run(parsed.data.id, parsed.data.fooBar);
            return c.json({ ok: true });
          }),
        );
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.errors).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('flags a column bound to a field the schema does not declare', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': MIGRATION_SQL,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (id, foo_bar) VALUES (?, ?)\`)
              .run(parsed.data.id, parsed.data.wrongField);
            return c.json({ ok: true });
          }),
        );
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('FIELD_NOT_IN_SCHEMA') && e.includes('wrongField'))).toBe(true);
  });

  it('flags a required schema field that is validated but never persisted', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': MIGRATION_SQL,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (id) VALUES (?)\`).run(parsed.data.id);
            return c.json({ ok: true });
          }),
        );
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('FIELD_NOT_PERSISTED') && e.includes('fooBar'))).toBe(true);
  });

  it('flags a form payload key the write schema silently strips', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': MIGRATION_SQL,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (id, foo_bar) VALUES (?, ?)\`)
              .run(parsed.data.id, parsed.data.fooBar);
            return c.json({ ok: true });
          }),
        );
      `,
      '/repo/src/modules/widget-form.ts': `
        export async function submitWidget(id: string) {
          await fetch('/api/widgets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, fooBarTypo: 'x' }),
          });
        }
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.pass).toBe(false);
    expect(
      result.errors.some((e) => e.includes('FORM_FIELD_UNKNOWN_TO_SCHEMA') && e.includes('fooBarTypo')),
    ).toBe(true);
  });

  it('does not flag a column legitimately named differently from its schema field (non-blocking)', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': `
        CREATE TABLE IF NOT EXISTS widgets (
          widget_id TEXT PRIMARY KEY,
          foo_bar TEXT NOT NULL
        );
      `,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (widget_id, foo_bar) VALUES (?, ?)\`)
              .run(parsed.data.id, parsed.data.fooBar);
            return c.json({ ok: true });
          }),
        );
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.pass).toBe(true);
    expect(result.warnings.some((w) => w.includes('COLUMN_FIELD_MISMATCH'))).toBe(true);
  });

  it('does not follow a shared helper into an unrelated write (no field overlap)', () => {
    makeFakeFs({
      '/repo/server/warehouse/migrations/001_widgets.sql': `
        ${MIGRATION_SQL}
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          note TEXT NOT NULL
        );
      `,
      '/repo/server/widgets.ts': `
        import { z } from 'zod';
        export const WidgetInput = z.object({ id: z.string(), fooBar: z.string() });
        function logAudit(db, note) {
          db.prepare(\`INSERT INTO audit_log (id, note) VALUES (?, ?)\`).run(randomUUID(), note);
        }
        app.post('/api/widgets', (c) =>
          withDb(async (db) => {
            const parsed = WidgetInput.safeParse(await c.req.json());
            if (!parsed.success) return c.json({ error: 'bad' }, 400);
            db.prepare(\`INSERT INTO widgets (id, foo_bar) VALUES (?, ?)\`)
              .run(parsed.data.id, parsed.data.fooBar);
            logAudit(db, 'widget created');
            return c.json({ ok: true });
          }),
        );
      `,
    });
    const result = checkWriteSchemaDrift('/repo');
    expect(result.pass).toBe(true);
    expect(result.errors.some((e) => e.includes('audit_log'))).toBe(false);
  });
});
