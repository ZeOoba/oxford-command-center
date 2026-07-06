import '@testing-library/jest-dom/vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// server/briefing/confidential.ts fails loud when CONFIDENTIAL_TERMS_PATH is unreadable, by design
// (a confidentiality gate must fail closed, not silently scan a placebo). Point the whole suite at a
// git-tracked SYNTHETIC fixture (tests/fixtures/confidential-terms.synthetic.json -- no real deal data)
// so tests exercise the real matching logic instead of needing a real confidential-terms.json on the
// box. Individual tests may still override CONFIDENTIAL_TERMS_PATH per-test (save/restore) as several
// already do -- this only sets the suite-wide default.
if (process.env.CONFIDENTIAL_TERMS_PATH === undefined) {
  process.env.CONFIDENTIAL_TERMS_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'confidential-terms.synthetic.json',
  );
}
