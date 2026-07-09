import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for PR #194: a stray early comment-closer inside a CSS comment
 * (mid-text, not a real terminator) silently leaked invalid CSS into the stylesheet.
 * `npm run build` (production) never caught it -- @tailwindcss/vite's build hook runs a
 * Lightning CSS optimize() pass that re-parses and sanitizes Tailwind's output before
 * Vite's own postcss stage ever sees it, masking the bug. The dev (serve) hook skips
 * that pass, so only `vite dev` actually crashed -- and nothing else in the gate
 * exercises that path.
 *
 * Boots the real dev-mode transform pipeline (via `createServer` in middleware mode --
 * no network listener) against the CSS entry, so a parse error here fails the gate
 * instead of only surfacing when someone happens to run the dev server.
 *
 * Runs as a standalone script (plain tsx, not through vitest): nesting `createServer`
 * inside THIS repo's vitest run breaks -- vitest is pinned to the `threads` pool
 * (`vitest.config.ts`, to dodge a separate Windows/Node 24 `forks` spawn fault) and a
 * nested esbuild service does not survive inside that worker_thread pool.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_ENTRY = '/src/tokens/theme.css';

async function main() {
  const server = await createServer({
    root: REPO_ROOT,
    configFile: resolve(REPO_ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    logLevel: 'silent',
  });

  try {
    const result = await server.transformRequest(CSS_ENTRY);
    if (!result || result.code.length === 0) {
      console.error(`✗ dev-css: ${CSS_ENTRY} transformed to empty output`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ dev-css: ${CSS_ENTRY} transforms cleanly via the dev (serve) pipeline (${result.code.length} bytes)`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('✗ dev-css: dev-mode transform of the CSS entry failed:');
  console.error(err);
  process.exitCode = 1;
});
