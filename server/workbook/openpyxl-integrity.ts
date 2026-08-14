/**
 * Detect the ways an openpyxl re-save corrupts the ORA Master Workbook for exceljs.
 *
 * INCIDENT (2026-08-13/14). The `excel` MCP server (excel-mcp-server) is openpyxl-backed
 * and load-then-saves in place. A session used it against the Master Workbook at
 * 19:11 ET on 2026-08-13. Three consumers broke for ~15h: ora-lease-snapshot-refresh
 * (Exit 3), ora-cc-snapshot-refresh (`npm run extract`), and the hourly Mirror Deploy
 * (`npm run bake`, 9 consecutive failures surfacing only as "build:mirror failed (1)").
 *
 *   DEFECT 1 - unresolvable relationships. openpyxl writes worksheet rel targets as
 *   ABSOLUTE ("/xl/comments/comment1.xml"); Excel writes them RELATIVE
 *   ("../comments1.xml"). exceljs keys its lookup maps by the relative form, so the
 *   absolute target misses and it dereferences undefined. The incident file carries 92
 *   absolute targets; a healthy Excel-saved file carries 0.
 *
 *   DEFECT 2 - stripped cached values. openpyxl does not evaluate formulas, so a re-save
 *   drops the cached result of every formula cell. exceljs reads CACHED values, so a
 *   workbook in this state parses "successfully" while yielding null for essentially every
 *   computed figure - rent, NOI, debt service, DSCR.
 *
 *   DEFECT 3 - formulas replaced by static values. `load_workbook(path, data_only=True)`
 *   followed by `save()` discards the formulas themselves. The parse then succeeds with
 *   correct-LOOKING numbers that can never move again. This is worse than nulls, which are
 *   at least visible.
 *
 * WHY DETECTORS AND NOT A NORMALIZER. The obvious fix is to rewrite the absolute rel
 * targets and carry on. That would be actively dangerous: it repairs DEFECT 1 only, so the
 * parse would then SUCCEED on a workbook whose financial values are all null, and a
 * null-filled snapshot would flow to portfolio.json, the alerts engine, and the public
 * mirror. The crash was protective. This module converts an opaque crash into a precise,
 * named refusal and adds refusals for the silent cases; it never makes a corrupt workbook
 * readable.
 *
 * DEFECT 1 IS DETECTED AT THE ZIP LAYER, BY CAUSE, NOT BY SYMPTOM. An earlier draft keyed
 * on the exceljs error text "reading 'comments'". An adversarial pass showed that is only
 * one symptom of the same cause: an openpyxl file carrying TABLES but no comments throws
 * "reading 'name'" instead (worksheet-xform.js reconciles tables via the same
 * relative-keyed lookup), and the incident file itself has absolute TABLE targets
 * (/xl/tables/table1.xml on sheets 10 and 13) that only escaped notice because comments
 * happen to reconcile first. Deleting the notes from those two sheets, or reordering
 * sheets, would have restored the unnamed crash this module exists to eliminate. Scanning
 * the package for `Target="/` is unambiguous (92 vs 0 on the two real files), covers every
 * symptom, costs a few ms, and does not depend on V8 message wording.
 *
 * The real repair is to re-save through Excel (a full rebuild restores relative rels and
 * cached values). See
 * memory/reference_openpyxl_resave_breaks_exceljs_workbook_parse_2026-08-14.md
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import type { Workbook } from 'exceljs';

/**
 * Minimum formula cells before the cached-value RATIO is meaningful.
 *
 * SCOPE: tuned for master-workbook-scale input (the ORA master carries ~17.3k formula
 * cells). A small workbook that is fully stripped will NOT trip the ratio check. That is a
 * deliberate accepted gap for the incident this guards, not an oversight - callers parsing
 * small arbitrary workbooks should not rely on this ratio.
 */
const MIN_FORMULA_CELLS = 100;

