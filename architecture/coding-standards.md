# Coding Standards — Oxford Command Center

**Status:** Architecture lock file — all agents must follow these standards. `npm run gate` enforces most of them automatically (typecheck + lint).

---

## TypeScript

**Compiler config:** `tsconfig.json` with `strict: true` + `noUncheckedIndexedAccess: true`.

- `noUncheckedIndexedAccess` means every array index access returns `T | undefined`. Always guard: `arr[0]` has type `T | undefined`, not `T`. Use `arr.at(0)` or check first.
- No `any`. No `@ts-ignore`. No `as unknown as T`. Use Zod `.parse()` at boundaries.
- No `!` (non-null assertion) on data that could realistically be null. Use optional chaining + nullish coalescing.
- All server-to-client data must cross through a Zod schema in `src/contracts/`. Never pass raw JSON to the client as an implicit type.

**Naming:**
| Thing | Convention | Example |
|-------|-----------|---------|
| Files | kebab-case | `warehouse-verify.ts`, `qb-excel.ts` |
| Functions | camelCase | `openWarehouse`, `runMigrations` |
| Types/Interfaces/Zod schemas | PascalCase | `PortfolioSnapshot`, `ImportBatch` |
| Constants | SCREAMING_SNAKE_CASE | `WAREHOUSE_DB`, `NOI_INCOME_CLASSES` |
| React components | PascalCase | `AlertsModule`, `IntelModule` |
| CSS classes | Tailwind utilities inline — no custom class names unless in a design token |
| Test descriptions | Plain English sentence describing behavior | `'returns 503 when warehouse unavailable'` |

---

## File Size & Responsibility

- One clear responsibility per file. If you can't describe what a file does in one sentence, split it.
- Server-side: pure computation functions (no I/O) belong in dedicated `.ts` files. Routes belong in `api.ts` files. DB access belongs in `queries.ts` / `actions.ts`.
- Client-side: each module has its own directory under `src/modules/`. Don't put logic in the module component file — extract to a separate `*.logic.ts` or hook.
- Files > 400 lines are a signal to split. Not a rule — a signal.

---

## Testing

**Framework:** vitest 2.x with jsdom environment.
**Pattern:** TDD — write the failing test first, watch it fail, then implement.

**Test file location:** `tests/unit/` for pure logic; `src/modules/**/*.test.tsx` for component tests; `tests/e2e/` for Playwright.

**Test naming:**
```typescript
describe('moduleName / function name', () => {
  it('does X when Y', () => { ... });
  it('throws when Z', () => { ... });
});
```

**What to test:**
- Pure functions: every code path, every edge case.
- Zod schemas: valid input parses, invalid input throws.
- Warehouse functions: use an in-memory SQLite (`:memory:`) — never use the production `data/warehouse/finance.sqlite` in tests.
- API routes: inject a temp-db via the `getDb` factory; test 200/400/503 paths.
- Do NOT test: React component internals, visx chart rendering, Tailwind class presence.

