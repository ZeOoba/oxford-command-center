// scripts/property-financials/lib/sources.ts — walk the statement folder and parse every file it
// can into raw records (plan T9b, part 1). Configuration: config/sources.json; parsing:
// src/analytics/property-financials/parse-statements.ts (pure); reading: lib/excel.ts (exceljs).
//
// Policy, enforced rather than defaulted:
//   * a folder / file whose entity matches the account mapping's `excludedEntities` (Northwood) is
//     skipped BEFORE it is opened and reported under `excluded`;
//   * an entity that is neither excluded nor in config/entities.json fails the run;
//   * a binary .xls is read from its converted twin (<folder leaf>__<basename>.xlsx in the converted
//     directory) or reported under `unreadable` — never guessed at;
//   * a file of any other extension, or a readable workbook in a layout no parser supports (the
//     AppFolio "Cash Flow" annual variant), is reported under `unsupported` with the reason;
//   * two files that both carry the same (entity, period) must agree record for record, otherwise
//     the run fails naming both files;
//   * a StatementParseError (totals that do not tie, missing headers) propagates: nothing is skipped.
// Roles: PM-folder statements and the QuickBooks entity statements feed the dataset; the annual
// AppFolio / Yardi statements of monthly entities are kept apart as `crosscheck` records (they must
// never enter monthly-long.csv) for the annual-vs-monthly reconciliation the CLI prints.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { EntityRegistry } from '../../../src/analytics/property-financials/build-dataset';
import type { AccountMapping, RawRecord } from '../../../src/analytics/property-financials/normalize';
import { parseStatement, STATEMENT_LAYOUTS, StatementParseError, type ParsedStatement, type StatementLayout } from '../../../src/analytics/property-financials/parse-statements';
import { pickStatementSheet, readWorkbookSheets } from './excel';

// -------------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------------

export interface PmFolder {
  readonly folder: string;
  readonly entity: string;
  readonly layout: StatementLayout;
}

