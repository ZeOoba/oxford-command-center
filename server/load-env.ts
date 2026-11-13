import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to this repo's `.env`, anchored to THIS FILE's own on-disk location rather than
 * `process.cwd()` (confirmed empirically 2026-07-09: `npm --prefix <dir> run <script>` does NOT
 * chdir the spawned script to <dir> — cwd stays whatever the invoking process's cwd was). A
 * cwd-relative default silently found no `.env` when launched that way (e.g. from a launch.json/
 * task runner outside the repo), so `WORKBOOK_PATH` fell back to config.ts's hardcoded default.
 * A worktree's own `load-env.ts` still resolves to that worktree's own root, so per-worktree
 * `.env` files keep working as before.
 */
export function defaultEnvPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
}

/**
 * Load `.env` with override-on-empty. Node's `--env-file` does NOT override a variable that is
 * already present in the environment — so if a shell exports an empty `ANTHROPIC_API_KEY=""`
 * (some sandboxes/CI do), the `.env` value is silently ignored and the agent runs key-less.
 * This loader fills any key that is missing OR empty, so dropping a key in `.env` always works.
 * Existing NON-empty env vars still win (real overrides are respected).
 */
/**
 * Keys that are honoured ONLY from the real process environment and never filled from `.env`
 * (audit wf_9bf74429-aaf finding 31). MIRROR_INCLUDE_CONFIDENTIAL turns the mirror bake into the
 * FULL confidential bake; a stray line in a copied `.env` must not be able to do that, so the flag
 * has to be set deliberately by the process that also proved the target is behind Cloudflare Access
 * (scripts/deploy-mirror.ps1, which sets MIRROR_ACCESS_PREPROBE after its pre-deploy probe passes).
 * scripts/lib/deploy-buildroot.ps1 Import-DotEnvIntoEnvironment skips the same keys;
 * tests/unit/mirror-mode.test.ts pins the two lists together.
 */
export const PROCESS_ENV_ONLY_KEYS: readonly string[] = ['MIRROR_INCLUDE_CONFIDENTIAL', 'MIRROR_ACCESS_PREPROBE'];

/** True when `key` names a PROCESS_ENV_ONLY_KEYS entry in any letter case. */
export function isProcessEnvOnlyKey(key: string): boolean {
  const k = key.toUpperCase();
  return PROCESS_ENV_ONLY_KEYS.some((x) => x === k);
}

export function loadEnvFile(path = defaultEnvPath()): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    // Never from .env (finding 31). Case-INSENSITIVE: Windows env is, so `mirror_include_confidential=1`
    // would otherwise slip past and read back as MIRROR_INCLUDE_CONFIDENTIAL (refute wf_ec2162a9-34f).
    if (isProcessEnvOnlyKey(key)) {
      console.warn(`  ⚠ load-env: ignoring ${key} in .env — it is honoured only from the real process environment.`);
      continue;
    }
    const value = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[key]) process.env[key] = value; // fill missing OR empty
  }
}
