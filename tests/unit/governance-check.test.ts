import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// Mock the fs module so tests don't require actual files on disk
vi.mock('node:fs');

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// Import the module under test — functions exported for testability
import {
  checkRequiredFiles,
  checkStaleFiles,
  checkRouteDuplication,
  checkAcqGovernorCoupling,
  checkGovernorLiteralCoupling,
} from '../../scripts/governance-check';

const ARCH_FILES = [
  'architecture/system-overview.md',
  'architecture/database-schema.md',
  'architecture/api-contracts.md',
  'architecture/coding-standards.md',
  'architecture/agent-assignments.md',
];

const REQUIRED_FILES = [
  'CLAUDE.md',
  'architecture/ownership.json',
  ...ARCH_FILES,
];

describe('checkRequiredFiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes when all required files exist', () => {
    mockExistsSync.mockReturnValue(true);
    const result = checkRequiredFiles('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when CLAUDE.md is missing', () => {
    mockExistsSync.mockImplementation((p) =>
      !String(p).endsWith('CLAUDE.md'),
    );
    const result = checkRequiredFiles('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('CLAUDE.md'))).toBe(true);
  });

  it('fails when an architecture lock file is missing', () => {
    mockExistsSync.mockImplementation((p) =>
      !String(p).includes('system-overview'),
    );
    const result = checkRequiredFiles('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('system-overview'))).toBe(true);
  });

  it('fails when ownership.json is missing', () => {
    mockExistsSync.mockImplementation((p) =>
      !String(p).includes('ownership.json'),
    );
    const result = checkRequiredFiles('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('ownership.json'))).toBe(true);
  });

  it('reports all missing files, not just the first', () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkRequiredFiles('/fake/root');
    expect(result.errors.length).toBeGreaterThanOrEqual(REQUIRED_FILES.length);
  });
});

describe('checkStaleFiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('emits no warnings when arch files are recent', () => {
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ mtimeMs: recent.getTime() } as fs.Stats);
    const result = checkStaleFiles('/fake/root', 14);
    expect(result.warnings).toHaveLength(0);
  });

  it('emits a warning when an arch file is older than threshold', () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // 20 days ago
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ mtimeMs: old.getTime() } as fs.Stats);
    const result = checkStaleFiles('/fake/root', 14);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/stale|days old/i);
  });

  it('is non-blocking — pass is always true', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ mtimeMs: old.getTime() } as fs.Stats);
    const result = checkStaleFiles('/fake/root', 14);
    expect(result.pass).toBe(true);
  });

  it('skips staleness check for files that do not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkStaleFiles('/fake/root', 14);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('checkRouteDuplication', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes when no duplicate route prefixes exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['index.ts', 'api.ts'] as never);
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('index.ts')) return 'app.get("/api/health")';
      return 'app.get("/api/warehouse/imports")';
    });
    const result = checkRouteDuplication('/fake/root');
    expect(result.pass).toBe(true);
  });

  it('fails when the same route is defined in two files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['index.ts', 'duplicate.ts'] as never);
    mockReadFileSync.mockReturnValue('app.get("/api/health", handler)');
    const result = checkRouteDuplication('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('/api/health'))).toBe(true);
  });
});

describe('checkAcqGovernorCoupling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes when acq-engine.ts does not exist (new repo or pre-Phase-4)', () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when acq-engine.ts uses loadGovernors and has no capital-config import', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `import { loadGovernors } from './governors';\nexport function persistAndLogScore() {}`,
    );
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when acq-engine.ts imports directly from capital-config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `import { DSCR_FLOOR } from '../capital-config';\nimport { loadGovernors } from './governors';`,
    );
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => /capital.config|governors/i.test(e))).toBe(true);
  });

  it('fails when acq-engine.ts lacks loadGovernors reference', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `import { DSCR_FLOOR, LTV_CEILING } from './governors';\nexport function score() {}`,
    );
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => /loadGovernors/i.test(e))).toBe(true);
  });

  it('strips comments before checking — commented-out capital-config does not fail', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `// import { X } from '../capital-config'; — removed\nimport { loadGovernors } from './governors';`,
    );
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(true);
  });

  it('fails when loadGovernors is imported from a module other than ./governors', () => {
    mockExistsSync.mockReturnValue(true);
    // loadGovernors exists but sourced from the wrong module — catches the exact coupling contract
    mockReadFileSync.mockReturnValue(
      `import { loadGovernors } from './capital-config-shim';\nexport function score() {}`,
    );
    const result = checkAcqGovernorCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => /loadGovernors.*governors|governors.*loadGovernors/i.test(e))).toBe(true);
  });
});

describe('checkGovernorLiteralCoupling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('flags dscr < 1.25 (DSCR comparison with floor literal)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['acq-engine.ts'] as never);
    mockReadFileSync.mockReturnValue('if (dscr < 1.25) { return false; }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('1.25'))).toBe(true);
  });

  it('passes when loadGovernors is used (no bare literal)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['acq-engine.ts'] as never);
    mockReadFileSync.mockReturnValue(
      "const { dscrFloor } = loadGovernors(db);\nif (dscr < dscrFloor) { return false; }",
    );
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag width: 1.25 (non-governor context)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['util.ts'] as never);
    mockReadFileSync.mockReturnValue('const config = { width: 1.25, height: 2.5 };');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag when the literal is in a comment', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['acq-engine.ts'] as never);
    mockReadFileSync.mockReturnValue(
      '// old: dscr < 1.25\nif (dscr < dscrFloor) {',
    );
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags LTV literal form ltv > 0.40', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['scoring.ts'] as never);
    mockReadFileSync.mockReturnValue('if (ltv > 0.40) { return false; }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('0.40') || e.includes('0.4'))).toBe(true);
  });

  it('does NOT flag files in governors.ts (allowlisted)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['governors.ts'] as never);
    mockReadFileSync.mockReturnValue('export const dscrFloor = 1.25;');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag assignment (non-comparison) like const dscr = 1.25', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['acq-engine.ts'] as never);
    mockReadFileSync.mockReturnValue('const dscr = 1.25;');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
