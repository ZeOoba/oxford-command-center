// server/workbook/sheets/tasks.ts
//
// Master Workbook parser: the Monthly Checklist sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import type { Task, TaskStatus } from '../../../src/contracts/index';
import { WORKBOOK_AS_OF } from '../../config';
import { num, row, str } from './cells';
type Worksheet = ExcelJS.Worksheet;

// ── tasks (Monthly Checklist) ─────────────────────────────────────────────────
export function statusFromSymbol(v: unknown): TaskStatus {
  const s = String(v ?? '').trim();
  if (s.includes('✅')) return 'done';
  if (s.includes('⚠')) return 'overdue';
  if (/^r$/i.test(s) || s.includes('R')) return 'renewal';
  if (s.includes('☐')) return 'pending';
  if (s === '—' || s === '-') return 'na';
  return 'unknown';
}
/**
 * The Monthly Checklist sheet carries decorative banner/summary rows (alerts, section
 * headers) whose text bleeds across many columns. Some carry a RowID and label, so they
 * slip past the header guard and were being ingested as Tasks — surfacing as junk section
 * cards with the same string smeared across title/type/notes (Defect 9). Reject them.
 */
export function isTaskBannerRow(
  label: string,
  section: string | null,
  type: string | null,
): boolean {
  if (/^\s*[⚠✅☐]/.test(label)) return true; // leading status/alert glyph = banner, not a task
  if (/balloon alert|cash flow summary|how to use|portfolio snapshot|^\s*notes?\b/i.test(label)) return true;
  // The smear pattern: the same text bled into label + section + type.
  if (section !== null && type !== null && label === section && section === type) return true;
  return false;
}

export function parseTasks(ws: Worksheet): Task[] {
  // JAN is column 7; current month column = 7 + month index (0-based).
  const monthCol = 7 + new Date(WORKBOOK_AS_OF).getUTCMonth();
  const out: Task[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const rowId = str(row(ws, r, 20));
    const label = str(row(ws, r, 1));
    if (!rowId || !label) continue;
    if (rowId === 'RowID' || /^loan \/ property$/i.test(label)) continue; // header row
    const section = str(row(ws, r, 19)) ?? 'Other';
    const type = str(row(ws, r, 4));
    if (isTaskBannerRow(label, section, type)) continue; // skip decorative banner/summary rows
    out.push({
      id: rowId,
      label,
      section,
      role: str(row(ws, r, 3)),
      type,
      dueDay: str(row(ws, r, 5)),
      notes: str(row(ws, r, 6)),
      status: statusFromSymbol(row(ws, r, monthCol)),
      monthlyPmt: num(row(ws, r, 21)),
    });
  }
  return out;
}