**In-memory SQLite pattern for warehouse tests:**
```typescript
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

**Test isolation & order:**
- **Per-file isolation is mandatory.** `vitest.config.ts` MUST keep `isolate: true` (guarded by `tests/unit/test-isolation.test.ts`). With `isolate: false` every file shares one module registry in the single worker, so module-level state AND unreset `vi.mock` registrations bleed across files in order-dependent ways — flakes that pass in isolation but fail intermittently in the full suite. The threads pool isolates without a `child_process` spawn, so isolation does not reintroduce the Node 24 + Windows forks spawn fault.
- **Never import `vitest.config.ts` into a test.** Importing it pulls in Vite, which trips a `TextEncoder/Uint8Array` invariant under the jsdom environment. To assert on config, read the file as text and match the setting (see the regression guard).
- **Detect order fragility with `npm run test:shuffle`.** It randomizes both file and test order (`--sequence.shuffle.files --sequence.shuffle.tests`). `isolate: true` covers *cross-file* leakage; shuffling also surfaces *within-file* ordering bugs (a test depending on state another test set up). On failure vitest prints the seed — re-run with `--sequence.seed=<N>` to reproduce deterministically.

**Gate requirement:** `npm run gate` must stay green. Never commit with failing tests.

**Financial-decision code — mandatory adversarial pass.** A green gate proves the code matches its
fixtures; it does NOT prove correctness on data the corpus never exercises. Any change to
financial-decision logic — a new or modified `evaluateConditions` alert rule, the analytics engine
(growth / drivers / anomalies / benchmarks / scores), NOI/reconciliation math, the acquisition
scorecard, or anything feeding capital allocation — gets the `refute-financial-change` workflow
(`.claude/workflows/refute-financial-change.js`) BEFORE merge: independent reviewers told to *break*
the change across the correctness / determinism / edge-case lenses, not bless it. This is not
optional and is separate from the standard code-review pass. It exists because a green gate has
shipped, among others: a collections rule that NaN-suppressed a real delinquency on a partial
overlay record, an alert-id collision that let one anomaly silently mark another read, and an
off-by-one aging-bucket tier — none of which any fixture caught. New `evaluateConditions` rules MUST
also (a) coerce every overlay-sourced numeric defensively (overlay JSON bypasses Zod on the live
path — see `server/overlay.ts`; coerce via the shared `coerceNonNegMoney` in `src/lib/money.ts`) and
(b) emit a collision-free `Insight.id` (guarded by `tests/unit/insight-id-uniqueness.test.ts`).

This is enforced mechanically: `npm run check:refute` (CI job `refute-required`, PR-only) fails when a
change to financial-decision source (`src/analytics/**`, `server/warehouse/**`, the anomaly bridge,
`server/overlay.ts`) lands without a `Refute-Reviewed: wf_<runId>` (or justified `Refute-Skip:`)
commit trailer. Make it a required check via branch protection to hard-block.

**Delivery-only allowlist.** Three files in `server/warehouse/` are pure route-plumbing and are
explicitly exempted from the trailer requirement (declared in `DELIVERY_ONLY_PATHS` in
`scripts/check-refute-required.ts`): `api.ts`, `debt-api.ts`, `actions.ts`. The gate is
fail-**closed** for everything else — any warehouse file not in the allowlist still requires a
trailer. Adding to the allowlist requires architect sign-off (same as any `architecture/` change);
a new file not yet listed just keeps requiring a trailer until it is explicitly approved and added.

_Caveat on `actions.ts`:_ it dispatches recompute (`scoreProperties`, `detectAnomalies`) but
contains no financial math of its own. It qualifies as delivery-only under the current definition;
re-evaluate this entry if it gains analytic logic.

**Escape hatch for unlisted route files.** If a PR touches a route file not yet in the allowlist
and you are confident it contains no financial math, use:

```text
Refute-Skip: route-only — <file(s)> contain no financial math
```

This trailer is acceptable for genuine plumbing PRs only. It is never acceptable for changes that
touch engine math, scoring, NOI/reconciliation, alert conditions, or the financial overlay.

---

## Imports

**Order (enforced by Prettier/ESLint):**
1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`hono`, `zod`, `better-sqlite3`)
3. Internal aliases (`@contracts`, `@analytics`, `@`)
4. Relative imports (`./`, `../`)

No default exports from utility/logic files. Named exports only.

---

## Error Handling

- Server routes: return typed JSON errors, never throw unhandled.
- Warehouse operations: use the `503 { error: 'warehouse unavailable' }` pattern when the DB is unreachable. Never crash the server on a missing SQLite file.
- Client: React error boundaries at module level. Query errors surface via TanStack Query's `error` state.
- Scripts (`gate`, `reconcile`, `warehouse-verify`): `process.exit(1)` with a clear message on failure. Never silent failures.

---

## Comments

Write no comments by default. Write a comment only when:
- The WHY is non-obvious (a hidden constraint, a workaround for a specific bug).
- A subtle invariant that would surprise a reader.

Never write:
- What the code does (well-named identifiers do that).
- TODOs in committed code (use GitHub issues).
- References to tasks, PRs, or dates (those belong in commit messages).

---

## Commits

Format: `type(scope): description`

| Type | Use for |
|------|---------|
| `feat` | New behavior |
| `fix` | Bug fix |
| `refactor` | No behavior change |
| `test` | Tests only |
| `docs` | Documentation only |
| `chore` | Config, deps, tooling |
| `perf` | Performance improvement |

Scope = affected module/subsystem (e.g., `warehouse`, `intel`, `governance`, `brief`).

Commit atomically — one logical change per commit. Always include test files in the same commit as the code they test.

---

## Git / PR Protocol

- Never push directly to `main`. All changes via PR.
- Branch naming: `feat/cc-<feature>`, `fix/cc-<bug>`, `worktree-<feature>` (worktree branches).
- Each worktree has ONE branch and ONE PR. See `architecture/agent-assignments.md`.
- Stacked PRs: list base branch in PR description. Merge order: base first, then stacked. See `CLAUDE.md §PR Protocol`.
- `npm run gate` must be green before requesting review.
- Squash merge into main (not merge commits).

---

## Security

- Never log secrets, API keys, or tenant PII.
- `data/overlay.json` is gitignored — never commit it.
- Confidential deal data stays off all external surfaces (enforced by `confidential-terms.json` hook).
- SQLite file (`data/warehouse/finance.sqlite`) is gitignored.
- CORS locked to localhost — never relax this.
- Confidential deal terms MAY live in this private repo's source (e.g. `src/data/seed-deals.ts`) by owner decision (2026-06-14); the `confidential-terms.json` egress guard still bars them from the public site, the `/dist/` mirror, Notion, and email.
