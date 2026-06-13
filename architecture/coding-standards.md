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

**Gate requirement:** `npm run gate` must stay green. Never commit with failing tests.

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
