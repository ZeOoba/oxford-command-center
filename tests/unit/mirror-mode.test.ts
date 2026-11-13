import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCESS_PREPROBE_PASSED, resolveMirrorMode } from '../../scripts/lib/mirror-mode';
import { loadEnvFile, PROCESS_ENV_ONLY_KEYS } from '../../server/load-env';

// Audit wf_9bf74429-aaf finding 31: MIRROR_INCLUDE_CONFIDENTIAL could come from .env, so a manual
// `npm run deploy:mirror` shipped the FULL bake with no Access probe; env.example contradicted the
// deploy script. FULL mode now needs the flag from the real process env AND the deploy script's
// passed pre-deploy probe; the manual path is REDACTED only.
const root = process.cwd();
const onWindows = process.platform === 'win32';

describe('resolveMirrorMode', () => {
  it('defaults to REDACTED', () => {
    for (const v of [undefined, '', '0']) {
      expect(resolveMirrorMode({ MIRROR_INCLUDE_CONFIDENTIAL: v })).toEqual({ includeConfidential: false, refusal: null });
    }
  });

  it('refuses FULL without the passed pre-deploy probe, and never silently downgrades it', () => {
    for (const probe of [undefined, '', '1', 'true', 'PASSED', 'failed']) {
      const m = resolveMirrorMode({ MIRROR_INCLUDE_CONFIDENTIAL: '1', MIRROR_ACCESS_PREPROBE: probe });
      expect(m.includeConfidential).toBe(false);
      expect(m.refusal).toMatch(/refusing the FULL/);
    }
  });

  it('allows FULL only with MIRROR_ACCESS_PREPROBE=passed', () => {
    expect(resolveMirrorMode({ MIRROR_INCLUDE_CONFIDENTIAL: '1', MIRROR_ACCESS_PREPROBE: ACCESS_PREPROBE_PASSED })).toEqual({
      includeConfidential: true,
      refusal: null,
    });
  });

  it('refuses an unrecognised flag value instead of guessing', () => {
    for (const v of ['true', 'yes', ' 1', '2']) {
      expect(resolveMirrorMode({ MIRROR_INCLUDE_CONFIDENTIAL: v }).refusal).toMatch(/must be unset, '0' or '1'/);
    }
  });
});

describe('the FULL-mode keys never come from .env', () => {
  const saved = Object.fromEntries(PROCESS_ENV_ONLY_KEYS.map((k) => [k, process.env[k]]));
  let dir = '';
  afterEach(() => {
    for (const k of PROCESS_ENV_ONLY_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete process.env.MIRROR_MODE_TEST_OTHER;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('loadEnvFile skips them but still loads other keys', () => {
    for (const k of PROCESS_ENV_ONLY_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'mirror-mode-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'MIRROR_INCLUDE_CONFIDENTIAL=1\nMIRROR_ACCESS_PREPROBE=passed\nMIRROR_MODE_TEST_OTHER=ok\n');
    loadEnvFile(env);
    expect(process.env.MIRROR_INCLUDE_CONFIDENTIAL).toBeUndefined();
    expect(process.env.MIRROR_ACCESS_PREPROBE).toBeUndefined();
    expect(process.env.MIRROR_MODE_TEST_OTHER).toBe('ok');
  });

  // Refute wf_ec2162a9-34f: Windows env is case-insensitive, so a lowercase .env key used to slip past
  // an exact-match skip and read back as the canonical name.
  it('loadEnvFile skips them in any letter case, so resolveMirrorMode stays REDACTED', () => {
    for (const k of PROCESS_ENV_ONLY_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'mirror-mode-case-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'mirror_include_confidential=1\nMirror_Access_Preprobe=passed\n');
    loadEnvFile(env);
    expect(resolveMirrorMode(process.env)).toEqual({ includeConfidential: false, refusal: null });
    expect(process.env.MIRROR_INCLUDE_CONFIDENTIAL).toBeUndefined();
  });

  it('the PowerShell .env import skips exactly the same keys', () => {
    const ps = readFileSync(join(root, 'scripts', 'lib', 'deploy-buildroot.ps1'), 'utf8');
    const m = /\$script:ProcessEnvOnlyKeys = @\(([^)]*)\)/.exec(ps);
    expect(m).not.toBeNull();
    const keys = [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
    expect(keys.sort()).toEqual([...PROCESS_ENV_ONLY_KEYS].sort());
    expect(ps).toMatch(/if \(\$script:ProcessEnvOnlyKeys -contains \$key\) \{ continue \}/);
  });

  it.runIf(onWindows)(
    'Import-DotEnvIntoEnvironment really skips them',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'mirror-mode-ps-'));
      const env = join(dir, '.env');
      // Mixed case on purpose: PowerShell's -contains is case-insensitive, matching load-env.ts.
      writeFileSync(env, 'mirror_include_confidential=1\nMirror_Access_Preprobe=passed\nMIRROR_MODE_TEST_OTHER=ok\n');
      const lib = join(root, 'scripts', 'lib', 'deploy-buildroot.ps1');
      const cmd =
        `$ErrorActionPreference='Stop'; Remove-Item Env:\\MIRROR_INCLUDE_CONFIDENTIAL,Env:\\MIRROR_ACCESS_PREPROBE -ErrorAction SilentlyContinue; ` +
        `. '${lib}'; $n = Import-DotEnvIntoEnvironment -Path '${env}'; ` +
        `"n=$n inc=[$env:MIRROR_INCLUDE_CONFIDENTIAL] probe=[$env:MIRROR_ACCESS_PREPROBE] other=[$env:MIRROR_MODE_TEST_OTHER]"`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, MIRROR_INCLUDE_CONFIDENTIAL: '', MIRROR_ACCESS_PREPROBE: '' },
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout.trim()).toBe('n=1 inc=[] probe=[] other=[ok]');
    },
    90_000,
  );
});

describe('the manual deploy path and the template', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('deploy:mirror prechecks REDACTED-only before it builds, and build:mirror scans dist/ after the build', () => {
    expect(pkg.scripts['deploy:mirror']).toMatch(/^tsx scripts\/scan-mirror-dist\.ts --precheck-redacted-only && npm run build:mirror && /);
    // check:rct-pin first: the bundled RCT must be the pinned ratified table before anything is built (docs/ops/rct-runtime-config.md).
    expect(pkg.scripts['build:mirror']).toBe('npm run check:rct-pin && npm run bake && npm run build && tsx scripts/scan-mirror-dist.ts');
  });

  it('env.example no longer offers MIRROR_INCLUDE_CONFIDENTIAL as a .env setting', () => {
    const ex = readFileSync(join(root, 'env.example'), 'utf8');
    expect(ex).not.toMatch(/^\s*#?\s*MIRROR_INCLUDE_CONFIDENTIAL\s*=/m);
    expect(ex).not.toMatch(/^\s*#?\s*MIRROR_ACCESS_PREPROBE\s*=/m);
    expect(ex).toMatch(/do NOT put either in \.env/);
    expect(ex).toMatch(/scripts\/deploy-mirror\.ps1/);
  });
});
