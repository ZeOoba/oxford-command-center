// tests/unit/lease-market-owner-screen.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonOwnerScreenRunner, screenOwners } from '../../server/warehouse/lease-market/owner-screen';

const pyVersionCheck = spawnSync(process.env.PYTHON ?? 'python', ['--version'], { encoding: 'utf8' });
const hasPython = pyVersionCheck.status === 0 && `${pyVersionCheck.stdout ?? ''}${pyVersionCheck.stderr ?? ''}`.includes('Python 3');

const tempDirs: string[] = [];
function fakeModule(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-owner-'));
  tempDirs.push(dir);
  const mod = join(dir, 'fake_owners.py');
  writeFileSync(mod, source);
  return mod;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = tempDirs.pop())) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A structurally healthy fixture: _GUARD_RAW is a dict with a list never_call_patterns (empty is
// fine) and a truthy module-level ORA_SELF -- guardOk must be true.
const HEALTHY_MODULE = [
  "_GUARD_RAW = {'never_call_patterns': [], 'ora_self_patterns': ['OXFORD']}",
  "ORA_SELF = ['OXFORD']",
  'def screen_owner(name):',
  "    u = name.upper()",
  "    if 'PROLOGIS' in u: return ('EXCLUDE', 'Prologis')",
  "    if 'DUKE' in u: return ('VERIFY', 'Duke')",
  '    return (None, None)',
  'def ora_never_call(name):',
  "    u = name.upper()",
  "    if 'OXFORD' in u: return ('ORA-SELF', 'OXFORD')",
  "    if 'BADCO' in u: return ('NEVER-CALL', 'x')",
  '    return (None, None)',
  '',
].join('\n');

describe('screenOwners', () => {
  it('maps runner output and defaults missing names to unknown', () => {
    const r = screenOwners([' ACME LLC ', 'PROLOGIS FUND LP', 'ACME LLC'], 'mod.py', (_p, names) => {
      expect(names).toEqual(['ACME LLC', 'PROLOGIS FUND LP']);
      return { guardOk: true, types: { 'PROLOGIS FUND LP': 'institutional' } };
    });
    expect(r.available).toBe(true);
    expect(r.types.get('PROLOGIS FUND LP')).toBe('institutional');
    expect(r.types.get('ACME LLC')).toBe('unknown');
  });

  it('is available with no names and never calls the runner', () => {
    const r = screenOwners([], 'mod.py', () => {
      throw new Error('should not run');
    });
    expect(r.available).toBe(true);
  });

  it('fails closed when the runner throws', () => {
    const r = screenOwners(['ACME LLC'], 'mod.py', () => {
      throw new Error('python not found\nstack');
    });
    expect(r).toMatchObject({ available: false, guardOk: false, error: 'python not found' });
    expect(r.types.get('ACME LLC')).toBe('unknown');
  });

  it('fails closed on a degraded never-call guard', () => {
    const r = screenOwners(['ACME LLC'], 'mod.py', () => ({ guardOk: false, types: { 'ACME LLC': 'private' } }));
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/guard/);
  });

  it('fails closed on invalid output', () => {
    const r = screenOwners(['ACME LLC'], 'mod.py', () => ({ guardOk: true, types: { 'ACME LLC': 'friendly' } }));
    expect(r.available).toBe(false);
    expect(r.error).toBe('owner screen returned invalid output');
  });

  it.skipIf(!hasPython)('runs the real python bridge against a module with the institutional_owners API', () => {
    const mod = fakeModule(HEALTHY_MODULE);
    const r = screenOwners(
      ['PROLOGIS FUND LP', 'DUKE COMBINED LLC', 'OXFORD CAMPUS I LLC', 'BADCO LLC', 'SMITH LLC', 'CAFÉ HOLDINGS'],
      mod,
      pythonOwnerScreenRunner,
    );
    expect(r.available).toBe(true);
    expect(Object.fromEntries(r.types)).toEqual({
      'PROLOGIS FUND LP': 'institutional',
      'DUKE COMBINED LLC': 'verify',
      'OXFORD CAMPUS I LLC': 'affiliated',
      'BADCO LLC': 'never_call',
      'SMITH LLC': 'private',
      'CAFÉ HOLDINGS': 'private',
    });
  });

  it.skipIf(!hasPython)('fails closed when the guard dict has no never_call_patterns list', () => {
    const mod = fakeModule(
      [
        "_GUARD_RAW = {'ora_self_patterns': ['OXFORD']}",
        "ORA_SELF = ['OXFORD']",
        'def screen_owner(name):',
        '    return (None, None)',
        'def ora_never_call(name):',
        '    return (None, None)',
        '',
      ].join('\n'),
    );
    const r = screenOwners(['SMITH LLC'], mod, pythonOwnerScreenRunner);
    expect(r.available).toBe(false);
  });

  it.skipIf(!hasPython)('fails closed on a completely empty guard dict', () => {
    const mod = fakeModule(
      [
        '_GUARD_RAW = {}',
        'def screen_owner(name):',
        '    return (None, None)',
        'def ora_never_call(name):',
        '    return (None, None)',
        '',
      ].join('\n'),
    );
    const r = screenOwners(['SMITH LLC'], mod, pythonOwnerScreenRunner);
    expect(r.available).toBe(false);
  });

  it.skipIf(!hasPython)('never-call wins precedence even when the same name also matches EXCLUDE', () => {
    const mod = fakeModule(HEALTHY_MODULE);
    const r = screenOwners(['PROLOGIS BADCO LP'], mod, pythonOwnerScreenRunner);
    expect(r.available).toBe(true);
    expect(r.types.get('PROLOGIS BADCO LP')).toBe('never_call');
  });

  it.skipIf(!hasPython)('fails closed when the module is missing screen_owner', () => {
    const mod = fakeModule(
      [
        "_GUARD_RAW = {'never_call_patterns': [], 'ora_self_patterns': ['OXFORD']}",
        "ORA_SELF = ['OXFORD']",
        'def ora_never_call(name):',
        '    return (None, None)',
        '',
      ].join('\n'),
    );
    const r = screenOwners(['SMITH LLC'], mod, pythonOwnerScreenRunner);
    expect(r.available).toBe(false);
  });

  it.skipIf(!hasPython)('runs the real python bridge when process.cwd() differs from the repo root', () => {
    const mod = fakeModule(HEALTHY_MODULE);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());
    try {
      const r = screenOwners(['PROLOGIS FUND LP'], mod, pythonOwnerScreenRunner);
      expect(r.available).toBe(true);
      expect(r.types.get('PROLOGIS FUND LP')).toBe('institutional');
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