/**
 * Fraction of formula cells missing a cached result that indicates a stripped workbook.
 *
 * 0.9, NOT 0.5. exceljs cannot distinguish "no cached value" from "cached value is the
 * empty string": cell-xform.js sets `model.result` under a TRUTHINESS test, so an empty
 * `<v/>` never sets it. Blank-suppression formulas (`=IF(B1="","",B1)`) are therefore
 * indistinguishable from uncached ones at the Cell level. On the real healthy workbook
 * that is 517 of 17,318 cells (2.99%) - of which only 12 are genuinely uncached. A 0.5
 * threshold's apparent margin was a coincidence of the current formula mix; a template
 * revision adding a large pre-formatted IF(...,"") grid would walk it toward 0.5 with no
 * loss of workbook health, and a false refusal is not loud: server/brain.ts catches a
 * parseWorkbook throw, serves the fallback, and still reports status 'fresh'.
 *
 * openpyxl strips EVERY cached value - the real corrupt file measures a ratio of exactly
 * 1.0 - so 0.9 costs no detection while removing essentially all of that exposure.
 */
const STRIPPED_RATIO = 0.9;

/**
 * Below this many formula cells, a workbook this size is a destroyed model, not a workbook
 * that merely lacks formulas. Guards DEFECT 3, where formulaCells collapses to 0 and a
 * pure ratio check divides by zero into a pass.
 */
const MIN_NONEMPTY_CELLS_EXPECTING_FORMULAS = 5000;

const REPAIR_HINT =
  'Repair: open the workbook in Excel and re-save it (SaveAs, .xlsx) - a full rebuild ' +
  'restores both the relative relationship targets and the cached formula values. ' +
  'Never re-save this workbook with openpyxl or the `excel` MCP server. ' +
  'See memory/reference_openpyxl_resave_breaks_exceljs_workbook_parse_2026-08-14.md';

// ---------------------------------------------------------------------------
// DEFECT 1 - absolute relationship targets, detected in the .xlsx package itself.
// ---------------------------------------------------------------------------

/** A minimal, dependency-free reader for the entries we need out of an .xlsx (a zip). */
function* relsEntries(buf: Buffer): Generator<{ name: string; data: Buffer }> {
  // End of Central Directory: scan backwards for its signature.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return;

  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + fnLen);
    p += 46 + fnLen + extraLen + commentLen;

    if (!name.endsWith('.rels')) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;

    const lFnLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lFnLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      yield { name, data: method === 0 ? raw : inflateRawSync(raw) };
    } catch {
      // Unreadable member -> skip it. Absence of evidence never blocks a parse.
    }
  }
}

export interface AbsoluteRelScan {
  /** Total `Target="/..."` relationships found across all .rels parts. */
  count: number;
  /** Up to a few "<relsPart> -> <target>" samples, for the error message. */
  samples: string[];
  /** False when the package could not be inspected at all (scan is inconclusive). */
  evaluated: boolean;
}

/**
 * Scan an .xlsx package for openpyxl's absolute relationship targets.
 *
 * FAILS OPEN: an unreadable or unexpected package returns `evaluated: false, count: 0`, so
 * a bug here can never block a healthy parse. Only a POSITIVE finding refuses.
 */
export function scanAbsoluteRelTargets(path: string): AbsoluteRelScan {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return { count: 0, samples: [], evaluated: false };
  }

  let count = 0;
  const samples: string[] = [];
  let sawAny = false;

  try {
    for (const { name, data } of relsEntries(buf)) {
      sawAny = true;
      const xml = data.toString('utf8');
      for (const m of xml.matchAll(/Target="(\/[^"]*)"/g)) {
        count += 1;
        if (samples.length < 3) samples.push(`${name} -> ${m[1]}`);
      }
    }
  } catch {
    return { count: 0, samples: [], evaluated: false };
  }

  return { count, samples, evaluated: sawAny };
}

/**
 * Throw when the package carries openpyxl's absolute relationship targets.
 *
 * Called BEFORE exceljs reads, so the operator gets a named cause instead of a TypeError
 * raised from inside node_modules against whichever relationship type happened to
 * reconcile first.
 */
export function assertRelationshipTargetsResolvable(path: string): void {
  const scan = scanAbsoluteRelTargets(path);
  if (!scan.evaluated || scan.count === 0) return;

  throw new Error(
    `Workbook is unreadable by exceljs: ${scan.count} relationship target(s) are ABSOLUTE ` +
      '("/xl/...") instead of Excel\'s relative form ("../..."), so exceljs cannot resolve ' +
      'them and throws while reconciling (the exact symptom varies by relationship type - ' +
      "comments surface as \"reading 'comments'\", tables as \"reading 'name'\"). This is the " +
      'signature of an openpyxl re-save (the `excel` MCP server is openpyxl-backed). ' +
      `Examples: ${scan.samples.join('; ')}. Path: ${path}. ${REPAIR_HINT}`,
  );
}

