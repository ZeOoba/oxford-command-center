import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

// mirror-gate-probe-apex-only (audit 2026-11-08; refute runs wf_44a3341e-b41 and wf_c135181a-31a).
// The deploy's Access-gate check is PowerShell (scripts/lib/access-gate-probe.ps1). This file:
//  1. runs its smoke test, which dot-sources the REAL probe with a mocked curl;
//  2. checks that EVERY file under functions/ is either probed as a route or on the explicit
//     not-a-route allowlist, and that every top-level JSON the bake writes is probed. The functions/
//     check uses NO export-syntax matching (the second refute run showed a test sharing the
//     derivation's export regex shares its blind spot): it walks the files, maps each path to its
//     route itself, and fails on any file it cannot account for -- including file types the
//     derivation does not route at all.
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

/** Files under functions/ that Pages never serves as code: type declarations, tests, and data/docs. */
const NOT_CODE = /\.d\.ts$|\.(test|spec)\.[a-z]+$|\.(json|md|txt)$/i;

/** How Pages maps a functions/ file to a URL path (independent of the PowerShell mapping). */
function routeOf(rel: string): string {
  return rel
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/(^|\/)index$/, '')
    .replace(/\[\[?[^\]]+\]?\]/g, 'probe');
}

function runPs(cmd: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

function probePaths(functionsDir: string): string[] {
  return JSON.parse(
    runPs(
      `. '${lib}'; $p = Get-AccessGateProbePaths -DistPath '' -FunctionsDirs @('${functionsDir}') -IncludeWarehouse; ` +
        `ConvertTo-Json -InputObject @($p) -Compress`,
    ),
  ) as string[];
}

function notARouteAllowlist(): string[] {
  return JSON.parse(runPs(`. '${lib}'; ConvertTo-Json -InputObject @(Get-FunctionsNotARoute) -Compress`)) as string[];
}

/** Every functions/ file (relative path) that is neither a probed route nor allowlisted. */
function uncoveredFunctionFiles(functionsDir: string, allowlist: readonly string[]): string[] {
  const paths = probePaths(functionsDir);
  return walk(functionsDir)
    .map((p) => relative(functionsDir, p).split(sep).join('/'))
    .filter((rel) => !NOT_CODE.test(rel))
    .filter((rel) => !allowlist.includes(rel) && !paths.includes(routeOf(rel)));
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

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(base, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
}

describe('access-gate probe (scripts/lib/access-gate-probe.ps1)', () => {
  it.runIf(onWindows)(
    'smoke test passes: alias, baked JSON and Function targets are all probed and an exposure fails the gate',
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
    'every functions/ file is probed or allowlisted as not-a-route, and every baked public/*.json is probed',
    () => {
      const fnDir = join(root, 'functions');
      const allowlist = notARouteAllowlist();
      // Sanity: the walk sees today's Functions, so an empty result cannot pass vacuously.
      const files = walk(fnDir).map((p) => relative(fnDir, p).split(sep).join('/'));
      expect(files).toEqual(expect.arrayContaining(['api/ai.ts', 'api/whoami.ts', 'api/warehouse/acquisition/score.ts']));
      expect(uncoveredFunctionFiles(fnDir, allowlist)).toEqual([]);
      // No stale allowlist entry: each names a file that exists.
      for (const a of allowlist) expect(files, `stale not-a-route entry ${a}`).toContain(a);
      const baked = bakedJson();
      expect(baked).toEqual(expect.arrayContaining(['snapshot.json', 'macro.json', 'warehouse.json']));
      const paths = probePaths(fnDir);
      expect(paths).toContain('');
      for (const j of baked) expect(paths, `baked /${j} is not probed`).toContain(j);
    },
    120_000,
  );

  it.runIf(onWindows)(
    'pins refute run wf_c135181a-31a: a re-exported .ts handler and .js/.mjs Functions are probed; an unroutable file type is caught',
    () => {
      const tmp = mkdtempSync(join(tmpdir(), 'agp-fn-'));
      try {
        writeTree(tmp, {
          'api/warehouse/export.ts': "const onRequestGet = async () => new Response('x'); export { onRequestGet };",
          'api/legacy.js': "export const onRequestGet = () => new Response('x');",
          'api/aliased.mjs': 'function h() {} export { h as onRequestPost };',
          'admin.ts': 'export var onRequestPost = () => null;',
          'api/types.d.ts': 'export type X = 1;',
        });
        const paths = probePaths(tmp);
        for (const r of ['api/warehouse/export', 'api/legacy', 'api/aliased', 'admin']) expect(paths).toContain(r);
        expect(uncoveredFunctionFiles(tmp, [])).toEqual([]);
        // The checker bites: a file the derivation does not route (and nobody allowlisted) is reported.
        writeTree(tmp, { 'api/bundle.cjs': 'module.exports = {};', '_shared/helper.ts': 'export const x = 1;' });
        expect(uncoveredFunctionFiles(tmp, []).sort()).toEqual(['_shared/helper.ts', 'api/bundle.cjs']);
        expect(uncoveredFunctionFiles(tmp, ['_shared/helper.ts', 'api/bundle.cjs'])).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('deploy-mirror.ps1 verifies through the derived all-targets probe on both paths, never the apex-only form', () => {
    const src = readFileSync(join(root, 'scripts', 'deploy-mirror.ps1'), 'utf8');
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toContain('lib\\access-gate-probe.ps1');
    // probe paths derived from the built dist/ and the functions/ trees, warehouse.json when baked
    // functions/ comes from the build root only: wrangler deploys from there (audit wf_9bf74429-aaf finding 1)
    expect(code).toMatch(/\$functionsDirs = @\(Join-Path \$buildRoot 'functions'\)/);
    expect(code).not.toMatch(/Join-Path \$repo 'functions'/);
    expect(code).toMatch(/\$probePaths\s*= Get-AccessGateProbePaths -DistPath \$distPath -FunctionsDirs \$functionsDirs -IncludeWarehouse:\$IncludeWarehouse/);
    // derived Function routes are probed strict on both paths
    expect(code).toMatch(/\$functionRoutes = Get-AccessGateFunctionRoutes -FunctionsDirs \$functionsDirs/);
    expect((code.match(/Assert-AccessGateOnAllTargets [^\n]*-StrictPaths \$functionRoutes/g) ?? []).length).toBe(2);
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
