/**
 * Write-schema drift check.
 *
 * Skill-gap fix (Gabriel, 2026-09-12): a form field / write-schema / migration-column mismatch
 * shipped unnoticed for ~3 months across 4 schemas because nothing cross-referenced the three
 * surfaces that must agree for a write endpoint to actually persist what a caller sends:
 *
 *   1. The migration that defines the table's real columns (server/warehouse/migrations/*.sql).
 *   2. The Zod schema a route validates its request body against (.safeParse in the handler).
 *   3. The positional arguments actually bound into the INSERT/UPDATE that follows.
 *
 * A rename or a copy-paste-reordered `.run(...)` call typechecks fine (SQL is a string, the
 * bound values are `unknown` by the time they reach better-sqlite3) and Zod silently strips any
 * request-body key the schema doesn't declare — so this class of bug is invisible to
 * typecheck/lint/tests and only surfaces as "the field never saved," discovered whenever a human
 * happens to check.
 *
 * This script finds every POST/PUT/PATCH route under server/**, resolves the Zod schema it
 * validates against, resolves the table + column list of every INSERT/UPDATE the handler runs,
 * and — the precise part — walks the positional `.run(...)` arguments back to the schema field
 * each one reads, so a column bound to the WRONG field (or a validated field never bound to any
 * column at all) is caught directly, rather than inferred from a coarse name-set diff. It also
 * does a best-effort check of the frontend caller's payload shape where one can be statically
 * resolved (a typed parameter import, or an inline object literal), flagging keys a caller sends
 * that the schema does not declare (Zod strips these silently — the same failure mode).
 *
 * Style note: intentionally text/regex + brace-depth-aware scanning (no AST parser dependency),
 * matching scripts/governance-check.ts's existing approach. Exported functions allow unit testing
 * without touching the real filesystem.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface DriftResult {
  pass: boolean;
  errors: string[];
  warnings: string[];
}

// ── Generic brace/paren/bracket-depth-aware text helpers ─────────────────────────────────────
// These treat the source as opaque text (no JS/TS parser) but track nesting and skip over
// string/template-literal contents so a stray delimiter inside a string or a SQL template never
// throws off the depth count.

/** Advances past a string/template literal starting at `startIdx` (which must point at a quote
 *  character), honoring backslash escapes. Returns the index just past the closing quote. */
export function skipStringLiteral(source: string, startIdx: number): number {
  const quote = source[startIdx];
  let i = startIdx + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/** Advances past a string/template literal, or a `//` line comment or a block comment, starting
 *  at `idx`;
 *  returns `idx` unchanged if none starts there. Centralizes "don't let a stray quote or bracket
 *  inside a comment or string corrupt depth tracking" for every scanner below — this codebase's
 *  comments are full of apostrophes ("doesn't", "it's"), which a naive quote-only skip would
 *  misread as opening a string literal and then swallow arbitrary amounts of real code hunting
 *  for the (nonexistent) matching quote. */
function skipNonCode(source: string, idx: number): number {
  const c = source[idx];
  if (c === '"' || c === "'" || c === '`') return skipStringLiteral(source, idx);
  if (c === '/' && source[idx + 1] === '/') {
    let i = idx + 2;
    while (i < source.length && source[i] !== '\n') i++;
    return i;
  }
  if (c === '/' && source[idx + 1] === '*') {
    const close = source.indexOf('*/', idx + 2);
    return close === -1 ? source.length : close + 2;
  }
  return idx;
}

/** Given source text and the index of an opening `(`/`{`/`[`, returns the text strictly between
 *  it and its matching closer plus the index just past the closer. String/template contents are
 *  skipped so nested delimiters inside them (e.g. SQL text, or a `${...}`) never break the count. */
export function matchDelimited(source: string, openIdx: number): { inner: string; endIdx: number } {
  const open = source[openIdx];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) throw new Error(`matchDelimited: unsupported opener '${String(open)}' at ${openIdx}`);
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const skipped = skipNonCode(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = source[i];
    if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return { inner: source.slice(openIdx + 1, i), endIdx: i + 1 };
    }
    i++;
  }
  return { inner: source.slice(openIdx + 1), endIdx: source.length };
}

/** Depth-aware split on a single-character separator — only splits where `sep` occurs outside
 *  any paren/brace/bracket nesting and outside any string/template literal. */
export function splitTopLevel(text: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      i++;
      start = i;
      continue;
    }
    i++;
  }
  const last = text.slice(start);
  if (last.trim().length > 0) parts.push(last);
  return parts;
}

