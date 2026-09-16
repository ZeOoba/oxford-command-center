### Task 07: Owner-screen bridge (institutional / never-call / affiliated)

**Files:**
- Create: `scripts/lease-market-owner-screen.py`
- Create: `server/warehouse/lease-market/owner-screen.ts`
- Modify: `tests/unit/lease-market-fixtures.ts` (append `stubScreen`)
- Test: `tests/unit/lease-market-owner-screen.test.ts`

**Interfaces:**
- Consumes: Task 02 `OwnerType`. Reads (never writes) county-parcel-screen's `institutional_owners.py`, whose API is `screen_owner(name) -> ('EXCLUDE'|'VERIFY'|None, canonical)`, `ora_never_call(name) -> ('ORA-SELF'|'NEVER-CALL'|None, match)`, and module global `_GUARD_RAW` (an empty dict when `data/pipeline-guard.local.json` is unreadable — the module then degrades to ORA-self patterns only).
- Produces:
  - `interface OwnerScreenResult { available: boolean; guardOk: boolean; types: Map<string, OwnerType>; error: string | null }` — map keys are trimmed owner names
  - `type OwnerScreenRunner = (modulePath: string, names: string[]) => unknown`
  - `pythonOwnerScreenRunner: OwnerScreenRunner`
  - `screenOwners(names: readonly string[], modulePath: string, runner?: OwnerScreenRunner): OwnerScreenResult`
  - fixture `stubScreen(names: string[]): OwnerScreenResult` — `PROLOGIS` ⇒ institutional, `OXFORD` ⇒ affiliated, else private

Fail-closed: any runner error, invalid output, or `guardOk: false` ⇒ `available: false` (acquisition candidates are withheld downstream). Precedence inside the bridge: NEVER-CALL ⇒ `never_call`; ORA-SELF ⇒ `affiliated`; EXCLUDE ⇒ `institutional`; VERIFY ⇒ `verify`; else `private`. Never print or log matched counterparty names.

- [ ] **Step 1: Append the stub to the fixtures**

Append to `tests/unit/lease-market-fixtures.ts` (and add `OwnerType` to its contracts type import, plus `import type { OwnerScreenResult } from '../../server/warehouse/lease-market/owner-screen';`):

```ts
export function stubScreen(names: string[]): OwnerScreenResult {
  const types = new Map<string, OwnerType>();
  for (const raw of names) {
    const n = raw.trim();
    const upper = n.toUpperCase();
    types.set(n, upper.includes('PROLOGIS') ? 'institutional' : upper.includes('OXFORD') ? 'affiliated' : 'private');
  }
  return { available: true, guardOk: true, types, error: null };
}
```

- [ ] **Step 2: Write the failing test**

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-owner-screen.test.ts`
Expected: FAIL — cannot resolve `owner-screen`.

- [ ] **Step 4: Write the python bridge**

```python
"""Lease Market Intelligence owner-screen bridge.

Screens owner names with county-parcel-screen's institutional_owners.py (read-only; never edits it).
argv[1]: path to institutional_owners.py
stdin:   JSON array of owner names (UTF-8)
stdout:  {"guardOk": bool, "types": {name: owner_type}}
owner_type: never_call | affiliated | institutional | verify | private
guardOk is False when the module could not read its never-call guard file (it then screens
ORA-self patterns only) -- the caller must fail closed on that.
Never prints matched counterparty names or patterns.
"""
import importlib.util
import json
import sys


def main() -> None:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    module_path = sys.argv[1]
    names = json.load(sys.stdin)
    spec = importlib.util.spec_from_file_location('institutional_owners', module_path)
    if spec is None or spec.loader is None:
        raise SystemExit('cannot load owner-screen module')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    guard_ok = bool(getattr(mod, '_GUARD_RAW', {}))
    types = {}
    for name in names:
        nc, _ = mod.ora_never_call(name)
        if nc == 'NEVER-CALL':
            owner_type = 'never_call'
        elif nc == 'ORA-SELF':
            owner_type = 'affiliated'
        else:
            tier, _ = mod.screen_owner(name)
            owner_type = 'institutional' if tier == 'EXCLUDE' else 'verify' if tier == 'VERIFY' else 'private'
        types[name] = owner_type
    json.dump({'guardOk': guard_ok, 'types': types}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
```

Save as `scripts/lease-market-owner-screen.py`.

Note: `ora_never_call` checks ORA-self patterns before never-call patterns, so a name matching both returns ORA-SELF — that is the module's own precedence; do not re-order it here.

- [ ] **Step 5: Write the TypeScript wrapper**

```ts
// server/warehouse/lease-market/owner-screen.ts
//
// Lease Market Intelligence — owner screening via county-parcel-screen's institutional_owners.py
// (the canonical ORA institutional / never-call alias table; ported by bridge, never re-implemented,
// so the two screens cannot drift). Fail-closed: any failure => available:false => candidates withheld.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { OwnerType } from '../../../src/contracts/lease-market';

export interface OwnerScreenResult {
  available: boolean;
  guardOk: boolean;
  types: Map<string, OwnerType>;
  error: string | null;
}

export type OwnerScreenRunner = (modulePath: string, names: string[]) => unknown;

const BridgeOutput = z.object({ guardOk: z.boolean(), types: z.record(z.string(), OwnerType) });

export const pythonOwnerScreenRunner: OwnerScreenRunner = (modulePath, names) => {
  const script = join(process.cwd(), 'scripts', 'lease-market-owner-screen.py');
  const stdout = execFileSync(process.env.PYTHON ?? 'python', [script, modulePath], {
    input: JSON.stringify(names),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(stdout) as unknown;
};

export function screenOwners(
  names: readonly string[],
  modulePath: string,
  runner: OwnerScreenRunner = pythonOwnerScreenRunner,
): OwnerScreenResult {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return { available: true, guardOk: true, types: new Map(), error: null };
  const allUnknown = () => new Map<string, OwnerType>(unique.map((n) => [n, 'unknown']));
  try {
    const parsed = BridgeOutput.parse(runner(modulePath, unique));
    const types = new Map<string, OwnerType>();
    for (const n of unique) types.set(n, parsed.types[n] ?? 'unknown');
    return {
      available: parsed.guardOk,
      guardOk: parsed.guardOk,
      types,
      error: parsed.guardOk ? null : 'never-call guard file unreadable (screen degraded to ORA-self only)',
    };
  } catch (e) {
    const message = e instanceof Error ? (e.message.split('\n')[0] ?? 'owner screen failed') : 'owner screen failed';
    return { available: false, guardOk: false, types: allUnknown(), error: message };
  }
}
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-owner-screen.test.ts tests/unit/lease-market-costar-parse.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-fixtures.ts tests/unit/lease-market-owner-screen.test.ts --max-warnings 0`
Expected: PASS (the python test runs — Python 3.13 is installed on this machine) / clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/lease-market-owner-screen.py server/warehouse/lease-market/owner-screen.ts tests/unit/lease-market-fixtures.ts tests/unit/lease-market-owner-screen.test.ts
git commit -F <message-file>   # "feat(warehouse): fail-closed owner screen bridge to institutional_owners.py"
```
