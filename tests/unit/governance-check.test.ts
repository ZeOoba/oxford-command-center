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
  checkStatusJson,
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

// Helper to build Dirent-like mocks for the withFileTypes readdirSync calls
function fileEntry(name: string) {
  return { name, isDirectory: () => false, isFile: () => true };
}
function dirEntry(name: string) {
  return { name, isDirectory: () => true, isFile: () => false };
}

describe('checkGovernorLiteralCoupling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('flags dscr < 1.25 (DSCR comparison with floor literal)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('acq-engine.ts')] as never);
    mockReadFileSync.mockReturnValue('if (dscr < 1.25) { return false; }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('1.25'))).toBe(true);
  });

  it('passes when loadGovernors is used (no bare literal)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('acq-engine.ts')] as never);
    mockReadFileSync.mockReturnValue(
      "const { dscrFloor } = loadGovernors(db);\nif (dscr < dscrFloor) { return false; }",
    );
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag width: 1.25 (non-governor context)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('util.ts')] as never);
    mockReadFileSync.mockReturnValue('const config = { width: 1.25, height: 2.5 };');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag when the literal is in a comment', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('acq-engine.ts')] as never);
    mockReadFileSync.mockReturnValue(
      '// old: dscr < 1.25\nif (dscr < dscrFloor) {',
    );
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags LTV literal form ltv > 0.40', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('scoring.ts')] as never);
    mockReadFileSync.mockReturnValue('if (ltv > 0.40) { return false; }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('0.40') || e.includes('0.4'))).toBe(true);
  });

  it('does NOT flag files in governors.ts (allowlisted)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('governors.ts')] as never);
    mockReadFileSync.mockReturnValue('export const dscrFloor = 1.25;');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT flag assignment (non-comparison) like const dscr = 1.25', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([fileEntry('acq-engine.ts')] as never);
    mockReadFileSync.mockReturnValue('const dscr = 1.25;');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('flags violations in nested subdirectory files (recursive traversal)', () => {
    // warehouse exists with subdirs; insights dir does NOT exist — isolates warehouse traversal.
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes('server') && s.includes('insights')) return false;
      return true;
    });
    // First readdirSync call: warehouse root returns a subdir + a clean top-level file
    // Second readdirSync call: subdir returns a file with a governor violation
    mockReaddirSync
      .mockReturnValueOnce([dirEntry('parse'), fileEntry('clean.ts')] as never)
      .mockReturnValueOnce([fileEntry('qb-filters.ts')] as never);
    mockReadFileSync
      .mockReturnValueOnce('// clean top-level file')
      .mockReturnValueOnce('if (dscr < 1.25) { throw new Error(); }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('1.25'))).toBe(true);
  });

  it('flags governor literal violations in server/insights/ files', () => {
    // insightsDir exists; warehouseDir does NOT — violation comes exclusively from insights/.
    // Before UnitD the insights dir is never scanned, so result.pass would be true (no warehouse
    // files to scan). After UnitD the insights scan must pick up the violation and return false.
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      // insights dir exists; warehouse dir does NOT
      if (s.includes('server') && s.includes('insights')) return true;
      if (s.includes('server') && s.includes('warehouse')) return false;
      return true; // other existsSync calls (root, etc.) pass
    });
    mockReaddirSync.mockReturnValueOnce([fileEntry('insight-stats.ts')] as never);
    mockReadFileSync.mockReturnValueOnce('if (ltv <= 0.40) { /* violation */ }');
    const result = checkGovernorLiteralCoupling('/fake/root');
    expect(result.pass).toBe(false);
  });
});

// Helper to serve a raw status.json body through the fs mocks
function mockStatusJson(raw: string) {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(raw);
}

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    agent_role: 'Analytics Agent',
    phase: 'Phase X - test fixture',
    status: 'merged',
    blocked_by: null,
    review_needed: false,
    review_detail: null,
    last_updated: '2026-06-22T10:00:00Z',
    ...overrides,
  };
}

