import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// mirror-gate-probe-apex-only (audit 2026-11-08; refute run wf_44a3341e-b41 follow-ups). The
// deploy's Access-gate check is PowerShell (scripts/lib/access-gate-probe.ps1). This file:
//  1. runs its smoke test, which dot-sources the REAL probe with a mocked curl;
//  2. checks that the probe-path derivation covers EVERY Pages Function route in functions/ and
//     EVERY top-level JSON the bake writes into public/, using an enumeration independent of the
//     PowerShell one. A new Function or baked file that the probe would miss fails here.
// PowerShell 5.1 ships with Windows only; the CI runners are the Windows laptop.
const root = process.cwd();
const smoke = join(root, 'scripts', 'access-gate-probe.smoke-test.ps1');
const lib = join(root, 'scripts', 'lib', 'access-gate-probe.ps1');
const onWindows = process.platform === 'win32';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Independent enumeration of Pages Function routes: every functions/**\/*.ts exporting onRequest*. */
function functionRoutes(): string[] {
  const dir = join(root, 'functions');
  return walk(dir)
    .filter((p) => p.endsWith('.ts') && !/\.(d|test|spec)\.ts$/.test(p))
    .map((p) => relative(dir, p).split(sep).join('/'))
    .filter((rel) => !rel.split('/').some((s) => s.startsWith('_')))
    .filter((rel) => /^\s*export\s+(?:async\s+)?(?:function|const|let)\s+onRequest\w*/m.test(readFileSync(join(dir, rel), 'utf8')))
    .map((rel) => rel.replace(/\.ts$/, '').replace(/(^|\/)index$/, '').replace(/\[\[?[^\]]+\]?\]/g, 'probe'));
}

/** Every top-level public/*.json the bake scripts write (writeFileSync/outPath via join(pub, 'x.json')). */
function bakedJson(): string[] {
  const out = new Set<string>();
  for (const f of ['bake-mirror.ts', 'bake-warehouse.ts']) {
    const src = readFileSync(join(root, 'scripts', f), 'utf8');
    for (const m of src.matchAll(/join\(\s*pub\s*,\s*'([^'/]+\.json)'\s*\)/g)) out.add(m[1]!);
  }
  return [...out];
}

function probePaths(): string[] {
  const cmd =
    `. '${lib}'; ` +
    `$p = Get-AccessGateProbePaths -DistPath '' -FunctionsDirs @('${join(root, 'functions')}') -IncludeWarehouse; ` +
    `ConvertTo-Json -InputObject @($p) -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim()) as string[];
}

describe('access-gate probe (scripts/lib/access-gate-probe.ps1)', () => {
  it.runIf(onWindows)(
    'smoke test passes: alias, baked JSON and /api/ targets are all probed and an exposure fails the gate',
    () => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', smoke], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
      expect(out).toContain('ALL PASS');
      expect(r.status, out).toBe(0);
    },
    150_000,
  );

  it.runIf(onWindows)(
    'the derived probe paths cover every functions/ route and every baked public/*.json',
    () => {
      const routes = functionRoutes();
      const baked = bakedJson();
      // Sanity: the enumerations see what is there today, so an empty result cannot pass vacuously.
      expect(routes).toEqual(expect.arrayContaining(['api/ai', 'api/whoami', 'api/warehouse/acquisition/score']));
      expect(baked).toEqual(expect.arrayContaining(['snapshot.json', 'macro.json', 'warehouse.json']));
      const paths = probePaths();
      expect(paths).toContain('');
      for (const r of routes) expect(paths, `functions/ route /${r} is not probed`).toContain(r);
      for (const j of baked) expect(paths, `baked /${j} is not probed`).toContain(j);
    },
    90_000,
  );

  it('deploy-mirror.ps1 verifies through the derived all-targets probe on both paths, never the apex-only form', () => {
    const src = readFileSync(join(root, 'scripts', 'deploy-mirror.ps1'), 'utf8');
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toContain('lib\\access-gate-probe.ps1');
    // probe paths derived from the built dist/ and the functions/ trees, warehouse.json when baked
    expect(code).toMatch(/\$probePaths = Get-AccessGateProbePaths -DistPath \$distPath -FunctionsDirs [^\n]*'functions'[^\n]*-IncludeWarehouse:\$IncludeWarehouse/);
    expect((code.match(/Get-AccessGateProbeTargets [^\n]*-ProbePaths \$probePaths/g) ?? []).length).toBe(2);
    // success path requires the per-deployment alias (reported AFTER probing, via -Unprobed)
    expect(code).toMatch(/Get-MissingAliasRequirement -DeployOutput \$deployOutput/);
    expect(code).toMatch(/Assert-AccessGateOnAllTargets -Targets \$gateTargets[^\n]*-Unprobed \$gateUnprobed/);
    expect((code.match(/Assert-AccessGateOnAllTargets /g) ?? []).length).toBe(2);
    // the old single-URL call (apex only) must not come back
    expect(code).not.toMatch(/Invoke-AccessGateProbe -VerifyUrl \$VerifyUrl/);
    // wrangler output is captured so the alias can be parsed
    expect(code).toMatch(/-OutputFile \$deployLog/);
  });

  it('the probe lib keeps no hand-kept path list (derivation only)', () => {
    const src = readFileSync(lib, 'utf8');
    expect(src).not.toMatch(/AccessGateProbePaths\s*=\s*@\(/);
  });
});
