/**
 * Detect the two ways an openpyxl re-save corrupts the ORA Master Workbook for exceljs.
 *
 * INCIDENT (2026-08-13/14). The `excel` MCP server (excel-mcp-server) is openpyxl-backed
 * and load-then-saves in place. A session used it against the Master Workbook at
 * 19:11 ET on 2026-08-13, producing a file with two independent defects:
 *
 *   DEFECT 1 - unresolvable comment relationships. openpyxl writes worksheet comment /
 *   vmlDrawing rel targets as ABSOLUTE ("/xl/comments/comment1.xml"); Excel writes them
 *   RELATIVE ("../comments1.xml"). exceljs keys options.comments by the relative form, so
 *   WorkSheetXform.reconcile() dereferences undefined and throws
 *   "Cannot read properties of undefined (reading 'comments')". The stack points into
 *   node_modules and names no file, which cost real diagnosis time across three consumers
 *   (ora-lease-snapshot-refresh Exit 3, ora-cc-snapshot-refresh, and 9 consecutive Mirror
 *   Deploy failures surfacing only as "build:mirror failed (1)").
 *
 *   DEFECT 2 - stripped cached values. openpyxl does not evaluate formulas, so a re-save
 *   drops the cached result of every formula cell: 14,711 of 14,715 on the incident file.
 *   exceljs reads CACHED values, so a workbook in this state parses "successfully" while
 *   yielding null for essentially every computed figure - rent, NOI, debt service, DSCR.
 *
 * WHY THIS IS A DETECTOR AND NOT A NORMALIZER. The obvious fix is to rewrite the absolute
 * rel targets and carry on. That would be actively dangerous: it repairs DEFECT 1 only,
 * so the parse would then SUCCEED on a workbook whose financial values are all null, and
 * a null-filled snapshot would flow to portfolio.json, the alerts engine, and the public
 * mirror. The crash was protective. This module therefore converts an opaque crash into a
 * precise, named refusal, and adds a second refusal for the silent case - it never makes a
 * corrupt workbook readable.
 *
 * The real repair is to re-save through Excel (full rebuild restores both the relative rels
 * and the cached values). See
 * memory/reference_openpyxl_resave_breaks_exceljs_workbook_parse_2026-08-14.md
 */
import ExcelJS from 'exceljs';
import type { Workbook } from 'exceljs';

/** Minimum formula cells before the cached-value ratio is meaningful. */
const MIN_FORMULA_CELLS = 100;

/** Fraction of formula cells missing a cached result that indicates a stripped workbook. */
const STRIPPED_RATIO = 0.5;

const REPAIR_HINT =
  'Repair: open the workbook in Excel and re-save it (SaveAs, .xlsx) - a full rebuild ' +
  'restores both the relative comment relationships and the cached formula values. ' +
  'Never re-save this workbook with openpyxl or the `excel` MCP server. ' +
  'See memory/reference_openpyxl_resave_breaks_exceljs_workbook_parse_2026-08-14.md';

/**
 * Recognize the exceljs reconcile crash caused by openpyxl's absolute comment rel targets.
 * Returns an actionable message, or null if this is some other error.
 */
export function describeOpenpyxlReadFailure(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!/Cannot read propert(?:y|ies) of undefined \(reading '?comments'?\)/.test(message)) {
    return null;
  }
  return (
    'Workbook is unreadable by exceljs: worksheet comment relationships use ABSOLUTE ' +
    'targets ("/xl/comments/comment1.xml") instead of Excel\'s relative form ' +
    '("../comments1.xml"), so exceljs cannot resolve them and throws while reconciling ' +
    `comments (underlying error: ${message}). ` +
    'This is the signature of an openpyxl re-save (the `excel` MCP server is ' +
    'openpyxl-backed). ' +
    REPAIR_HINT
  );
}

export interface CachedValueAudit {
  formulaCells: number;
  missingCached: number;
  /** Fraction of formula cells with no cached result; 0 when there are no formula cells. */
  missingRatio: number;
  /** True once the sample is large enough AND most cached values are gone. */
  stripped: boolean;
}

/**
 * Count formula cells whose cached result exceljs cannot see.
 *
 * A healthy Excel-saved workbook keeps a cached result for nearly every formula (the
 * incident's repaired file: 14,517 of 14,715, ~98.7%). An openpyxl re-save keeps almost
 * none (4 of 14,715, ~0.03%). The 50% threshold sits far from both, so ordinary workbooks
 * with a handful of uncalculated cells never trip it.
 */
export function auditCachedValues(wb: Workbook): CachedValueAudit {
  let formulaCells = 0;
  let missingCached = 0;

  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.type !== ExcelJS.ValueType.Formula) return;
        formulaCells += 1;
        const { result } = cell as { result?: unknown };
        if (result === undefined || result === null) missingCached += 1;
      });
    });
  });

  const missingRatio = formulaCells === 0 ? 0 : missingCached / formulaCells;
  return {
    formulaCells,
    missingCached,
    missingRatio,
    stripped: formulaCells >= MIN_FORMULA_CELLS && missingRatio > STRIPPED_RATIO,
  };
}

/**
 * Throw when a workbook parsed cleanly but lost its cached formula results.
 *
 * Without this, DEFECT 2 is silent: the parse succeeds and every computed figure reads as
 * null, which downstream gates would interpret as real portfolio movement.
 */
export function assertCachedValuesPresent(wb: Workbook, path: string): void {
  const audit = auditCachedValues(wb);
  if (!audit.stripped) return;

  const pct = (audit.missingRatio * 100).toFixed(1);
  throw new Error(
    `Workbook parsed but its cached formula values are missing: ${audit.missingCached} of ` +
      `${audit.formulaCells} formula cells (${pct}%) have no cached result, so computed ` +
      'figures (rent, NOI, debt service, DSCR) would all read as null. This is the ' +
      'signature of an openpyxl re-save, which does not evaluate formulas. Refusing to ' +
      `parse rather than emit a null-filled snapshot. Path: ${path}. ${REPAIR_HINT}`,
  );
}
