// Type declarations for scripts/install-git-hooks.mjs.
//
// The module is plain ESM JavaScript — it is executed by `npm run prepare`, never compiled — so a
// TypeScript consumer has nothing to resolve for it. tests/unit/install-git-hooks.test.ts imports
// WRAPPER from it, which failed the build with:
//
//   tests/unit/install-git-hooks.test.ts(7,25): error TS7016: Could not find a declaration file
//   for module '../../scripts/install-git-hooks.mjs' ... implicitly has an 'any' type.
//
// That took `npm run typecheck` -> `npm run build:mirror` down with exit 2, and with it every
// hourly mirror deploy (2026-08-16). It reached main via a direct push rather than a PR, so CI
// never had a chance to catch it.
//
// Declaration ONLY — no runtime behaviour, and install-git-hooks.mjs itself is untouched.
// Named .d.mts rather than .d.ts so it pairs with the `.mjs` specifier the test actually imports.
export const WRAPPER: string;
