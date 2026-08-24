// scripts/prepare-hooks.mjs
//
// Thin `prepare`-lifecycle wrapper around `install-git-hooks.ts`. `npm prepare` runs
// unconditionally on every `npm install`/`npm ci` -- including one run with `--omit=dev`, which
// this repo's own CI/deploy paths don't do today, but a future environment might. `tsx` (needed
// to run install-git-hooks.ts) is a devDependency, so this file itself stays plain Node builtins
// and checks tsx is actually present on disk before invoking it, skipping gracefully (not failing
// the whole install) if it's missing -- installing the pre-push hooks is a dev-workflow nicety,
// not something that should be able to break `npm ci` in a constrained environment. Kept as its
// own tiny file rather than an inline `node -e` in package.json's "prepare" entry: nested quoting
// an `-e` one-liner through both cmd.exe and POSIX sh (npm's script-shell differs by platform) is
// exactly the kind of thing that looks fine locally and breaks silently elsewhere.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(tsxCli)) {
  console.warn(
    '[prepare] tsx not installed (devDependency omitted) -- skipping git hook install. ' +
      "Run 'npm run hooks:install' after a full 'npm install' to install them later.",
  );
  process.exit(0);
}

execFileSync(process.execPath, [tsxCli, join(root, 'scripts', 'install-git-hooks.ts')], {
  stdio: 'inherit',
  cwd: root,
});