/**
 * Backstop for a read that failed anyway: report whether the package explains it.
 *
 * Deliberately broader than the old "reading 'comments'" regex - it matches ANY
 * undefined-dereference from exceljs, then CONFIRMS against the package before claiming
 * the openpyxl cause, so it cannot mislabel an unrelated crash.
 */
export function describeOpenpyxlReadFailure(err: unknown, path: string): string | null {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!/Cannot read propert(?:y|ies) of undefined/.test(message)) return null;

  const scan = scanAbsoluteRelTargets(path);
  if (!scan.evaluated || scan.count === 0) return null;

  return (
    `Workbook is unreadable by exceljs: ${scan.count} relationship target(s) are ABSOLUTE ` +
    '("/xl/...") instead of Excel\'s relative form, the signature of an openpyxl re-save ' +
    `(underlying error: ${message}). Examples: ${scan.samples.join('; ')}. ` +
    `Path: ${path}. ${REPAIR_HINT}`
  );
}

// ---------------------------------------------------------------------------
// DEFECTS 2 and 3 - cached values stripped, or formulas replaced by static values.
// ---------------------------------------------------------------------------

export interface CachedValueAudit {
  formulaCells: number;
  /**
   * Formula cells exceljs reports with no cached result. NOTE: this over-counts - exceljs
   * cannot distinguish a missing cached value from a cached empty string (see
   * STRIPPED_RATIO). Treat it as an upper bound, never as an exact uncached count.
   */
  missingCached: number;
  nonEmptyCells: number;
  /** Fraction of formula cells with no cached result; 0 when there are no formula cells. */
  missingRatio: number;
  /** DEFECT 2: sample is large enough AND nearly every cached value is gone. */
  stripped: boolean;
  /** DEFECT 3: a workbook this size has no formulas left at all. */
  formulasDestroyed: boolean;
}

/**
 * Count formula cells and how many lack a cached result.
 *
 * Cost is negligible: ~8ms against the real 50-sheet / 29,989-non-empty-cell workbook,
 * under 2% of the ~379ms readFile it follows.
 *
 * Shared formulas ARE counted - exceljs's Value.getType returns ValueType.Formula for
 * `sharedFormula` cells (13,886 master + 3,432 shared on the real workbook). Formula cells
 * that also carry a hyperlink are NOT counted: exceljs retypes them to Hyperlink and
 * discards `result`. That is 1 cell of 17,319 on the real workbook - immaterial to a ratio.
 */
export function auditCachedValues(wb: Workbook): CachedValueAudit {
  let formulaCells = 0;
  let missingCached = 0;
  let nonEmptyCells = 0;

  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        nonEmptyCells += 1;
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
    nonEmptyCells,
    missingRatio,
    stripped: formulaCells >= MIN_FORMULA_CELLS && missingRatio > STRIPPED_RATIO,
    formulasDestroyed:
      formulaCells === 0 && nonEmptyCells >= MIN_NONEMPTY_CELLS_EXPECTING_FORMULAS,
  };
}

/**
 * Throw when a workbook parsed cleanly but its financial content cannot be trusted.
 *
 * Without this, DEFECTS 2 and 3 are silent: the parse succeeds and downstream gates read
 * the result as real portfolio movement.
 */
export function assertCachedValuesPresent(wb: Workbook, path: string): void {
  const audit = auditCachedValues(wb);

  if (audit.formulasDestroyed) {
    throw new Error(
      `Workbook has ${audit.nonEmptyCells} non-empty cells but NO formulas at all. Its ` +
        'formulas have been replaced by static values - the signature of an openpyxl ' +
        '`load_workbook(path, data_only=True)` followed by save(). Every figure would be ' +
        'frozen at its last calculation and could never move again. Refusing to parse. ' +
        `Path: ${path}. ${REPAIR_HINT}`,
    );
  }

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