function stripOuterQuotes(s: string): string {
  const m = /^(['"`])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2]! : s;
}

/** Strips SQL comments (`-- line` and block comments) from `sql`, honoring string literals.
 *  SQL's line-comment marker is `--`, not `//` — deliberately NOT folded into `skipNonCode`
 *  (shared with JS-source scanning) because `--` is also JS's decrement operator; conflating the
 *  two would corrupt depth tracking on any JS code containing `i--`. Real migrations in this
 *  codebase routinely put a `-- comment` right after a column definition (see e.g.
 *  003_capital_config.sql), so this must run before any column-list splitting. */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipStringLiteral(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** camelCase -> snake_case, matching this codebase's contract<->column naming convention
 *  (e.g. `rentableSf` -> `rentable_sf`, `estSavingsAnnual` -> `est_savings_annual`). */
export function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ── Migration column extraction ───────────────────────────────────────────────────────────────

export interface ColumnInfo {
  notNull: boolean;
  hasDefault: boolean;
}
export type TableColumns = Map<string, ColumnInfo>;
export type TableMap = Map<string, TableColumns>;

const CONSTRAINT_KEYWORDS = /^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i;

function parseColumnDefsFromTableBody(body: string): TableColumns {
  const columns: TableColumns = new Map();
  for (const raw of splitTopLevel(body, ',')) {
    const item = raw.trim();
    if (item.length === 0 || CONSTRAINT_KEYWORDS.test(item)) continue;
    const nameMatch = /^["`]?([A-Za-z_]\w*)["`]?\s/.exec(item);
    if (!nameMatch) continue;
    columns.set(nameMatch[1]!, {
      notNull: /\bNOT\s+NULL\b/i.test(item),
      hasDefault: /\bDEFAULT\b/i.test(item),
    });
  }
  return columns;
}

/** Applies every `CREATE TABLE` in `sql` to `tables` (a fresh CREATE replaces any prior
 *  definition for that table name — matching a full-table-rebuild migration like 018's). */
export function applyCreateTables(rawSql: string, tables: TableMap): void {
  const sql = stripSqlComments(rawSql);
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_]\w*)["`]?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = m[1]!;
    const openIdx = m.index + m[0].length - 1;
    const { inner } = matchDelimited(sql, openIdx);
    tables.set(table, parseColumnDefsFromTableBody(inner));
  }
}

/** Applies every `ALTER TABLE ... ADD/DROP/RENAME COLUMN` in `sql` to `tables`. */
export function applyAlterTables(rawSql: string, tables: TableMap): void {
  const sql = stripSqlComments(rawSql);
  const addRe = /ALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)["`]?\s+ADD\s+COLUMN\s+["`]?([A-Za-z_]\w*)["`]?([^;]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(sql))) {
    const table = m[1]!;
    const colName = m[2]!;
    const colDef = `${colName}${m[3] ?? ''}`;
    const existing = tables.get(table) ?? new Map<string, ColumnInfo>();
    existing.set(colName, {
      notNull: /\bNOT\s+NULL\b/i.test(colDef),
      hasDefault: /\bDEFAULT\b/i.test(colDef),
    });
    tables.set(table, existing);
  }
  const dropRe = /ALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)["`]?\s+DROP\s+COLUMN\s+["`]?([A-Za-z_]\w*)["`]?/gi;
  while ((m = dropRe.exec(sql))) {
    tables.get(m[1]!)?.delete(m[2]!);
  }
  const renameRe =
    /ALTER\s+TABLE\s+["`]?([A-Za-z_]\w*)["`]?\s+RENAME\s+COLUMN\s+["`]?([A-Za-z_]\w*)["`]?\s+TO\s+["`]?([A-Za-z_]\w*)["`]?/gi;
  while ((m = renameRe.exec(sql))) {
    const cols = tables.get(m[1]!);
    const oldCol = m[2]!;
    const newCol = m[3]!;
    const info = cols?.get(oldCol);
    if (cols && info) {
      cols.delete(oldCol);
      cols.set(newCol, info);
    }
  }
}

/** Reads every migration file (numeric-prefix order) and returns the resulting table->columns
 *  map — i.e. the DB schema as of the latest migration. */
