// scripts/ensure-deps.mjs
//
// Self-heal guard run as `pregate` (npm runs it automatically before `npm run gate`). If
// node_modules was wiped or left partial — e.g. by a background disk-cleanup task on this
// disk-constrained workstation, which silently removed the entire tree mid-session on
// 2026-06-13 — restore it deterministically from the lockfile before the gate runs. No-op
// (fast existsSync check) when deps are present. Uses ONLY Node built-ins so it runs even
// with an empty node_modules.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Sentinels the gate cannot run without. Checking each package's package.json is cross-platform
// (unlike the .bin shims, whose names differ on Windows vs POSIX).
const sentinels = ['vitest', 'typescript', 'vite', 'eslint'].map((p) => `node_modules/${p}/package.json`);
const missing = sentinels.filter((p) => !existsSync(join(root, p)));

if (missing.length === 0) process.exit(0);

console.warn(`[ensure-deps] node_modules incomplete (missing: ${missing.join(', ')}) — restoring via \`npm ci\`…`);
try {
  execSync('npm ci', { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.error('[ensure-deps] `npm ci` failed — run it manually.', err?.message ?? err);
  process.exit(1);
}
