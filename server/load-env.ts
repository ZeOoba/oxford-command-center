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
    const value = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[key]) process.env[key] = value; // fill missing OR empty
  }
}