export function collectMigrationColumns(root: string): TableMap {
  const tables: TableMap = new Map();
  const dir = join(root, 'server', 'warehouse', 'migrations');
  if (!existsSync(dir)) return tables;
  let names: string[];
  try {
    names = (readdirSync(dir) as unknown as string[]).filter((f) => f.endsWith('.sql'));
  } catch {
    return tables;
  }
  const ordered = names.sort((a, b) => {
    const na = parseInt(/^(\d+)/.exec(a)?.[1] ?? '0', 10);
    const nb = parseInt(/^(\d+)/.exec(b)?.[1] ?? '0', 10);
    return na - nb || a.localeCompare(b);
  });
  for (const name of ordered) {
    let sql = '';
    try {
      sql = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    applyCreateTables(sql, tables);
    applyAlterTables(sql, tables);
  }
  return tables;
}

// ── Zod schema resolution ─────────────────────────────────────────────────────────────────────

export interface SchemaField {
  optional: boolean;
  hasDefault: boolean;
  nullable: boolean;
}
export interface ZodSchema {
  name: string;
  fields: Map<string, SchemaField>;
  file: string;
}
interface RawDecl {
  name: string;
  file: string;
  exprText: string;
}

function findTopLevelColon(entry: string): number {
  let depth = 0;
  let i = 0;
  while (i < entry.length) {
    const skipped = skipNonCode(entry, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = entry[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) return i;
    i++;
  }
  return -1;
}

/** Removes `//` line comments and block comments from `text` (string/template literal contents are kept
 *  verbatim). `findTopLevelColon` correctly skips PAST comments to find the real colon, but a
 *  naive `entry.slice(0, colonIdx)` still includes their raw characters by index — a field
 *  preceded by an explanatory comment (extremely common in this codebase) would otherwise fail
 *  the identifier check below and silently vanish from the parsed field set. */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipStringLiteral(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function entryKey(entry: string): { key: string; valueText: string } | null {
  const colonIdx = findTopLevelColon(entry);
  const rawKeyText = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
  const rawKey = stripComments(rawKeyText).trim().replace(/^['"]|['"]$/g, '');
  if (!/^[A-Za-z_$][\w$]*$/.test(rawKey)) return null;
  return { key: rawKey, valueText: colonIdx === -1 ? '' : entry.slice(colonIdx + 1) };
}

/** `matchDelimited` on a call's `(...)` returns its argument text verbatim — for a single
 *  object-literal argument like `z.object({ a: ..., b: ... })` that means the `{`/`}` are still
 *  attached. Field parsing needs the content STRICTLY inside those braces (otherwise every
 *  top-level comma inside is misread as nested at depth 1 and no field is ever found). */
function unwrapObjectArg(argsText: string): string {
  const trimmed = argsText.trim();
  if (trimmed.startsWith('{')) {
    const { inner } = matchDelimited(trimmed, 0);
    return inner;
  }
  return trimmed;
}

/** Parses the body of a `z.object({ ... })` (or `.extend({...})`) literal into field metadata. */
export function parseObjectLiteralFields(objText: string): Map<string, SchemaField> {
  const fields = new Map<string, SchemaField>();
  for (const raw of splitTopLevel(objText, ',')) {
    const entry = raw.trim();
    if (entry.length === 0 || entry.startsWith('...')) continue;
    const parsed = entryKey(entry);
    if (!parsed) continue;
    fields.set(parsed.key, {
      optional: /\.optional\s*\(\s*\)/.test(parsed.valueText),
      hasDefault: /\.default\s*\(/.test(parsed.valueText),
      nullable: /\.nullable\s*\(\s*\)/.test(parsed.valueText),
    });
  }
  return fields;
}

/** Parses `.pick({...})` / `.omit({...})` argument objects, where only the key names matter. */
export function parseKeySet(objText: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of splitTopLevel(objText, ',')) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const parsed = entryKey(entry);
    if (parsed) keys.add(parsed.key);
  }
  return keys;
}

interface ChainCall {
  method: string;
  argsText: string;
}
function parseChain(expr: string): { headIdent: string; calls: ChainCall[] } {
  const identMatch = /^[A-Za-z_$][\w$]*/.exec(expr);
  const headIdent = identMatch ? identMatch[0] : '';
  let i = headIdent.length;
  const calls: ChainCall[] = [];
  while (i < expr.length) {
    while (i < expr.length && /\s/.test(expr[i] ?? '')) i++;
    if (expr[i] !== '.') break;
    i++;
    const m = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
    if (!m) break;
    const method = m[0];
    i += method.length;
    while (i < expr.length && /\s/.test(expr[i] ?? '')) i++;
    if (expr[i] !== '(') {
      calls.push({ method, argsText: '' });
      continue;
    }
    const { inner, endIdx } = matchDelimited(expr, i);
    calls.push({ method, argsText: inner });
    i = endIdx;
  }
  return { headIdent, calls };
}

/** Scans a file's source for every `(export )?const Name = <expr>;` declaration and records the
 *  raw RHS expression text (up to the top-level terminating `;`). Cheap and unfiltered — most
 *  entries are never Zod-related and are simply never looked up. */
export function collectDeclarations(content: string, file: string, into: Map<string, RawDecl>): void {
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const name = m[1]!;
    const exprStart = m.index + m[0].length;
    let depth = 0;
    let i = exprStart;
    while (i < content.length) {
      const skipped = skipNonCode(content, i);
      if (skipped !== i) {
        i = skipped;
        continue;
      }
      const c = content[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) break;
      i++;
    }
    into.set(name, { name, file, exprText: content.slice(exprStart, i) });
    re.lastIndex = i;
  }
}

/** Resolves a declared name to its Zod field set, following `.pick/.omit/.partial/.extend/.merge`
 *  chains off a base `z.object({...})` (possibly declared in another scanned file). Returns null
 *  if the name isn't found or doesn't resolve to a Zod object schema. */
export function resolveSchema(
  name: string,
  registry: Map<string, RawDecl>,
  memo: Map<string, ZodSchema | null> = new Map(),
): ZodSchema | null {
  if (memo.has(name)) return memo.get(name) ?? null;
  memo.set(name, null); // guard against self-referential cycles while resolving
  const decl = registry.get(name);
  if (!decl) return null;
  const { headIdent, calls } = parseChain(decl.exprText);
  let fields: Map<string, SchemaField>;
  const remaining = [...calls];
  if (headIdent === 'z' && remaining[0]?.method === 'object') {
    fields = parseObjectLiteralFields(unwrapObjectArg(remaining[0].argsText));
    remaining.shift();
  } else {
    const base = resolveSchema(headIdent, registry, memo);
    if (!base) return null;
    fields = new Map(base.fields);
  }
  for (const call of remaining) {
    if (call.method === 'pick') {
      const keys = parseKeySet(unwrapObjectArg(call.argsText));
      fields = new Map([...fields].filter(([k]) => keys.has(k)));
    } else if (call.method === 'omit') {
      const keys = parseKeySet(unwrapObjectArg(call.argsText));
      fields = new Map([...fields].filter(([k]) => !keys.has(k)));
    } else if (call.method === 'partial') {
      fields = new Map([...fields].map(([k, v]) => [k, { ...v, optional: true }]));
    } else if (call.method === 'extend' || call.method === 'merge') {
      const extra = parseObjectLiteralFields(unwrapObjectArg(call.argsText));
      fields = new Map([...fields, ...extra]);
    }
    // Other chained calls (strict/passthrough/refine/superRefine/describe/...) don't change the
    // field set and are intentionally ignored.
  }
  const schema: ZodSchema = { name, fields, file: decl.file };
  memo.set(name, schema);
  return schema;
}

// ── Source file collection ────────────────────────────────────────────────────────────────────

export function collectFiles(root: string, subdir: string, extensions: string[]): string[] {
  const start = join(root, subdir);
  if (!existsSync(start)) return [];
  const files: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
        files.push(full);
      }
    }
  }
  return files;
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ── Route + write-target extraction ───────────────────────────────────────────────────────────

export interface BoundColumn {
  column: string;
  /** The bound expression's source text (e.g. `parsed.data.propertyId`), or null when the value
   *  is a literal/derived expression (not a direct schema-field passthrough). */
  boundExpr: string | null;
}
export interface WriteTarget {
  table: string;
  kind: 'INSERT' | 'UPDATE';
  /** Every column referenced by the statement (parameterized or not) — used for the coarse
   *  NOT-NULL-column check. */
  allColumns: string[];
  /** Only the columns bound to a `?` placeholder, paired with the runtime expression supplying
   *  it (when resolvable) — used for the precise field<->column cross-check. */
  bound: BoundColumn[];
  /** 'inline' for a `.prepare()` found directly in the route handler; otherwise the name of the
   *  helper function it was found in (one call deep — see collectFunctionBodies). A helper is
   *  shared, general-purpose bookkeeping (calibration logging, audit trails, etc.) as often as it
   *  is the route's actual persistence step, so callers must only treat a followed helper's
   *  targets as belonging to THIS route's schema once independent evidence confirms that (see
   *  the overlap filter in checkWriteSchemaDrift) — otherwise unrelated helper writes produce a
   *  flood of false "field not in schema" reports. */
  source: string;
  /** Schema array-field names touched via a `for (const item of req.thatArray)` loop variable
   *  (e.g. `c.address` inside `for (const c of req.candidates)`). These are marked persisted but
   *  never field/column-checked directly — the array's ELEMENT shape is a separate nested schema
   *  this tool doesn't resolve, so comparing `address` against the top-level schema's fields would
   *  be comparing against the wrong shape entirely. */
  arrayFieldsTouched: string[];
}
export interface RouteWrite {
  file: string;
  method: string;
  routePath: string;
  fullPath: string | null;
  schemaName: string | null;
  writeTargets: WriteTarget[];
}

/** Extracts the schema field name a bound `.run(...)` argument reads, e.g. `parsed.data.foo` or
 *  `input.foo` -> `foo`. Also unwraps a single level of transform-call wrapping (`JSON.stringify
 *  (input.aliases)`, `String(input.x)`) so a field that is legitimately persisted through a
 *  serializer isn't misreported as silently discarded. Returns null for anything else (a literal,
 *  a multi-argument call, a ternary, `randomUUID()`, ...) — those aren't direct-or-wrapped field
 *  passthroughs and are intentionally left unchecked rather than risking a false match. */
const NON_FIELD_PROPERTY_NAMES = new Set(['length', 'lastInsertRowid', 'changes']);

export function extractBoundFieldName(expr: string): string | null {
  let e = expr.trim();
  const nullishIdx = e.indexOf('??');
  if (nullishIdx !== -1) e = e.slice(0, nullishIdx).trim();
  const chainMatch = /^[A-Za-z_$][\w$]*((?:\.[A-Za-z_$][\w$]*)+)$/.exec(e);
  if (chainMatch) {
    const segments = chainMatch[1]!.split('.').filter(Boolean);
    const last = segments[segments.length - 1] ?? null;
    // `req.candidates.length`, `ins.lastInsertRowid`, `result.changes` — derived properties of an
    // array or a better-sqlite3 RunResult, never a schema field of their own.
    if (last !== null && NON_FIELD_PROPERTY_NAMES.has(last)) return null;
    return last;
  }
  const callMatch = /^[A-Za-z_$][\w$.]*\(([\s\S]*)\)$/.exec(e);
  if (callMatch) {
    const callArgs = callMatch[1]!;
    if (splitTopLevel(callArgs, ',').length <= 1) return extractBoundFieldName(callArgs);
  }
  return null;
}

/** Many routes validate the body inline but delegate the actual write to a helper function
 *  (e.g. `onboardProperty(db, body)`, `addProspectEvent(db, event)`) defined elsewhere in
 *  server/**. Maps every top-level `function NAME(...) { ... }` (incl. `export`/`async`) across
 *  the given files to its body text, so a route handler's write targets can be resolved one call
 *  deep. Field-name extraction is parameter-name-agnostic (it only ever looks at the LAST
 *  `.segment` of a bound expression), so no cross-boundary parameter-name mapping is needed. */
export function collectFunctionBodies(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const declRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const file of files) {
    const content = safeRead(file);
    declRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(content))) {
      const parenOpenIdx = m.index + m[0].length - 1;
      const { endIdx: afterParams } = matchDelimited(content, parenOpenIdx);
      // Find the body's opening `{`. A `: ReturnType` annotation sits between the params and the
      // body, and when that return type is itself an inline object-type literal (this codebase's
      // `): { ok: boolean; ... } {` pattern) its brace pair is a decoy that looks exactly like a
      // body — detected by checking whether ANOTHER `{` immediately follows its close.
      let j = afterParams;
      let bodyStart = -1;
      while (j < content.length) {
        const skipped = skipNonCode(content, j);
        if (skipped !== j) {
          j = skipped;
          continue;
        }
        if (content[j] === ';') break;
        if (content[j] === '{') {
          const candidateEnd = matchDelimited(content, j).endIdx;
          let k = candidateEnd;
          while (k < content.length) {
            const s2 = skipNonCode(content, k);
            if (s2 !== k) {
              k = s2;
              continue;
            }
            if (/\s/.test(content[k] ?? '')) {
              k++;
              continue;
            }
            break;
          }
          if (content[k] === '{') {
            j = k; // decoy return-type object literal — keep looking from the next `{`
            continue;
          }
          bodyStart = j;
          break;
        }
        j++;
      }
      if (bodyStart === -1) continue; // a type-only overload/declaration — no body to scan
      const { inner: body } = matchDelimited(content, bodyStart);
      map.set(m[1]!, body);
    }
  }
  return map;
}

