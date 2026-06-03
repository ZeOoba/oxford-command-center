import { existsSync, readFileSync } from 'node:fs';

/**
 * Load `.env` with override-on-empty. Node's `--env-file` does NOT override a variable that is
 * already present in the environment — so if a shell exports an empty `ANTHROPIC_API_KEY=""`
 * (some sandboxes/CI do), the `.env` value is silently ignored and the agent runs key-less.
 * This loader fills any key that is missing OR empty, so dropping a key in `.env` always works.
 * Existing NON-empty env vars still win (real overrides are respected).
 */
export function loadEnvFile(path = '.env'): void {
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
