// server/workbook/sheets/assumptions.ts
//
// Master Workbook parser: the Assumptions sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import type { DataQualityFlag, ScenarioName } from '../../../src/contracts/index';
import { SCENARIO_PRESETS } from '../../../src/contracts/scenario';
import { num, row, sheetDataAsOf, str } from './cells';
type Worksheet = ExcelJS.Worksheet;

// ── assumptions (Assumptions) — label-scanned ─────────────────────────────────
/** @param fallbackAsOf See parseCash — same OI-023 per-sheet dateline convention. */
export function parseAssumptions(ws: Worksheet, flags: DataQualityFlag[], fallbackAsOf: string) {
  let activeScenario: ScenarioName = 'Base';
  let balloonAlertMonths = 18;
  let concentrationYellow = 0.25;
  let concentrationRed = 0.5;
  for (let r = 1; r <= ws.rowCount; r++) {
    const label = str(row(ws, r, 2));
    const val = row(ws, r, 3);
    if (!label) continue;
    if (/active scenario/i.test(label)) {
      const s = str(val);
      if (s === 'Base' || s === 'Upside' || s === 'Downside') activeScenario = s;
    } else if (/balloon alert.*month/i.test(label)) balloonAlertMonths = num(val) ?? 18;
    else if (/concentration.*yellow/i.test(label)) concentrationYellow = num(val) ?? 0.25;
    else if (/concentration.*red/i.test(label)) concentrationRed = num(val) ?? 0.5;
  }
  const preset = SCENARIO_PRESETS[activeScenario];
  const ownAsOf = sheetDataAsOf(ws);
  if (!ownAsOf) {
    flags.push({
      entity: 'assumptions',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Assumptions sheet — provenance falls back to ${fallbackAsOf}`,
      severity: 'warn',
    });
  }
  return {
    activeScenario,
    revenueFactor: preset.revenueFactor,
    vacancyFactor: preset.vacancyFactor,
    exitCapFactor: preset.exitCapFactor,
    thresholds: { balloonAlertMonths, concentrationYellow, concentrationRed },
    asOf: ownAsOf ?? fallbackAsOf,
  };
}