/** Maps `for (const c of req.candidates)`-style loop variables to the schema-field expression
 *  they iterate, so a bound value like `c.address` can be recognized as reading the ARRAY
 *  ELEMENT's own (unresolved, nested) shape rather than a top-level field literally named
 *  "address" on the route's schema. */
function collectForLoopAliases(handlerText: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\bfor\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(handlerText))) {
    map.set(m[1]!, m[2]!);
  }
  return map;
}

function rootIdentifier(expr: string): string {
  const m = /^[A-Za-z_$][\w$]*/.exec(expr.trim());
  return m ? m[0] : '';
}

/** Resolves a bare identifier to the RHS text of the last `const/let <identifier> = <rhs>;`
 *  appearing before `beforeIdx` in `handlerText`. Falls back to returning `identifier` unchanged
 *  if no such declaration is found (e.g. it's a function parameter, not a local alias). */
function resolveLocalAlias(handlerText: string, identifier: string, beforeIdx: number): string {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declRe = new RegExp(`(?:const|let)\\s+${escaped}\\s*=\\s*`, 'g');
  const scope = handlerText.slice(0, beforeIdx);
  let lastRhsStart = -1;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(scope))) {
    lastRhsStart = m.index + m[0].length;
  }
  if (lastRhsStart === -1) return identifier;
  let i = lastRhsStart;
  let depth = 0;
  while (i < handlerText.length) {
    const skipped = skipNonCode(handlerText, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = handlerText[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) break;
    i++;
  }
  return handlerText.slice(lastRhsStart, i).trim();
}

