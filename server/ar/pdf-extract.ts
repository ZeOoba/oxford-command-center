// server/ar/pdf-extract.ts
//
// Shared pdfplumber text extraction for the AR-aging feed. Runs pdfplumber in a Python subprocess
// and returns the concatenated text of all pages. Extracted here so the interactive importer
// (scripts/ar-import.ts) and the headless runner (scripts/ar-import-headless.ts) share ONE
// extraction command rather than drifting copies.
//
// NOTE: scripts/ar-import.ts still carries its own inline copy today; a follow-up should repoint it
// here. Kept as a pure boundary (text in → rows out lives in ar-aging.ts) so this is the only
// module that shells out.

import { spawnSync } from 'node:child_process';

const PYTHON = process.env.ORA_PYTHON ?? 'python';

/** Extract all-pages text from a PDF via pdfplumber. Throws on a missing interpreter or non-zero exit. */
export function extractPdfText(pdfPath: string): string {
  const result = spawnSync(
    PYTHON,
    [
      '-c',
      `
import sys, pdfplumber
with pdfplumber.open(sys.argv[1]) as pdf:
    print("\\n".join((p.extract_text() or "") for p in pdf.pages))
`,
      pdfPath,
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`Python not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pdfplumber error:\n${result.stderr}`);
  return result.stdout ?? '';
}