describe('checkStatusJson', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes on a valid file (top-level entries + nested worktrees + underscore/usage keys)', () => {
    mockStatusJson(
      JSON.stringify({
        _comment: 'test',
        _schema: { status: 'idle | in_progress | blocked | review_needed | merged' },
        'phase-5-cap-alloc': validEntry(),
        worktrees: { main: validEntry({ status: 'idle' }) },
        usage: { how_to_update: 'edit your entry' },
      }),
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when the file is missing', () => {
    mockExistsSync.mockReturnValue(false);
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.startsWith('MISSING'))).toBe(true);
  });

  it('fails with INVALID_JSON on a missing comma', () => {
    // the exact defect class shipped in the ic-memo entry: value followed by a key, no comma
    mockStatusJson('{\n  "a": {\n    "agent_role": "x"\n    "phase": "y"\n  }\n}');
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.startsWith('INVALID_JSON:'))).toBe(true);
  });

  it('fails with DUPLICATE_KEY naming the entry when a key appears twice', () => {
    // two "status" keys inside one entry object - JSON.parse alone would silently keep the last
    mockStatusJson(
      '{\n' +
        '  "ic-memo": {\n' +
        '    "agent_role": "x",\n' +
        '    "phase": "y",\n' +
        '    "status": "in_progress",\n' +
        '    "status": "merged",\n' +
        '    "last_updated": "2026-06-22T10:00:00Z"\n' +
        '  }\n' +
        '}',
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith('DUPLICATE_KEY:') && e.includes('"status"') && e.includes('"ic-memo"')),
    ).toBe(true);
  });

  it('duplicate-key scanner is not confused by strings containing braces and colons', () => {
    mockStatusJson(
      JSON.stringify({
        entry: validEntry({
          review_detail: 'weird: { "status": "fake" } } { and a \\" quote and more: {{',
        }),
      }),
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails on a status value outside the enum (e.g. "complete")', () => {
    mockStatusJson(JSON.stringify({ m6: validEntry({ status: 'complete' }) }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith('STATUS_SCHEMA:') && e.includes('"complete"') && e.includes('"m6"')),
    ).toBe(true);
  });

  it('fails on a non-boolean review_needed', () => {
    mockStatusJson(JSON.stringify({ e1: validEntry({ review_needed: 'yes' }) }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('review_needed') && e.includes('not boolean'))).toBe(true);
  });

  it('fails on a non-ISO-8601 last_updated', () => {
    mockStatusJson(JSON.stringify({ e1: validEntry({ last_updated: 'June 22nd, 2026' }) }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('last_updated') && e.includes('not ISO-8601'))).toBe(true);
  });

  it('fails when required keys are missing', () => {
    mockStatusJson(JSON.stringify({ e1: { status: 'idle', last_updated: '2026-06-22T10:00:00Z' } }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.includes('missing required keys') && e.includes('agent_role'))).toBe(true);
  });

  it('warns (non-blocking) on a stale in_progress entry older than 14 days', () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    mockStatusJson(JSON.stringify({ stale: validEntry({ status: 'in_progress', last_updated: old }) }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.startsWith('STALE_STATUS:') && w.includes('"stale"'))).toBe(true);
  });

  it('does NOT warn on a fresh in_progress entry', () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    mockStatusJson(JSON.stringify({ fresh: validEntry({ status: 'in_progress', last_updated: recent }) }));
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns on a stale review_needed=true entry even when status is not in_progress', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    mockStatusJson(
      JSON.stringify({ waiting: validEntry({ status: 'blocked', review_needed: true, last_updated: old }) }),
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.warnings.some((w) => w.startsWith('STALE_STATUS:') && w.includes('"waiting"'))).toBe(true);
  });

  it('validates entries nested under the legacy worktrees wrapper', () => {
    mockStatusJson(
      JSON.stringify({
        worktrees: { 'bad-child': validEntry({ status: 'done' }) },
      }),
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith('STATUS_SCHEMA:') && e.includes('"bad-child"') && e.includes('"done"')),
    ).toBe(true);
  });

  it('skips underscore-prefixed keys and the usage key (no schema errors for them)', () => {
    mockStatusJson(
      JSON.stringify({
        _comment: 'no status here',
        _schema: { anything: 'goes' },
        usage: { how_to_read: 'not an entry' },
      }),
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects duplicate keys nested inside the worktrees wrapper', () => {
    mockStatusJson(
      '{\n' +
        '  "worktrees": {\n' +
        '    "child": {\n' +
        '      "agent_role": "x",\n' +
        '      "phase": "a",\n' +
        '      "phase": "b",\n' +
        '      "status": "idle",\n' +
        '      "last_updated": "2026-06-22T10:00:00Z"\n' +
        '    }\n' +
        '  }\n' +
        '}',
    );
    const result = checkStatusJson('/fake/root');
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.startsWith('DUPLICATE_KEY:') && e.includes('"phase"') && e.includes('"child"'))).toBe(true);
  });
});