function extractWriteTargets(
  handlerText: string,
  functionBodies?: Map<string, string>,
  visited: Set<string> = new Set(),
  sourceLabel = 'inline',
): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const forLoopAliases = collectForLoopAliases(handlerText);
  const prepareRe = /\.prepare\(/g;
  let pm: RegExpExecArray | null;
  while ((pm = prepareRe.exec(handlerText))) {
    const openIdx = pm.index + pm[0].length - 1;
    const { inner: rawSqlArg, endIdx } = matchDelimited(handlerText, openIdx);
    const sqlArgs = splitTopLevel(rawSqlArg, ',');
    const sql = stripSqlComments(stripOuterQuotes((sqlArgs[0] ?? '').trim()));

    const insertMatch = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?([A-Za-z_]\w*)["`]?\s*\(/i.exec(sql);
    const updateMatch = !insertMatch ? /UPDATE\s+["`]?([A-Za-z_]\w*)["`]?\s+SET\s+/i.exec(sql) : null;
    if (!insertMatch && !updateMatch) continue;

    // Locate the .run(/.get( for this prepared statement. Usually it's chained immediately, but
    // a statement reused across a loop is typically assigned to a variable first (`const
    // insertCandidate = db.prepare(...)`) and called later (`insertCandidate.run(...)` inside a
    // `for`) — fall back to finding that named call anywhere later in the handler.
    let j = endIdx;
    while (j < handlerText.length && /\s/.test(handlerText[j] ?? '')) j++;
    let runArgs: string[] | null = null;
    let runCallIdx = -1;
    const runMatch = /^\.(run|get)\(/.exec(handlerText.slice(j));
    if (runMatch) {
      const runOpenIdx = j + runMatch[0].length - 1;
      const { inner } = matchDelimited(handlerText, runOpenIdx);
      runArgs = splitTopLevel(inner, ',').map((s) => s.trim());
      runCallIdx = runOpenIdx;
    } else {
      const beforePrepare = handlerText.slice(0, pm.index);
      const assignMatch = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*$/.exec(beforePrepare);
      if (assignMatch) {
        const varName = assignMatch[1]!;
        const laterText = handlerText.slice(endIdx);
        const namedRunMatch = new RegExp(`\\b${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(run|get)\\(`).exec(laterText);
        if (namedRunMatch) {
          const runOpenIdx = endIdx + namedRunMatch.index + namedRunMatch[0].length - 1;
          const { inner } = matchDelimited(handlerText, runOpenIdx);
          runArgs = splitTopLevel(inner, ',').map((s) => s.trim());
          runCallIdx = runOpenIdx;
        }
      }
    }
    // A bound argument that is itself a bare local variable (`const key = accountKey(input.account);
    // ...; .run(key, ...)`) hides the real field behind an alias — resolve it to whatever expression
    // last assigned that name before this call so field extraction can still see through it.
    if (runArgs && runCallIdx !== -1) {
      runArgs = runArgs.map((arg) => (/^[A-Za-z_$][\w$]*$/.test(arg) ? resolveLocalAlias(handlerText, arg, runCallIdx) : arg));
    }

    if (insertMatch) {
      const table = insertMatch[1]!;
      const colOpenIdx = insertMatch.index + insertMatch[0].length - 1;
      const { inner: colsInner } = matchDelimited(sql, colOpenIdx);
      const allColumns = splitTopLevel(colsInner, ',').map((s) => s.trim().replace(/["`]/g, '')).filter(Boolean);

      const valuesMatch = /VALUES\s*\(/i.exec(sql.slice(colOpenIdx));
      const bound: BoundColumn[] = [];
      const arrayFieldsTouched: string[] = [];
      if (valuesMatch) {
        const valuesOpenIdx = colOpenIdx + valuesMatch.index + valuesMatch[0].length - 1;
        const { inner: valuesInner } = matchDelimited(sql, valuesOpenIdx);
        const valueTokens = splitTopLevel(valuesInner, ',').map((s) => s.trim());
        let runIdx = 0;
        for (let i = 0; i < allColumns.length; i++) {
          const col = allColumns[i]!;
          const tok = valueTokens[i];
          if (tok === '?') {
            const argExpr = runArgs?.[runIdx] ?? null;
            const iteratedField = argExpr ? forLoopAliases.get(rootIdentifier(argExpr)) : undefined;
            if (iteratedField) {
              arrayFieldsTouched.push(iteratedField.split('.').pop()!);
              bound.push({ column: col, boundExpr: null });
            } else {
              bound.push({ column: col, boundExpr: argExpr });
            }
            runIdx++;
          }
        }
      }
      targets.push({ table, kind: 'INSERT', allColumns, bound, source: sourceLabel, arrayFieldsTouched });
    } else if (updateMatch) {
      const table = updateMatch[1]!;
      const setStart = updateMatch.index + updateMatch[0].length;
      const rest = sql.slice(setStart);
      const whereExec = /\bWHERE\b/i.exec(rest);
      const setClause = rest.slice(0, whereExec ? whereExec.index : rest.length);

      const allColumns: string[] = [];
      const bound: BoundColumn[] = [];
      const arrayFieldsTouched: string[] = [];
      let runIdx = 0;
      for (const raw of splitTopLevel(setClause, ',')) {
        const frag = raw.trim();
        if (frag.length === 0) continue;
        const eqIdx = frag.indexOf('=');
        if (eqIdx === -1) continue;
        const col = frag.slice(0, eqIdx).trim().replace(/["`]/g, '');
        const valueExpr = frag.slice(eqIdx + 1).trim();
        allColumns.push(col);
        if (valueExpr === '?') {
          const argExpr = runArgs?.[runIdx] ?? null;
          const iteratedField = argExpr ? forLoopAliases.get(rootIdentifier(argExpr)) : undefined;
          if (iteratedField) {
            arrayFieldsTouched.push(iteratedField.split('.').pop()!);
            bound.push({ column: col, boundExpr: null });
          } else {
            bound.push({ column: col, boundExpr: argExpr });
          }
          runIdx++;
        }
      }
      targets.push({ table, kind: 'UPDATE', allColumns, bound, source: sourceLabel, arrayFieldsTouched });
    }
  }

  if (functionBodies) {
    const callRe = /\b([A-Za-z_$][\w$]*)\(/g;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(handlerText))) {
      const name = cm[1]!;
      if (visited.has(name)) continue;
      const body = functionBodies.get(name);
      if (!body) continue;
      visited.add(name);
      targets.push(...extractWriteTargets(body, functionBodies, visited, name));
    }
  }
  return targets;
}

/** Finds every `app.post/put/patch(...)` registration in `content` and extracts its route path,
 *  the Zod schema it validates the body against (the identifier of the first `.safeParse(` call
 *  in the handler — this codebase's exclusive convention for input validation; `.parse(` alone is
 *  used only to validate outgoing response payloads), and every write target inside it. */
export function findRouteWrites(content: string, file: string, functionBodies?: Map<string, string>): RouteWrite[] {
  const routes: RouteWrite[] = [];
  const routeRe = /app\.(post|put|patch)\(/g;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(content))) {
    const method = m[1]!;
    const openIdx = m.index + m[0].length - 1;
    const { inner: argsText } = matchDelimited(content, openIdx);

    const pathMatch = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/.exec(argsText);
    if (!pathMatch) continue;
    const routePath = pathMatch[2]!;

    const parseMatch = /([A-Za-z_$][\w$]*)\.safeParse\(/.exec(argsText);
    const schemaName = parseMatch ? parseMatch[1]! : null;

    routes.push({
      file,
      method,
      routePath,
      fullPath: null,
      schemaName,
      writeTargets: extractWriteTargets(argsText, functionBodies),
    });
  }
  return routes;
}

// ── Route mount-path resolution ───────────────────────────────────────────────────────────────

function extractLocalImports(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*(['"`])(\.[^'"`]+)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const importPath = m[3]!;
    const file = importPath.split('/').pop() ?? importPath;
    for (const raw of m[1]!.split(',')) {
      const clean = raw.split(/\s+as\s+/)[0]?.trim();
      if (clean) map.set(clean, file);
    }
  }
  return map;
}

/** Builds file-basename -> full mount-path-prefix, by reading server/index.ts's static
 *  `app.route('/literal', factory(...))` calls and server/warehouse/sub-routers.ts's prefix
 *  table (both read live — never hardcoded — so this stays correct as sub-routers are added). */
export function buildMountPrefixMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const indexPath = join(root, 'server', 'index.ts');
  let subRouterHead = '/api/warehouse';
  if (existsSync(indexPath)) {
    const content = safeRead(indexPath);
    const importToFile = extractLocalImports(content);
    const staticRe = /app\.route\(\s*(['"`])([^'"`]+)\1\s*,\s*([A-Za-z_$][\w$]*)\(/g;
    let m: RegExpExecArray | null;
    while ((m = staticRe.exec(content))) {
      const file = importToFile.get(m[3]!);
      if (file) map.set(file.replace(/\.ts$/, ''), m[2]!);
    }
    const dynamicHead = /app\.route\(\s*`([^`$]+)\$\{/.exec(content);
    if (dynamicHead) subRouterHead = dynamicHead[1]!;
  }
  const subRoutersPath = join(root, 'server', 'warehouse', 'sub-routers.ts');
  if (existsSync(subRoutersPath)) {
    const content = safeRead(subRoutersPath);
    const importToFile = extractLocalImports(content);
    const entryRe = /\{\s*prefix:\s*(['"`])([^'"`]+)\1\s*,\s*factory:\s*([A-Za-z_$][\w$]*)\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(content))) {
      const file = importToFile.get(m[3]!);
      if (file) map.set(file.replace(/\.ts$/, ''), `${subRouterHead}${m[2]!}`);
    }
  }
  return map;
}

function baseNameNoExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.[^.]+$/, '');
}

/** Full route path = literal path as-is when the route is registered directly on `app` (path
 *  already starts with `/api/`), otherwise mountPrefix + routePath for a sub-router file. */
export function resolveFullPath(route: RouteWrite, mountPrefixes: Map<string, string>): string | null {
  if (route.routePath.startsWith('/api/')) return route.routePath;
  const prefix = mountPrefixes.get(baseNameNoExt(route.file));
  return prefix ? `${prefix}${route.routePath}` : null;
}

/** Normalizes a route/URL path for cross-referencing: collapses `:param` segments and
 *  `${...}` template interpolations to a single wildcard token, and drops a trailing slash. */
export function normalizePath(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z_$][\w$]*/g, '*')
    .replace(/\/+$/, '');
}

// ── Frontend payload discovery (best-effort) ──────────────────────────────────────────────────

export type PayloadSource = 'inline' | 'typed' | 'unresolved';
export interface FrontendCall {
  file: string;
  method: string;
  pathText: string;
  payloadSource: PayloadSource;
  fields: Set<string>; // only meaningful when payloadSource !== 'unresolved'
}

function resolveParamType(prefixText: string, identifier: string): string | null {
  const re = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prefixText))) last = m[1]!;
  return last;
}

/** Finds every `fetch(...)` call in `content` with a POST/PUT/PATCH method and a JSON body,
 *  resolving the body's field names either from an inline object literal or (best-effort) from
 *  the declared TS type of a bare identifier argument via `registry`. */
export function findFrontendWriteCalls(
  content: string,
  file: string,
  registry: Map<string, RawDecl>,
): FrontendCall[] {
  const calls: FrontendCall[] = [];
  const fetchRe = /\bfetch\(/g;
  let m: RegExpExecArray | null;
  while ((m = fetchRe.exec(content))) {
    const openIdx = m.index + m[0].length - 1;
    const { inner: argsText } = matchDelimited(content, openIdx);
    const parts = splitTopLevel(argsText, ',');
    const pathArg = (parts[0] ?? '').trim();
    const optionsArg = parts.slice(1).join(',');
    if (!optionsArg) continue;

    const methodMatch = /method\s*:\s*(['"`])(\w+)\1/.exec(optionsArg);
    const method = (methodMatch ? methodMatch[2]! : 'GET').toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) continue;

    const pathTextMatch = /^(['"`])([\s\S]*)\1$/.exec(pathArg);
    const pathText = pathTextMatch ? pathTextMatch[2]! : pathArg;

    const bodyMatch = /body\s*:\s*JSON\.stringify\(/.exec(optionsArg);
    if (!bodyMatch) {
      calls.push({ file, method, pathText, payloadSource: 'unresolved', fields: new Set() });
      continue;
    }
    const bodyOpenIdx = bodyMatch.index + bodyMatch[0].length - 1;
    const { inner: bodyArg } = matchDelimited(optionsArg, bodyOpenIdx);
    const trimmed = bodyArg.trim();

    if (trimmed.startsWith('{')) {
      const { inner: objInner } = matchDelimited(trimmed, 0);
      const fields = new Set(parseObjectLiteralFields(objInner).keys());
      calls.push({ file, method, pathText, payloadSource: 'inline', fields });
      continue;
    }

    const identMatch = /^[A-Za-z_$][\w$]*$/.exec(trimmed);
    if (identMatch) {
      const typeName = resolveParamType(content.slice(0, m.index), trimmed);
      const schema = typeName ? resolveSchema(typeName, registry) : null;
      if (schema) {
        calls.push({ file, method, pathText, payloadSource: 'typed', fields: new Set(schema.fields.keys()) });
        continue;
      }
    }
    calls.push({ file, method, pathText, payloadSource: 'unresolved', fields: new Set() });
  }
  return calls;
}

// ── Field-name-derived server columns that are never expected to come from request-body data ───
// `id` is either server-generated on create (randomUUID()) or the WHERE-key on update — in this
// codebase's convention it is never itself a SET-clause value, so it's excluded from the
// "validated field never persisted" check to avoid a structural false positive on every
// create-or-update handler.
const NEVER_PERSISTED_EXEMPT = new Set(['id']);

// ── The check itself ──────────────────────────────────────────────────────────────────────────

/** Runs the full write-schema drift check against a checkout rooted at `root`. */
export function checkWriteSchemaDrift(root: string): DriftResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const tables = collectMigrationColumns(root);
  const registry = new Map<string, RawDecl>();

  const contractFiles = collectFiles(root, 'src/contracts', ['.ts']);
  const serverFiles = collectFiles(root, 'server', ['.ts']);
  for (const file of [...contractFiles, ...serverFiles]) {
    collectDeclarations(safeRead(file), file, registry);
  }

  const mountPrefixes = buildMountPrefixMap(root);
  const functionBodies = collectFunctionBodies(serverFiles);

  const routes: RouteWrite[] = [];
  for (const file of serverFiles) {
    const content = safeRead(file);
    for (const route of findRouteWrites(content, file, functionBodies)) {
      route.fullPath = resolveFullPath(route, mountPrefixes);
      routes.push(route);
    }
  }
  if (routes.length === 0) return { pass: true, errors, warnings: ['no POST/PUT/PATCH routes found under server/ — check skipped'] };

  const frontendFiles = collectFiles(root, 'src', ['.ts', '.tsx']);
  const frontendCalls: FrontendCall[] = [];
  for (const file of frontendFiles) {
    frontendCalls.push(...findFrontendWriteCalls(safeRead(file), file, registry));
  }

  for (const route of routes) {
    const label = `${route.method.toUpperCase()} ${route.fullPath ?? route.routePath} (${route.file})`;

    if (!route.schemaName) {
      warnings.push(`NO_INPUT_SCHEMA: ${label} — no .safeParse( found; input validation and field drift can't be checked`);
      continue;
    }
    const schema = resolveSchema(route.schemaName, registry);
    if (!schema) {
      warnings.push(`UNRESOLVED_SCHEMA: ${label} — could not statically resolve schema '${route.schemaName}'`);
      continue;
    }
    if (route.writeTargets.length === 0) {
      warnings.push(`NO_WRITE_TARGET: ${label} — validates '${route.schemaName}' but no INSERT/UPDATE was found in the handler`);
      continue;
    }

    // A followed helper function (source !== 'inline') is admitted only if at least one of the
    // fields it actually binds overlaps this route's schema — a helper called from many routes
    // for unrelated bookkeeping (calibration logging, audit trails, hash computation, ...) will
    // have zero overlap and is silently excluded rather than compared field-by-field against a
    // schema it has nothing to do with.
    const relevantTargets = route.writeTargets.filter((t) => {
      if (t.source === 'inline') return true;
      return t.bound.some((b) => {
        const f = b.boundExpr ? extractBoundFieldName(b.boundExpr) : null;
        return f !== null && schema.fields.has(f);
      });
    });
    if (relevantTargets.length === 0) {
      warnings.push(`NO_WRITE_TARGET: ${label} — validates '${route.schemaName}' but no INSERT/UPDATE bound to one of its fields was found (inline or one call deep)`);
      continue;
    }

    const persistedFields = new Set<string>();

    for (const target of relevantTargets) {
      const tableCols = tables.get(target.table);
      if (!tableCols) {
        warnings.push(`UNKNOWN_TABLE: ${label} — ${target.kind} into '${target.table}', not defined by any migration`);
      }
      for (const f of target.arrayFieldsTouched) persistedFields.add(f);

      // Precise check: every parameterized column's bound expression, cross-referenced against
      // the schema field it claims to read.
      for (const { column, boundExpr } of target.bound) {
        if (boundExpr === null) continue;
        const fieldName = extractBoundFieldName(boundExpr);
        if (!fieldName) continue; // a literal or a computed expression — not a direct passthrough
        persistedFields.add(fieldName);

        // Non-blocking: a column genuinely named differently from its schema field (a foreign-key
        // column, a deliberately-renamed one) is legitimate and common — this is a nudge to
        // double-check, not a confirmed defect, so it must never fail the gate on correct code.
        const expectedColumn = camelToSnake(fieldName);
        if (column !== expectedColumn && column !== fieldName) {
          warnings.push(
            `COLUMN_FIELD_MISMATCH: ${label} — column '${target.table}.${column}' is bound to ` +
              `'${boundExpr}' (schema field '${fieldName}'), which maps to column ` +
              `'${expectedColumn}', not '${column}'. Verify this is intentional (e.g. a foreign-key ` +
              `rename), not a copy-paste reorder.`,
          );
        }
        if (!schema.fields.has(fieldName)) {
          errors.push(
            `FIELD_NOT_IN_SCHEMA: ${label} — handler reads '.${fieldName}' from the parsed body ` +
              `for column '${target.table}.${column}', but schema '${route.schemaName}' has no ` +
              `field named '${fieldName}' (undefined at runtime).`,
          );
        }
      }

      // Coarse check: NOT NULL / no-default columns the statement never references at all. INSERT
      // only — an UPDATE legitimately touches a subset of a table's columns (that's the point of
      // SET), so this check would otherwise fire on essentially every correct UPDATE statement.
      if (tableCols && target.kind === 'INSERT') {
        for (const [col, info] of tableCols) {
          if (info.notNull && !info.hasDefault && !target.allColumns.includes(col)) {
            warnings.push(
              `NOT_NULL_COLUMN_UNSET: ${label} — INSERT into '${target.table}' never references ` +
                `NOT-NULL column '${col}' (no DEFAULT) — the insert will fail unless another code ` +
                `path sets it`,
            );
          }
        }
      }
    }

    // Every required (non-optional, no-default, non-nullable) schema field should be persisted
    // by at least one write target somewhere in this handler.
    for (const [fieldName, info] of schema.fields) {
      if (info.optional || info.hasDefault || info.nullable) continue;
      if (NEVER_PERSISTED_EXEMPT.has(fieldName)) continue;
      if (!persistedFields.has(fieldName)) {
        errors.push(
          `FIELD_NOT_PERSISTED: ${label} — schema '${route.schemaName}' requires '${fieldName}' ` +
            `but no INSERT/UPDATE in this handler binds it to a column — the validated value is ` +
            `silently discarded.`,
        );
      }
    }

    // Best-effort frontend cross-check.
    if (route.fullPath) {
      const normalizedRoute = normalizePath(route.fullPath);
      const callers = frontendCalls.filter((c) => normalizePath(c.pathText) === normalizedRoute);
      if (callers.length === 0) {
        warnings.push(`NO_FRONTEND_CALLER: ${label} — no matching fetch() call found under src/ (may be script/backfill-only)`);
      }
      for (const caller of callers) {
        if (caller.payloadSource === 'unresolved') {
          warnings.push(`PAYLOAD_UNRESOLVED: ${label} — caller at ${caller.file} sends a body this check couldn't statically shape-check`);
          continue;
        }
        for (const key of caller.fields) {
          if (!schema.fields.has(key)) {
            errors.push(
              `FORM_FIELD_UNKNOWN_TO_SCHEMA: ${label} — caller at ${caller.file} sends key ` +
                `'${key}', which schema '${route.schemaName}' does not declare — Zod silently ` +
                `strips it before it ever reaches the handler.`,
            );
          }
        }
        if (caller.payloadSource === 'inline') {
          for (const [fieldName, info] of schema.fields) {
            if (info.optional || info.hasDefault) continue;
            if (!caller.fields.has(fieldName)) {
              errors.push(
                `REQUIRED_FIELD_NOT_SENT: ${label} — schema '${route.schemaName}' requires ` +
                  `'${fieldName}' but caller at ${caller.file} never sends it — every request from ` +
                  `this call site will 400.`,
              );
            }
          }
        }
      }
    } else {
      warnings.push(`MOUNT_PATH_UNRESOLVED: ${label} — could not resolve this file's mount prefix; frontend cross-check skipped`);
    }
  }

  return { pass: errors.length === 0, errors, warnings };
}

/** Run the check, print results, and exit with the appropriate code. */
function main(): void {
  const root = process.cwd();
  const result = checkWriteSchemaDrift(root);

  if (result.warnings.length > 0) {
    console.warn('\n⚠  Write-schema drift check warnings (non-blocking, reduced coverage):');
    for (const w of result.warnings) console.warn(`   ${w}`);
  }
  if (result.errors.length > 0) {
    console.error('\n✖  Write-schema drift check FAILED:');
    for (const e of result.errors) console.error(`   ${e}`);
    console.error(
      '\nEach of these is a write path where the validated request body, the SQL actually ' +
        'executed, or the caller sending it have drifted apart. Fix the mismatch before ' +
        'proceeding — this is exactly the failure class that shipped silently for ~3 months ' +
        'across 4 schemas.\n',
    );
    process.exit(1);
  }
  console.log('✔  Write-schema drift check passed.');
}

if (process.argv[1] && process.argv[1].endsWith('check-write-schema-drift.ts')) {
  main();
}
