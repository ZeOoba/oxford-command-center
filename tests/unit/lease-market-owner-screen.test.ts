// tests/unit/lease-market-owner-screen.test.ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonOwnerScreenRunner, screenOwners } from '../../server/warehouse/lease-market/owner-screen';

const hasPython = spawnSync(process.env.PYTHON ?? 'python', ['--version']).status === 0;

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
  });

  it.skipIf(!hasPython)('runs the real python bridge against a module with the institutional_owners API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-owner-'));
    const mod = join(dir, 'fake_owners.py');
    writeFileSync(
      mod,
      [
        "_GUARD_RAW = {'never_call_patterns': []}",
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
      ].join('\n'),
    );
    const r = screenOwners(['PROLOGIS FUND LP', 'DUKE COMBINED LLC', 'OXFORD CAMPUS I LLC', 'BADCO LLC', 'SMITH LLC', 'CAFÉ HOLDINGS'], mod, pythonOwnerScreenRunner);
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
});