export interface SourcesConfig {
  readonly version: string;
  readonly sourceDirEnv: string;
  readonly sourceDirDefault: string;
  readonly convertedDirEnv: string;
  readonly pmFolders: readonly PmFolder[];
  readonly entityStatements: { readonly pattern: string; readonly entityGroup: number };
  readonly readableExtensions: readonly string[];
  readonly convertRequiredExtensions: readonly string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needString(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: ${k} must be a non-empty string`);
  return v;
}

export function parseSourcesConfig(json: unknown): SourcesConfig {
  if (!isRecord(json)) throw new Error('sources config: expected an object');
  const where = 'sources config';
  if (!Array.isArray(json.pmFolders) || json.pmFolders.length === 0) throw new Error(`${where}: pmFolders must be a non-empty array`);
  const seen = new Set<string>();
  const pmFolders = json.pmFolders.map((f, i): PmFolder => {
    const w = `${where} pmFolders[${i}]`;
    if (!isRecord(f)) throw new Error(`${w}: must be an object`);
    const folder = needString(f, 'folder', w);
    if (seen.has(folder)) throw new Error(`${w}: duplicate folder ${folder}`);
    seen.add(folder);
    const layout = needString(f, 'layout', w);
    if (!(STATEMENT_LAYOUTS as readonly string[]).includes(layout)) throw new Error(`${w}: layout must be one of ${STATEMENT_LAYOUTS.join(', ')}`);
    return { folder, entity: needString(f, 'entity', w), layout: layout as StatementLayout };
  });
  const es = json.entityStatements;
  if (!isRecord(es)) throw new Error(`${where}: entityStatements must be an object`);
  const pattern = needString(es, 'pattern', `${where} entityStatements`);
  new RegExp(pattern);
  if (typeof es.entityGroup !== 'number' || !(es.entityGroup >= 1)) throw new Error(`${where}: entityStatements.entityGroup must be a positive group index`);
  const list = (k: string): string[] => {
    const v = json[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.startsWith('.'))) throw new Error(`${where}: ${k} must be a list of ".ext" strings`);
    return v as string[];
  };
  return {
    version: needString(json, 'version', where),
    sourceDirEnv: needString(json, 'sourceDirEnv', where),
    sourceDirDefault: needString(json, 'sourceDirDefault', where),
    convertedDirEnv: needString(json, 'convertedDirEnv', where),
    pmFolders,
    entityStatements: { pattern, entityGroup: es.entityGroup },
    readableExtensions: list('readableExtensions').map((e) => e.toLowerCase()),
    convertRequiredExtensions: list('convertRequiredExtensions').map((e) => e.toLowerCase()),
  };
}

/** Resolve the source directory: explicit > $PF_SOURCE_DIR > config default. */
export function resolveSourceDir(cfg: SourcesConfig, explicit?: string): string {
  return explicit ?? process.env[cfg.sourceDirEnv]?.trim() ?? cfg.sourceDirDefault;
}

export function resolveConvertedDir(cfg: SourcesConfig, explicit?: string): string | null {
  const v = explicit ?? process.env[cfg.convertedDirEnv]?.trim();
  return v ? v : null;
}

/** The converted twin's basename for a binary source file: "<folder leaf>__<basename>.xlsx". */
export function convertedName(sourcePath: string): string {
  const leaf = basename(join(sourcePath, '..'));
  return `${leaf}__${basename(sourcePath, extname(sourcePath))}.xlsx`;
}

// -------------------------------------------------------------------------------------------------
// Collection
// -------------------------------------------------------------------------------------------------

export type SourceRole = 'dataset' | 'crosscheck';

export interface SourceFileResult {
  readonly file: string;
  readonly readFrom: string;
  readonly entity: string;
  readonly layout: StatementLayout;
  readonly role: SourceRole;
  readonly periods: readonly string[];
  readonly records: number;
  readonly totalChecks: number;
  readonly ignoredHeaders: readonly string[];
  /** CF `TOTAL X` lines naming no group opened in the statement: printed and counted, not verified. */
  readonly unmatchedTotals: readonly string[];
  /** The export carried no rows ("No activity for given filter criteria"). */
  readonly emptyReason: string | null;
}

export interface SkippedFile {
  readonly file: string;
  readonly reason: string;
}

export interface ExcludedFile extends SkippedFile {
  readonly entity: string;
  readonly pattern: string;
}

export interface EntityCoverage {
  readonly entity: string;
  readonly role: SourceRole;
  readonly files: number;
  readonly periods: readonly string[];
}

export interface SourcesReport {
  readonly sourceDir: string;
  readonly convertedDir: string | null;
  readonly files: readonly SourceFileResult[];
  /** Binary .xls with no converted twin. */
  readonly unreadable: readonly SkippedFile[];
  /** Other extensions, or a readable workbook in an unsupported layout. */
  readonly unsupported: readonly SkippedFile[];
  /** Northwood (excludedEntities): never opened. */
  readonly excluded: readonly ExcludedFile[];
  /** (entity, period) carried by two files with identical records — kept once. */
  readonly duplicatePeriods: readonly string[];
  readonly coverage: readonly EntityCoverage[];
}

export interface CollectedSources {
  readonly dataset: RawRecord[];
  readonly crosscheck: RawRecord[];
  readonly report: SourcesReport;
}

export interface CollectOptions {
  readonly sourceDir: string;
  readonly convertedDir: string | null;
  readonly mapping: Pick<AccountMapping, 'excludedEntities'>;
  readonly registry: EntityRegistry;
  /** Test seam: defaults to exceljs via lib/excel.ts. */
  readonly readSheets?: (path: string) => Promise<ParsedStatementInput>;
}

export type ParsedStatementInput = Parameters<typeof parseStatement>[0];

async function defaultReadSheets(path: string): Promise<ParsedStatementInput> {
  return pickStatementSheet(await readWorkbookSheets(path), path);
}

function excludedBy(entity: string, mapping: Pick<AccountMapping, 'excludedEntities'>): { pattern: string; reason: string } | null {
  for (const e of mapping.excludedEntities) if (new RegExp(e.pattern, 'i').test(entity)) return e;
  return null;
}

function recordKey(r: RawRecord): string {
  return [r.layout, r.section ?? '', r.group ?? '', r.account, r.amount, r.isTotal ? 1 : 0].join('\u0001');
}

function sameRecords(a: readonly RawRecord[], b: readonly RawRecord[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(recordKey).sort();
  const kb = b.map(recordKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
    .sort();
}

export async function collectSourceRecords(cfg: SourcesConfig, opts: CollectOptions): Promise<CollectedSources> {
  const read = opts.readSheets ?? defaultReadSheets;
  const kinds = new Map(opts.registry.entities.map((e) => [e.id, e.kind]));
  const rel = (p: string) => relative(opts.sourceDir, p).split('\\').join('/');

  const files: SourceFileResult[] = [];
  const unreadable: SkippedFile[] = [];
  const unsupported: SkippedFile[] = [];
  const excluded: ExcludedFile[] = [];
  const duplicatePeriods: string[] = [];
  const dataset: RawRecord[] = [];
  const crosscheck: RawRecord[] = [];
  /** (role, entity, period) -> records + file, for the duplicate check. */
  const seen = new Map<string, { file: string; records: RawRecord[] }>();
  const coverage = new Map<string, { role: SourceRole; files: number; periods: Set<string> }>();

  const admit = (parsed: ParsedStatement, role: SourceRole, file: string): void => {
    const byPeriod = new Map<string, RawRecord[]>();
    for (const r of parsed.records) {
      const list = byPeriod.get(r.period) ?? [];
      list.push(r);
      byPeriod.set(r.period, list);
    }
    const cov = coverage.get(`${role}\u0001${parsed.entity}`) ?? { role, files: 0, periods: new Set<string>() };
    cov.files++;
    for (const [period, records] of byPeriod) {
      const key = `${role}\u0001${parsed.entity}\u0001${period}`;
      const prior = seen.get(key);
      if (prior) {
        if (!sameRecords(prior.records, records)) {
          throw new Error(`${parsed.entity} ${period} appears in both ${prior.file} and ${file} with different records — remove or reconcile one of them`);
        }
        duplicatePeriods.push(`${parsed.entity} ${period} (${prior.file} = ${file})`);
        continue;
      }
      seen.set(key, { file, records });
      cov.periods.add(period);
      (role === 'dataset' ? dataset : crosscheck).push(...records);
    }
    coverage.set(`${role}\u0001${parsed.entity}`, cov);
  };

  const parseOne = async (path: string, entity: string, layout: StatementLayout | undefined, role: SourceRole): Promise<void> => {
    const ext = extname(path).toLowerCase();
    let readFrom = path;
    if (cfg.convertRequiredExtensions.includes(ext)) {
      const twin = opts.convertedDir ? join(opts.convertedDir, convertedName(path)) : null;
      if (!twin || !existsSync(twin)) {
        unreadable.push({ file: rel(path), reason: `binary ${ext} (OLE2) — exceljs cannot read it; convert to ${convertedName(path)} in the converted directory (see README "Binary .xls exports")` });
        return;
      }
      readFrom = twin;
    } else if (!cfg.readableExtensions.includes(ext)) {
      unsupported.push({ file: rel(path), reason: `${ext || '(no extension)'} is not a statement workbook` });
      return;
    }
    const sheet = { ...(await read(readFrom)), file: rel(path) };
    let parsed: ParsedStatement;
    try {
      parsed = parseStatement(sheet, layout === undefined ? { entity } : { entity, layout });
    } catch (e) {
      if (e instanceof StatementParseError && e.row === null && /unsupported statement layout/.test(e.detail)) {
        unsupported.push({ file: rel(path), reason: e.detail });
        return;
      }
      throw e;
    }
    admit(parsed, role, rel(path));
    files.push({
      file: rel(path),
      readFrom: readFrom === path ? 'source' : `converted:${basename(readFrom)}`,
      entity,
      layout: parsed.layout,
      role,
      periods: parsed.periods,
      records: parsed.records.length,
      totalChecks: parsed.totalChecks,
      ignoredHeaders: parsed.ignoredHeaders,
      unmatchedTotals: parsed.unmatchedTotals,
      emptyReason: parsed.emptyReason,
    });
  };

  // PM folders
  for (const pm of cfg.pmFolders) {
    const dir = join(opts.sourceDir, pm.folder);
    const hit = excludedBy(pm.entity, opts.mapping);
    const members = listFiles(dir);
    if (hit) {
      for (const f of members) excluded.push({ file: rel(f), entity: pm.entity, pattern: hit.pattern, reason: hit.reason });
      if (members.length === 0) excluded.push({ file: `${pm.folder}/`, entity: pm.entity, pattern: hit.pattern, reason: `${hit.reason} (folder empty)` });
      continue;
    }
    if (!kinds.has(pm.entity)) throw new Error(`sources.json folder "${pm.folder}" names entity "${pm.entity}", which is not in config/entities.json`);
    for (const f of members) await parseOne(f, pm.entity, pm.layout, 'dataset');
  }

  // Top-level entity statements
  const re = new RegExp(cfg.entityStatements.pattern);
  for (const f of listFiles(opts.sourceDir)) {
    const m = re.exec(basename(f));
    if (!m) {
      unsupported.push({ file: rel(f), reason: 'top-level file does not match the entityStatements pattern' });
      continue;
    }
    const entity = m[cfg.entityStatements.entityGroup]!.trim();
    const hit = excludedBy(entity, opts.mapping);
    if (hit) {
      excluded.push({ file: rel(f), entity, pattern: hit.pattern, reason: hit.reason });
      continue;
    }
    const kind = kinds.get(entity);
    if (kind === undefined) throw new Error(`${rel(f)} names entity "${entity}", which is not in config/entities.json (and matches no excludedEntities pattern)`);
    await parseOne(f, entity, undefined, kind === 'annual' ? 'dataset' : 'crosscheck');
  }

  const coverageList: EntityCoverage[] = [...coverage.entries()]
    .map(([k, v]) => ({ entity: k.split('\u0001')[1]!, role: v.role, files: v.files, periods: [...v.periods].sort() }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.entity.localeCompare(b.entity));

  return {
    dataset,
    crosscheck,
    report: { sourceDir: opts.sourceDir, convertedDir: opts.convertedDir, files, unreadable, unsupported, excluded, duplicatePeriods, coverage: coverageList },
  };
}
