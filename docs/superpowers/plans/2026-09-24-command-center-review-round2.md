# Command Center Review — Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cross-screen basis disagreements left after the 2026-09-23 review (affiliate notes, residence, governor/alert tiering, feed freshness), make the empty and cold-start states honest, and ship the ops runbook — per Gabriel's 2026-09-24 rulings.

**Architecture:** Five PRs. A, B and C are stacked (A → B → C); D and E branch from `origin/main` on their own. One new pure module, `src/analytics/debt-basis.ts`, is the single home of the affiliate-note rule, and every debt surface filters through it: engine KPIs, the Capital › Debt summary, the per-property LTV alerts, `checkDebtBasis`, and the AI copy. That mirrors how `isInvestmentProperty` owns the residence rule. Components stay thin. Copy and sublabel builders live in `.ts` helpers with unit tests. The document index moves behind a message protocol. A worker thread owns the sqlite-vec handle, and the main thread only embeds the query and shapes the hits.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals/Parameters`), React 18, Vite 6, TanStack Query, Hono, better-sqlite3 + sqlite-vec, `node:worker_threads`, Zod v3, vitest (`pool: 'forks'`) + @testing-library/react, tsx.

## Global Constraints

- Base: branch `fix/cc-review-round2` at `origin/main` `cb461e5`, worktree `C:\Users\Owner\oxford-command-center\.claude\worktrees\cc-review-round2`. Before each PR, run `git fetch origin` and check the `origin/main` delta. Rebase a stacked branch onto its (possibly merged) parent before pushing. The repo lands several PRs a day.
- TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` (type-only imports use `import type`). Non-component exports go in `.ts` files (react-refresh lint). A `.tsx` file exports components only.
- Every PR leaves `npm run gate` green (11 steps; see `package.json` `gate`). Never `--no-verify`. The gate intermittently exits 0xC0000005 on this machine (memory `npm-test-intermittent-access-violation`). If the output is otherwise correct, rerun it and do not "fix" it.
- Commit with explicit paths only. Never `git add -A` or `git add .`. Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (already allowlisted in `scripts/commitmsg-trailer-guard.mjs:40`).
- **Refute gate** (`scripts/check-refute-required.ts`): any commit touching `server/**`, `scripts/**` or `src/analytics/**` carries `Refute-Reviewed: wf_<runId>`. Get the run id by invoking the `refute-financial-change` skill on that task's diff with the lenses named in its Refute step. A task may instead carry a truthful `Refute-Skip: <reason>`, and each task says which applies. Financial, alert and engine tasks are refute-required: Tasks 1, 2, 4, 5, 8, 9, 11, 12, 13 and 14. Run `npx tsx scripts/check-refute-required.ts` before every push.
- **Architect-owned files** (`.claude/hooks/architect-owned.json`) need the controller's sentinel. After Gabriel acknowledges the `review_needed` claim (Task 0), the controller runs `mkdir -p .claude/overrides && touch .claude/overrides/architect-edit-ok` at the worktree root. The sentinel is honored for 60 minutes, so re-touch it to extend. This plan touches `architecture/status.json` (Task 0), `src/analytics/engine.ts` (Tasks 2 and 8) and `server/index.ts` (Task 15). Each of those tasks is marked **(architect-owned)**. No task edits `src/contracts/**`, `package.json`, `tsconfig*.json` or `vite.config.ts`.
- Governor constants DSCR 1.25 / LTV 40% aggregate / 65% per-property **must not change**. Neither may `ALERT_THRESHOLDS.ltvCeiling`, `GOVERNOR_FALLBACK`, `capital-config.ts` or `config/*.json`. Tasks 2 and 4 change which debt feeds the LTV governor inputs, as ratified 2026-09-24. They do not change any boundary.
- No "Spine" wording on user surfaces. Use `spineLabel` / `noiBasisLabel` (`src/lib/spine-label.ts`).
- `isInvestmentProperty` (`src/analytics/property-basis.ts`) is the single residence predicate. `src/analytics/debt-basis.ts` (Task 1) is the single affiliate-note predicate. Never re-derive either inline.
- User-facing disclosure clauses lead a truncating sublabel, because KpiStat truncates from the end. Order is disclosure first, then basis, then metric.
- Warn-only data-quality flags use a non-`'reconciliation'` entity unless they are real errors. `checkDebtBasis` stays `entity: 'debt'`.
- Insight ids consumed by alert snooze/read and the brief dead-man diff (`server/brief/state.ts` `diffCriticalAlerts`) **must not change**: `lease-expiry-<id>`, `rollover-concentration-<bucket>`, `reconcile-fail`, `ltv-<id>`, `ltv-governor-<id>`, `dscr-floor-<id>`, `dscr-<id>`, `expiring-<id>`. Severity and impact may change as ratified.
- Never touch: `data/overlay.json`, `data/warehouse/finance.sqlite` (read-only queries, no DDL), `confidential-terms.json`, `.github/workflows/*`, `.claude/settings.json`, business-OneDrive files (Invariant 5). `data/snapshots/portfolio.json` is **read-only** here. Live cross-check scripts read it and never write it.
- Worktree env: see CLAUDE.md §5. Do not copy the real `.env` in for test runs. If a live-server check needs it, delete the copy afterwards (memory `worktree-bake-overlay-env`).
- Live cross-check scripts go in `.superpowers/` (gitignored) and are **deleted before `npm run gate`**, because `eslint .` does not ignore `.superpowers/`.
- Ratified inputs (Gabriel, 2026-09-24; memory `cc-review-round2-decisions`) are listed below. Do not re-ask them.
  - Affiliate notes are out of Overview Total Debt and per-property LTV, and are shown separately.
  - Equity stays investment-only and discloses the residence equity.
  - The residence is out of capital allocation and the Notion sync. The existing Notion row is left untouched.
  - The filter bar reads "13 investment · 1 other holding".
  - The governor loop runs on investment properties only.
  - L-1 is critical under 60 days and a warning at 60–90 days.
  - L-5 contributes $0 to Risk $.
  - `reconcile-fail` fires only on `severity='error'` flags.
  - AR freshness uses the newest import, plus a note of "N leases with stale AR".
  - The Overview key is bumped and saved layouts are discarded.
  - Follow-ups: doc-index worker, empty states, debt flag surfaced, per-loan debt comparison, Ops Runbook.

## PR map

| PR | Branch | Base | Items | Tasks |
|---|---|---|---|---|
| A — financial basis | `fix/cc-review-round2` | `origin/main` | 1, 14, 13 | 0–7 |
| B — residence / governor / alerts | `fix/cc-r2-b-residence-alerts` | PR A head | 2, 3, 4, 5, 6, 7, 8 | 8–14 |
| C — freshness + UX | `fix/cc-r2-c-freshness-ux` | PR B head | 9, 10, 12 | 15–17 |
| D — cold start (doc index off the main thread) | `fix/cc-r2-d-doc-index-worker` | `origin/main` | 11 | 18–20 |
| E — Ops Runbook | `docs/cc-r2-e-ops-runbook` | `origin/main` | 15 | 21 |

Stacked PR bodies say `Base branch: <parent>. Merge <parent> first.` (CLAUDE.md §7). Gabriel merges. Leave `main` integration to him.

## File inventory

**Create:**
`src/analytics/debt-basis.ts` · `src/modules/debt/debt-sublabels.ts` · `src/modules/health/reconciliation-card.ts` · `src/modules/health/feed-row.ts` · `server/ai/debt-basis-copy.ts` · `src/shell/filter-slice.ts` · `src/primitives/EmptyState.tsx` · `src/lib/warehouse-empty.ts` · `server/sources/doc-index-protocol.ts` · `server/sources/doc-index-core.ts` · `server/sources/doc-index-client.ts` · `server/sources/doc-index-worker.ts` · `scripts/doc-index-worker-smoke.ts` · `docs/ops/2026-09-24-ops-runbook-r1-r8.md` · test files listed per task.

**Modify:** listed per task.

## Pre-flight: readers of every field whose value changes (round-1 lesson a)

Enumerated at `cb461e5` with `git grep`. Each task's "Reader check" step re-runs the grep and fails the task if a new reader has appeared that is not listed here.

| Changed value | Readers (all updated or verified in the owning task) |
|---|---|
| `kpis.totalDebt`, `kpis.ltv` (Task 2) | `src/modules/overview/widgets.tsx:52`, `server/ai/respond.ts:56,66`, `server/ai/tools.ts:217-218,410` |
| `DebtSummary.externalDebt / annualDebtService / weightedAvgRate` (Task 2) | `src/modules/debt/DebtModule.tsx:152,159,164,220`, `server/ai/respond.ts:40,56`, `server/ai/tools.ts:278-280`. **Not changed:** `ladder`, `lenderDeployed`, `internalOutstanding` |
| per-property LTV reads (Task 4) | `src/analytics/conditions.ts:369-386` (alerts), `src/modules/portfolio/PortfolioModule.tsx:38`, `src/brain/EntityDrawer.tsx:300`, `server/ai/tools.ts:240`. **Deliberately raw:** `src/brain/CommandPalette.tsx:118` (source-of-record CSV export), `src/analytics/engine.ts:62` (`applyScenario` scenario recompute of the raw field). `Property.ltv` / `loanBalance` on the snapshot are **never mutated** |
| `checkDebtBasis` output (Task 5) | `server/reconcile-runtime.ts` `checkSnapshot`, `server/brain.ts` (via `checkSnapshot`), `scripts/reconcile-snapshot.ts`, `scripts/bake-mirror.ts`, HealthModule Data Quality card. None filter on `field === 'debt.basis'` today (`git grep "debt.basis"` → reconcile-runtime + tests only) |
| `CapitalAllocationReport.entries / propertyCount / portfolioNoi` (Task 9) | `server/warehouse/api.ts:948` (GET /capital-allocation), `:974` (sync-notion → `syncCapitalActionsToNotion`), `:1013` (ic-memo), `server/warehouse/insights-api.ts:80` (`generateCfHurdleDrag`). `buildPortfolioAllocation` verdicts come from `property_master`, which has no residence row (`server/warehouse/reconcile-noi.ts:418`), so they are unchanged |
| L-1 `lease-expiry-*` severity (Task 12) | brief critical-alert email (`server/brief/run.ts:125` `criticalIds`), `diffCriticalAlerts`, TierBoard tiers, AlertsModule. The id is unchanged |
| L-5 `impactAnnualUsd` (Task 13) | `insights.logic.ts` `totalsBySpine` / `sortByImpactDesc` / `buildTiers`, `widgets.tsx:192-205`, `conditions.ts:856-879` sort, `conditions.ts` `fillImpact` (no `entityId`, so not refilled), `server/brief/render.ts:52` top-impact pick, `AlertsModule.tsx:59` |
| `reconcile-fail` trigger (Task 14) | brief critical email, HealthModule (Task 6 makes its card severity-aware independently) |
| AR feed `lastAt` (Task 15) | `src/lib/healthSignal.ts` (reads `status` only), HealthModule Data Feeds card, TopBar HealthDot |

## Live-snapshot expected effects (read-only, `data/snapshots/portfolio.json`, asOf 2026-09-13, generatedAt 2026-09-14)

| Item | Before | After |
|---|---|---|
| Overview Total Debt | live total incl. the Rarig affiliate note | **live total less that note** (equals External Debt below), sublabel `+$X affiliate notes · property loan balances · 18.8% LTV` |
| Aggregate LTV (live investment value) | REDACTED-AMT | **REDACTED-AMT** |
| Capital › Debt External Debt | live total (5 borrower loans) | **same figure as Overview Total Debt**, sublabel `+$Y affiliate notes · loan schedule · 4 third-party borrower loans` |
| Annual Debt Service / Wtd Avg Rate | live ADS / 5.52% | ADS less the 3883 note's service / 5.50% |
| `checkDebtBasis` | 1 flag, one net affiliate gap | **0 flags.** All 4 third-party loans tie to their property rows to the cent |
| 1100 Rarig `ltv-governor-1100-rarig-ave-columbus-oh` (46.1%) | info insight | **gone** (affiliate note) |
| Equity Invested | live investment equity (no sublabel) | unchanged, sublabel `+$<residence equity> other holdings` |
| Capital allocation entries / Notion sync writes | 14 / 14 pages | **13 / 13**. The Persimmon Tree Notion row is not written |
| Filter bar (unfiltered) | no readout | `13 investment · 1 other holding` |
| L-1 (ref 2026-09-24) | 5 critical | **2 critical** (Example Trucking, EXAMPLE FREIGHT at 37d) + **3 warning** (Example Auto Salon, Example Ventures, Example Supply at 67d). Risk $ unchanged (warnings still count as risk) |
| L-5 | 0-6m bucket 13.3%, 6-12m 11.8% (<15%). Does not fire | no live change. Prevents a future double count of the bucket rent |
| reconcile-fail | snapshot has 0 dataQuality flags | no live change |
| AR feed | oldest record 2026-07-15 → "71d old (max 35d)", stale | newest 2026-08-21 → `7 leases with stale AR · 34d old`, amber (goes stale 2026-09-26 without a new import) |

---

### Task 0: Claim, review flag, baseline (architect-owned: `architecture/status.json`)

**Files:**
- Modify: `architecture/status.json` (append one entry after `"cc-review-fixes"`, whose closing brace is at line 683)
- Add: `docs/superpowers/plans/2026-09-24-command-center-review-round2.md` (this file)

- [ ] **Step 1: Confirm the base.** Run: `git -C C:/Users/Owner/oxford-command-center/.claude/worktrees/cc-review-round2 fetch origin && git -C C:/Users/Owner/oxford-command-center/.claude/worktrees/cc-review-round2 log --oneline -1 origin/main && git -C C:/Users/Owner/oxford-command-center/.claude/worktrees/cc-review-round2 status --short`. Expected: HEAD `cb461e5` (or later), and a clean tree except this plan file. If `origin/main` moved, run `git rebase origin/main` and re-verify every file:line cited in the task you're about to start (round-1 lesson c).
- [ ] **Step 2: Wait for the architect ack.** Tell the controller that Tasks 0, 2, 8 and 15 edit architect-owned files. After Gabriel acknowledges in-session, the controller touches the sentinel (Global Constraints).
- [ ] **Step 3: Add the status.json entry.** Change the `"cc-review-fixes"` entry's closing `  }` to `  },` and insert before the file's final `}`:

```json
  "cc-review-round2": {
    "agent_role": "Lead Architect (delegated)",
    "phase": "2026-09-24 command-center review round 2 (5 PRs)",
    "status": "in_progress",
    "blocked_by": null,
    "review_needed": true,
    "detail": "Architect-owned touches: architecture/status.json (this claim); src/analytics/engine.ts (Task 2: affiliate notes excluded from totalDebt/ltv, DebtSummary third-party basis + affiliateDebt; Task 8: otherHoldingsEquity/otherHoldingsDebt cells) — ratified by Gabriel 2026-09-24; server/index.ts (Task 15: AR feed = newest import + stale-lease note). No src/contracts/** edits. Plan: docs/superpowers/plans/2026-09-24-command-center-review-round2.md",
    "last_updated": "2026-09-24T00:00:00Z"
  }
```

- [ ] **Step 4: Validate governance.** Run: `npm run governance`. Expected: PASS.
- [ ] **Step 5: Baseline.** Run: `npm run gate`. Expected: every step green. Rerun once on 0xC0000005. Record the vitest total, which is the baseline test count.
- [ ] **Step 6: Commit.**

```bash
git add architecture/status.json docs/superpowers/plans/2026-09-24-command-center-review-round2.md
git commit -m "chore: claim cc-review-round2 and add the round-2 plan" -m "Refute-Skip: status claim + plan doc only; no code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## PR A — Financial basis (items 1, 14, 13)

### Task 1: `debt-basis.ts` — the single affiliate-note predicate

**Why a name list, not a heuristic:** neither the snapshot nor the workbook carries an "affiliate" field. The Property NOI row has `lender` (col 19, `server/workbook/parse.ts:415`). A borrower-direction loan has `lender = counterparty` (col 3, `parse.ts:994,1009`). No Oxford-entity list exists in config today. `config/lease-market.json` `oraOwnerNamePatterns` is `["Oxford Realty", "Oxford Realty Advisors"]`, which is an owner-screen list for a different domain and does not contain "Oxford Capital". So this task ships an explicit, whole-phrase, case-insensitive lender list, `['Oxford Capital']`, and tests it against every live lender string. **Blocking question Q1** (bottom of plan): Gabriel confirms the list is complete before PR A merges.

Why the rule is limited to borrower direction: every *lender*-direction note also names "(Oxford Capital)", because Oxford is the lender there (Note Party 02, 100 Note Party St, Note Party 01). Those positions are Capital Deployed, not debt, and stay untouched.

**Files:**
- Create: `src/analytics/debt-basis.ts`
- Modify: `src/analytics/index.ts` (add one export line)
- Test: `tests/unit/debt-basis.test.ts`

**Interfaces:**
- Produces (all pure, exported from `src/analytics/debt-basis.ts` and re-exported by `@analytics/index`):
  - `AFFILIATE_LENDER_NAMES: readonly string[]`
  - `namesAffiliateLender(text: string | null | undefined): boolean`
  - `isAffiliateNoteProperty(p: { readonly lender?: string | null; readonly loanBalance?: number | null }): boolean`
  - `isAffiliateBorrowerLoan(l: { readonly direction: string; readonly lender?: string | null; readonly counterparty?: string | null }): boolean`
  - `investmentLoanBalance(p: { readonly lender?: string | null; readonly loanBalance?: number | null }): number`
  - `investmentLtv(p: { readonly lender?: string | null; readonly loanBalance?: number | null; readonly ltv: number | null }): number | null`
  - `propertyLtvLabel(p: same as investmentLtv): string`, which returns `'affiliate note'` or `fmtPct(p.ltv)`
  - `affiliateNotesClause(amount: number | null | undefined): string`, e.g. `'+$1.11M affiliate notes'` or `''`
  - `DEBT_BASIS_FIELD: 'debt.basis'` and `isDebtBasisFlag(f: { readonly entity: string; readonly field: string }): boolean`

- [ ] **Step 1: Write the failing test.** Create `tests/unit/debt-basis.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_LENDER_NAMES,
  namesAffiliateLender,
  isAffiliateNoteProperty,
  isAffiliateBorrowerLoan,
  investmentLoanBalance,
  investmentLtv,
  propertyLtvLabel,
  affiliateNotesClause,
  DEBT_BASIS_FIELD,
  isDebtBasisFlag,
} from '../../src/analytics/debt-basis';

// Every lender / counterparty string below is copied verbatim from data/snapshots/portfolio.json
// (asOf 2026-09-13) so the predicate is proven against the live workbook's actual spellings.
describe('namesAffiliateLender — explicit Oxford lending-entity list, whole phrase, case-insensitive', () => {
  it('ships exactly the ratified list (Q1)', () => {
    expect(AFFILIATE_LENDER_NAMES).toEqual(['Oxford Capital']);
  });
  it.each([
    ['Oxford Capital', true], // 1100 Rarig Property NOI row lender
    ['oxford capital', true],
    ['Lender 05 / Oxford Capital — Oxford 50% share', true], // "3883 from Oxford (50%)" borrower lender
    ['Firm 04 (Oxford Capital) — Oxford 50% share', true], // lender-direction note (name matches; direction rule excludes it)
    ['Oxford Capital Partners', true], // an Oxford entity by name
    ['Oxford / Lender 03', false], // 29000 Information Lane — third party
    ['Muirkirk Properties (Servicer 01/Firm 03) — Oxford 50% share', false], // 9050 Red Branch — third party
    ['Lender 04', false],
    ['Lender 01', false],
    ['Oxford Capitalist Fund', false], // no partial-word match after
    ['NotOxford Capital', false], // no partial-word match before
    ['Firm 03', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(namesAffiliateLender(text)).toBe(expected);
  });
  it('null / undefined → false', () => {
    expect(namesAffiliateLender(null)).toBe(false);
    expect(namesAffiliateLender(undefined)).toBe(false);
  });
});

describe('isAffiliateNoteProperty — property row whose outstanding loan is owed to an Oxford lender', () => {
  it('live 1100 Rarig row → true', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: 1_111_111 })).toBe(true);
  });
  it('affiliate lender name but nothing outstanding → false (no note to exclude)', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: 0 })).toBe(false);
  });
  it('third-party lender → false', () => {
    expect(isAffiliateNoteProperty({ lender: 'Firm 03', loanBalance: 3_456_789.01 })).toBe(false);
  });
  it('no lender → false', () => {
    expect(isAffiliateNoteProperty({ lender: null, loanBalance: 0 })).toBe(false);
    expect(isAffiliateNoteProperty({})).toBe(false);
  });
});

describe('isAffiliateBorrowerLoan — borrower direction only', () => {
  const live3883 = {
    direction: 'borrower',
    lender: 'Lender 05 / Oxford Capital — Oxford 50% share',
    counterparty: 'Lender 05 / Oxford Capital — Oxford 50% share',
  };
  it('live "3883 from Oxford (50%)" → true', () => {
    expect(isAffiliateBorrowerLoan(live3883)).toBe(true);
  });
  it('matches on counterparty when lender is blank', () => {
    expect(isAffiliateBorrowerLoan({ ...live3883, lender: null })).toBe(true);
  });
  it('a LENDER-direction note naming Oxford Capital is capital deployed, never an affiliate debt → false', () => {
    expect(isAffiliateBorrowerLoan({ direction: 'lender', lender: null, counterparty: 'Firm 04 (Oxford Capital) — Oxford 50% share' })).toBe(false);
  });
  it('internal-direction accrual → false (already outside External Debt)', () => {
    expect(isAffiliateBorrowerLoan({ direction: 'internal', lender: null, counterparty: 'Firm 10' })).toBe(false);
  });
  it('third-party borrower → false', () => {
    const easton = 'Oxford / Lender 03';
    expect(isAffiliateBorrowerLoan({ direction: 'borrower', lender: easton, counterparty: easton })).toBe(false);
  });
});

describe('investment-basis helpers', () => {
  const rarig = { lender: 'Oxford Capital', loanBalance: 1_111_111, ltv: 0.4444444 };
  const easton = { lender: 'Firm 03', loanBalance: 2_456_789.12, ltv: 0.389966526984127 };
  it('investmentLoanBalance zeroes an affiliate note and passes third-party debt through', () => {
    expect(investmentLoanBalance(rarig)).toBe(0);
    expect(investmentLoanBalance(easton)).toBe(2_456_789.12);
    expect(investmentLoanBalance({ lender: null, loanBalance: null })).toBe(0);
  });
  it('investmentLtv is null for an affiliate note, raw ltv otherwise', () => {
    expect(investmentLtv(rarig)).toBeNull();
    expect(investmentLtv(easton)).toBe(0.389966526984127);
  });
  it('propertyLtvLabel names the exclusion instead of printing a number', () => {
    expect(propertyLtvLabel(rarig)).toBe('affiliate note');
    expect(propertyLtvLabel(easton)).toBe('39.0%');
    expect(propertyLtvLabel({ lender: null, loanBalance: 0, ltv: null })).toBe('—');
  });
  it('affiliateNotesClause formats a disclosure clause, or nothing', () => {
    expect(affiliateNotesClause(1_111_111)).toBe('+$1.11M affiliate notes');
    expect(affiliateNotesClause(333_333)).toBe('+$333K affiliate notes');
    expect(affiliateNotesClause(0)).toBe('');
    expect(affiliateNotesClause(null)).toBe('');
    expect(affiliateNotesClause(undefined)).toBe('');
  });
});

describe('isDebtBasisFlag — anchored on the debt.basis field family (round-1 lesson b)', () => {
  it.each([
    [{ entity: 'debt', field: 'debt.basis' }, true],
    [{ entity: 'debt', field: 'debt.basis.property.p1' }, true],
    [{ entity: 'debt', field: 'debt.basis.loan.n1' }, true],
    [{ entity: 'debt', field: 'debt.basisx' }, false],
    [{ entity: 'debt', field: 'xdebt.basis' }, false],
    [{ entity: 'reconciliation', field: 'debt.basis' }, false],
    [{ entity: 'lease', field: 'lease.l1.leaseEnd' }, false],
  ])('%o → %s', (flag, expected) => {
    expect(isDebtBasisFlag(flag)).toBe(expected);
  });
  it('exports the field root', () => {
    expect(DEBT_BASIS_FIELD).toBe('debt.basis');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/debt-basis.test.ts`. Expected: FAIL (`Failed to resolve import "../../src/analytics/debt-basis"`).
- [ ] **Step 3: Implement.** Create `src/analytics/debt-basis.ts`:

```ts
// src/analytics/debt-basis.ts
//
// Debt-basis rules — the ONE home for "which debt counts" (sibling of ./property-basis, which owns
// the residence rule). Ratified 2026-09-24 (Gabriel): Oxford-to-Oxford ("affiliate") notes are
// EXCLUDED from investment Overview Total Debt, aggregate LTV, per-property LTV and Capital › Debt
// External Debt, and shown separately ("+$X affiliate notes"). Live cases: the 1100 Rarig property
// row (lender "Oxford Capital") and the borrower loan "3883 from Oxford (50%)".
// With both excluded, the Overview-vs-Capital debt-basis flag reconciles to the cent.
//
// Identification: the workbook carries no "affiliate" field, so this is an explicit whole-phrase
// lender-name list — not a fuzzy heuristic — matched against Property.lender (Property NOI col 19)
// and a borrower loan's lender/counterparty (Loan Index col 3). Borrower direction ONLY: a
// lender-direction note naming "(Oxford Capital)" is Oxford's own receivable (Capital Deployed).
// The list is pending Gabriel's completeness confirmation (plan Q1); extend it here and nowhere else.
import { fmtPct, fmtUsdCompact } from './format';

/** Oxford lending entities. A note owed TO one of these BY an Oxford property is an affiliate note. */
export const AFFILIATE_LENDER_NAMES: readonly string[] = ['Oxford Capital'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole phrase: the name must not be glued to a letter/digit on either side ("NotOxford Capital",
// "Oxford Capitalist" do not match). No `g` flag, so `.test` carries no lastIndex state.
const AFFILIATE_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${AFFILIATE_LENDER_NAMES.map(escapeRe).join('|')})(?:[^a-z0-9]|$)`,
  'i',
);

export function namesAffiliateLender(text: string | null | undefined): boolean {
  return typeof text === 'string' && AFFILIATE_RE.test(text);
}

type DebtRow = { readonly lender?: string | null; readonly loanBalance?: number | null };

/** A property row whose outstanding loan balance is owed to an Oxford affiliate lender. */
export function isAffiliateNoteProperty(p: DebtRow): boolean {
  return (p.loanBalance ?? 0) > 0 && namesAffiliateLender(p.lender);
}

/** A BORROWER-direction loan-schedule row whose lender is an Oxford affiliate. */
export function isAffiliateBorrowerLoan(l: {
  readonly direction: string;
  readonly lender?: string | null;
  readonly counterparty?: string | null;
}): boolean {
  return l.direction === 'borrower' && (namesAffiliateLender(l.lender) || namesAffiliateLender(l.counterparty));
}

/** The property row's loan balance on the investment (third-party) basis: 0 for an affiliate note. */
export function investmentLoanBalance(p: DebtRow): number {
  return isAffiliateNoteProperty(p) ? 0 : (p.loanBalance ?? 0);
}

/** Per-property LTV on the investment basis: null when the row's only debt is an affiliate note. */
export function investmentLtv(p: DebtRow & { readonly ltv: number | null }): number | null {
  return isAffiliateNoteProperty(p) ? null : p.ltv;
}

/** Display label for a per-property LTV cell — names the exclusion rather than showing a number. */
export function propertyLtvLabel(p: DebtRow & { readonly ltv: number | null }): string {
  return isAffiliateNoteProperty(p) ? 'affiliate note' : fmtPct(p.ltv);
}

/** Disclosure clause for a debt headline, e.g. "+$1.11M affiliate notes"; '' when there are none. */
export function affiliateNotesClause(amount: number | null | undefined): string {
  return typeof amount === 'number' && amount > 0 ? `+${fmtUsdCompact(amount)} affiliate notes` : '';
}

/** Field root for the Overview-vs-Capital debt-basis data-quality flags (server/reconcile-runtime.ts). */
export const DEBT_BASIS_FIELD = 'debt.basis';

/** True for a debt-basis flag: entity 'debt' and field exactly 'debt.basis' or 'debt.basis.<…>'. */
export function isDebtBasisFlag(f: { readonly entity: string; readonly field: string }): boolean {
  return f.entity === 'debt' && (f.field === DEBT_BASIS_FIELD || f.field.startsWith(`${DEBT_BASIS_FIELD}.`));
}
```

In `src/analytics/index.ts`, add after `export * from './property-basis';`:

```ts
export * from './debt-basis';
```

- [ ] **Step 4: Run it and confirm it passes.** Run: `npx vitest run tests/unit/debt-basis.test.ts && npx tsc --noEmit -p tsconfig.json`. Expected: PASS, with no type errors (the re-export has no name collisions).
- [ ] **Step 5: Refute.** Invoke the `refute-financial-change` skill on `src/analytics/debt-basis.ts` with these lenses:
  1. False positive: a third-party lender whose name contains "Oxford" (the live "Oxford / Firm 03…", "…— Oxford 50% share").
  2. False negative: an affiliate spelled differently, such as "Oxford Cap."/"OxfordCapital", or a different Oxford entity. Record any finding as input to Q1 rather than widening the list unilaterally.
  3. Direction: a lender-direction receivable must never count.

  Record the run id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/debt-basis.ts src/analytics/index.ts tests/unit/debt-basis.test.ts
git commit -m "feat(debt): single affiliate-note predicate (Oxford-to-Oxford notes, ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Engine — affiliate notes out of Total Debt, LTV and External Debt (architect-owned: `src/analytics/engine.ts`)

**Files:**
- Modify: `src/analytics/engine.ts:12` (import), `:91` (`debt`), `:99` (`ltv` cell), `:105` (`totalDebt` cell), `:268-306` (`debtSummary`)
- Modify: `src/analytics/types.ts:36-52` (`PortfolioKpis`), `:98-105` (`DebtSummary`)
- Test: `tests/unit/debt-affiliate-engine.test.ts`

**Interfaces:**
- Consumes: `investmentLoanBalance`, `isAffiliateNoteProperty`, `isAffiliateBorrowerLoan` (Task 1).
- Produces: `PortfolioKpis.affiliateDebt: Cell` and `DebtSummary.affiliateDebt: number` / `DebtSummary.affiliateCount: number`. `kpis.totalDebt` and `kpis.ltv` exclude affiliate notes. `DebtSummary.externalDebt`, `annualDebtService` and `weightedAvgRate` cover third-party borrower loans only. `ladder`, `lenderDeployed` and `internalOutstanding` are unchanged. The ladder keeps the affiliate loan's maturity, because it is a position view and not External Debt.

- [ ] **Step 1: Reader check.** Run: `git grep -n "totalDebt\b\|kpis\.ltv\|k\.ltv\|externalDebt\|annualDebtService\|weightedAvgRate" -- src server scripts ":!src/analytics/engine.ts" ":!src/analytics/types.ts" ":!server/workbook" ":!server/warehouse/debt-scoring.ts"`. Expected: exactly the readers in the Pre-flight table. The `conditions.ts` hits are its own local `annualDebtService(l)` function, not this field. If any other file appears, stop and report it.
- [ ] **Step 2: Write the failing test.** Create `tests/unit/debt-affiliate-engine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyScenario, debtSummary, portfolioKpis } from '../../src/analytics/engine';
import type { Loan, PortfolioSnapshot, Property } from '../../src/contracts/index';

const p = (o: Partial<Property>) =>
  ({ id: 'x', name: 'x', sf: 0, occPct: 1, noi: 0, oxfordValue: 0, loanBalance: 0, equityInvested: 0, tenantCount: 0, type: 'Flex', lender: null, ...o }) as Property;
const loan = (o: Partial<Loan>) =>
  ({ id: 'n', name: 'n', counterparty: null, direction: 'borrower', absBalance: 0, currentBalance: 0, rate: null, monthlyPmt: null, maturity: null, balloon: false, lender: null, ...o }) as Loan;

describe('portfolioKpis — affiliate notes excluded from Total Debt and aggregate LTV (ratified 2026-09-24)', () => {
  const s = {
    properties: [
      p({ id: 'bank', oxfordValue: 10_000_000, loanBalance: 2_000_000, lender: 'Firm 03' }),
      p({ id: 'rarig', oxfordValue: 2_000_000, loanBalance: 1_000_000, lender: 'Oxford Capital' }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-24' },
  } as unknown as PortfolioSnapshot;

  it('totalDebt and ltv are third-party only; affiliateDebt carries the note; value is untouched', () => {
    const k = portfolioKpis(s);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(1_000_000);
    expect(k.ltv.value).toBeCloseTo(2_000_000 / 12_000_000, 12);
    expect(k.value.value).toBe(12_000_000);
  });

  it('no affiliate rows → affiliateDebt 0 and totalDebt = Σ loanBalance', () => {
    const k = portfolioKpis({ ...s, properties: [s.properties[0]!] } as PortfolioSnapshot);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(0);
  });

  it('the exclusion holds under a scenario (debt is never scenario-shocked)', () => {
    const k = portfolioKpis(applyScenario(s, 'Downside'), 'Downside');
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(1_000_000);
  });
});

describe('debtSummary — External Debt is third-party only; affiliate notes carried separately', () => {
  const affName = 'Lender 05 / Oxford Capital — Oxford 50% share';
  const loans = [
    loan({ id: 'bank', absBalance: 2_000_000, rate: 0.05, monthlyPmt: 10_000, lender: 'Firm 03', counterparty: 'Firm 03', maturity: '2030-01-01' }),
    loan({ id: 'aff', absBalance: 400_000, rate: 0.06, monthlyPmt: 4_000, lender: affName, counterparty: affName, maturity: '2035-06-01' }),
    loan({ id: 'rcv', direction: 'lender', absBalance: 500_000, counterparty: 'Firm 05 (Oxford Capital) — Oxford 50% share', maturity: '2027-02-20', balloon: true }),
    loan({ id: 'int', direction: 'internal', absBalance: 300_000, counterparty: 'Firm 08' }),
  ];

  it('externalDebt / annualDebtService / weightedAvgRate exclude the affiliate borrower loan', () => {
    const d = debtSummary(loans);
    expect(d.externalDebt).toBe(2_000_000);
    expect(d.annualDebtService).toBe(120_000);
    expect(d.weightedAvgRate).toBeCloseTo(0.05, 12);
    expect(d.affiliateDebt).toBe(400_000);
    expect(d.affiliateCount).toBe(1);
  });

  it('lender-direction notes naming Oxford Capital stay Capital Deployed; internal unchanged', () => {
    const d = debtSummary(loans);
    expect(d.lenderDeployed).toBe(500_000);
    expect(d.internalOutstanding).toBe(300_000);
  });

  it('the maturity ladder is a position view and keeps the affiliate note (2035 bucket); internal loans were never laddered', () => {
    // The ladder iterates borrowers + lenders only (engine.ts), so the internal row never reaches a bucket.
    expect(debtSummary(loans).ladder.map((b) => [b.period, b.balance])).toEqual([
      ['2027', 500_000],
      ['2030', 2_000_000],
      ['2035', 400_000],
    ]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `npx vitest run tests/unit/debt-affiliate-engine.test.ts`. Expected: FAIL. `k.totalDebt.value` is 3,000,000, `affiliateDebt` is undefined and `externalDebt` is 2,400,000.
- [ ] **Step 4: Implement `types.ts`.** In `PortfolioKpis`, after `totalDebt: Cell;` add:

```ts
  /** Σ property-row loan balances owed to an Oxford affiliate lender (src/analytics/debt-basis.ts) —
   *  excluded from totalDebt / ltv and disclosed beside them (ratified 2026-09-24). */
  affiliateDebt: Cell;
```

Replace `DebtSummary` with:

```ts
export interface DebtSummary {
  /** Σ THIRD-PARTY borrower loans (affiliate notes excluded — ratified 2026-09-24). */
  externalDebt: number;
  /** Σ borrower loans owed to an Oxford affiliate lender — disclosed beside externalDebt. */
  affiliateDebt: number;
  affiliateCount: number;
  internalOutstanding: number;
  lenderDeployed: number;
  /** Third-party borrower loans only (same basis as externalDebt). */
  annualDebtService: number;
  /** Balance-weighted over third-party borrower loans only (same basis as externalDebt). */
  weightedAvgRate: number | null;
  /** Position view: every borrower (incl. affiliate) + lender loan with its maturity bucket. */
  ladder: MaturityBucket[];
}
```

- [ ] **Step 5: Implement `engine.ts`.** Add the import after line 12:

```ts
import { investmentLoanBalance, isAffiliateNoteProperty, isAffiliateBorrowerLoan } from './debt-basis';
```

In `portfolioKpis`, replace `const debt = sum(p.map((x) => x.loanBalance));` with:

```ts
  // Ratified 2026-09-24 (Gabriel): Oxford-to-Oxford (affiliate) notes are excluded from Total Debt and
  // the aggregate LTV and disclosed separately — the single rule lives in ./debt-basis.
  const debt = sum(p.map(investmentLoanBalance));
  const affiliateDebt = sum(p.filter(isAffiliateNoteProperty).map((x) => x.loanBalance));
```

Replace the `ltv:` and `totalDebt:` lines of the returned object with:

```ts
    ltv: cell(value ? debt / value : null, DERIVED, 'derived', { formula: 'Σ third-party loan balance / Σ value (affiliate notes excluded)' }),
```

```ts
    totalDebt: cell(debt, 'Property NOI · Σ loan balance (affiliate notes excluded)', 'confirmed'),
    affiliateDebt: cell(affiliateDebt, 'Property NOI · Σ loan balance owed to an Oxford affiliate', 'confirmed'),
```

Replace the head of `debtSummary`, from `const borrowers = …` through `const weightedAvgRate = …`, with:

```ts
  const borrowersAll = loans.filter((l) => l.direction === 'borrower');
  // Ratified 2026-09-24: External Debt and its rate/service figures are THIRD-PARTY only; affiliate
  // (Oxford-to-Oxford) borrower notes are carried separately so Overview and Capital › Debt reconcile.
  const affiliates = borrowersAll.filter(isAffiliateBorrowerLoan);
  const borrowers = borrowersAll.filter((l) => !isAffiliateBorrowerLoan(l));
  const lenders = loans.filter((l) => l.direction === 'lender');
  const internal = loans.filter((l) => l.direction === 'internal');

  const externalDebt = sum(borrowers.map((l) => l.absBalance));
  const affiliateDebt = sum(affiliates.map((l) => l.absBalance));
  const lenderDeployed = sum(lenders.map((l) => l.absBalance));
  const internalOutstanding = sum(internal.map((l) => l.absBalance));
  const annualDebtService = sum(borrowers.map((l) => (l.monthlyPmt ?? 0) * 12));

  const rated = borrowers.filter((l) => l.rate !== null && l.absBalance > 0);
  const wb = sum(rated.map((l) => l.absBalance));
  const weightedAvgRate = wb ? sum(rated.map((l) => (l.rate as number) * l.absBalance)) / wb : null;
```

Change the ladder loop header to `for (const l of [...borrowersAll, ...lenders]) {` so the position view is unchanged. Replace the return object with:

```ts
  return {
    externalDebt,
    affiliateDebt,
    affiliateCount: affiliates.length,
    internalOutstanding,
    lenderDeployed,
    annualDebtService,
    weightedAvgRate,
    ladder: sortedLadder,
  };
```

- [ ] **Step 6: Run the tests.** Run: `npx vitest run tests/unit/debt-affiliate-engine.test.ts tests/unit/portfolio-kpis-residence.test.ts && npm run typecheck`. Expected: PASS. The residence test fixtures have `lender` undefined, so their totals are unchanged.
- [ ] **Step 7: Live cross-check (read-only).** Create `.superpowers/live-check-debt.ts`:

```ts
import { readFileSync } from 'node:fs';
import { portfolioKpis, debtSummary } from '../src/analytics/engine';
import type { PortfolioSnapshot } from '../src/contracts/index';

const s = JSON.parse(readFileSync('data/snapshots/portfolio.json', 'utf8')) as PortfolioSnapshot;
const k = portfolioKpis(s);
const d = debtSummary(s.loans);
console.log(JSON.stringify({ totalDebt: k.totalDebt.value, affiliateDebt: k.affiliateDebt.value, ltv: k.ltv.value, externalDebt: d.externalDebt, loanAffiliateDebt: d.affiliateDebt, ads: d.annualDebtService, war: d.weightedAvgRate }));
```

Run: `npx tsx .superpowers/live-check-debt.ts`. Expected (asOf 2026-09-13 snapshot): `totalDebt` equal to `externalDebt` (both on the third-party basis), `affiliateDebt` = the 1100 Rarig property-row balance, `ltv ≈ REDACTED-AMT`, `loanAffiliateDebt` = the "3883 from Oxford (50%)" balance, `ads` = the prior annual debt service less that note's service, `war ≈ REDACTED-AMT`. Paste the output into the PR A body, then `rm .superpowers/live-check-debt.ts`.
- [ ] **Step 8: Refute.** Invoke `refute-financial-change` on `engine.ts` + `types.ts` with these lenses:
  1. Aggregate-LTV governor input moves down, which is less conservative. Confirm it moves by exactly the affiliate note and no more, and that the governor constants are unchanged.
  2. Every reader in the Pre-flight table reads the new basis consistently.
  3. The ladder and lender/internal figures are unchanged.
  4. `applyScenario` still recomputes the raw per-property `ltv` field (ignored by alerts after Task 4).

  Record the id.
- [ ] **Step 9: Commit.**

```bash
git add src/analytics/engine.ts src/analytics/types.ts tests/unit/debt-affiliate-engine.test.ts
git commit -m "feat(debt): affiliate notes out of Total Debt, LTV and External Debt; disclosed separately (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Debt sublabels — disclose affiliate notes on Overview Total Debt and Capital › External Debt

**Files:**
- Create: `src/modules/debt/debt-sublabels.ts`
- Modify: `src/modules/overview/widgets.tsx:52`, `src/modules/debt/DebtModule.tsx:149-155` and `:218-224`
- Modify: `tests/unit/basis-labels.test.ts` (full replacement below)
- Test: `tests/unit/debt-sublabels.test.ts`

**Interfaces:**
- Consumes: `affiliateNotesClause`, `isAffiliateBorrowerLoan` (Task 1). `PortfolioKpis.affiliateDebt` and `DebtSummary.affiliateDebt` (Task 2).
- Produces: `overviewTotalDebtSublabel(k: Pick<PortfolioKpis, 'ltv' | 'affiliateDebt'>): string` and `externalDebtSublabel(d: Pick<DebtSummary, 'affiliateDebt'>, thirdPartyBorrowerCount: number): string`. Task 8 extends the first.

- [ ] **Step 1: Write the failing test.** Create `tests/unit/debt-sublabels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { overviewTotalDebtSublabel, externalDebtSublabel } from '../../src/modules/debt/debt-sublabels';
import type { PortfolioKpis } from '../../src/analytics/index';

const cell = (value: number | null) => ({ value, prov: { source: 't', confidence: 'derived' as const } });
const k = (ltv: number, affiliate: number) => ({ ltv: cell(ltv), affiliateDebt: cell(affiliate) }) as unknown as PortfolioKpis;

describe('overviewTotalDebtSublabel — disclosure, then basis, then metric', () => {
  it('live shape: affiliate clause leads', () => {
    expect(overviewTotalDebtSublabel(k(REDACTED-AMT, 1_111_111))).toBe('+$1.11M affiliate notes · property loan balances · 18.8% LTV');
  });
  it('no affiliate notes → basis leads', () => {
    expect(overviewTotalDebtSublabel(k(0.2, 0))).toBe('property loan balances · 20.0% LTV');
  });
});

describe('externalDebtSublabel', () => {
  it('live shape: 4 third-party loans + the 3883 affiliate note', () => {
    expect(externalDebtSublabel({ affiliateDebt: 333_333 }, 4)).toBe('+$333K affiliate notes · loan schedule · 4 third-party borrower loans');
  });
  it('singular, and no clause without affiliates', () => {
    expect(externalDebtSublabel({ affiliateDebt: 0 }, 1)).toBe('loan schedule · 1 third-party borrower loan');
  });
  it('tolerates a legacy/mocked summary with no affiliateDebt field', () => {
    expect(externalDebtSublabel({} as { affiliateDebt: number }, 2)).toBe('loan schedule · 2 third-party borrower loans');
  });
});
```

Replace `tests/unit/basis-labels.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { overviewTotalDebtSublabel, externalDebtSublabel } from '../../src/modules/debt/debt-sublabels';
import type { PortfolioKpis } from '../../src/analytics/index';

const cell = (value: number) => ({ value, prov: { source: 't', confidence: 'derived' as const } });

describe('basis labels', () => {
  it('Overview NOI tile states its basis; the debt tile uses the shared sublabel builder', () => {
    const w = readFileSync('src/modules/overview/widgets.tsx', 'utf8');
    expect(w).toContain('Oxford share · workbook');
    expect(w).toContain('overviewTotalDebtSublabel(k)');
  });
  it('Financials briefing states full-asset ledger basis', () => {
    expect(readFileSync('src/modules/intel/OwnershipView.tsx', 'utf8')).toContain('full-asset P&L ledger');
  });
  it('Capital external debt uses the shared sublabel builder', () => {
    expect(readFileSync('src/modules/debt/DebtModule.tsx', 'utf8')).toContain('externalDebtSublabel(');
  });
});

describe('basis labels lead (KpiStat truncates from the end) — a disclosure clause, when present, leads the basis', () => {
  it('NOI basis is the start of its sublabel', () => {
    expect(readFileSync('src/modules/overview/widgets.tsx', 'utf8')).toContain('sublabel={`Oxford share · workbook · ');
  });
  it('Total Debt: basis leads when there is nothing to disclose', () => {
    const k = { ltv: cell(0.2), affiliateDebt: cell(0) } as unknown as PortfolioKpis;
    expect(overviewTotalDebtSublabel(k).startsWith('property loan balances · ')).toBe(true);
  });
  it('External Debt: basis leads when there is nothing to disclose', () => {
    expect(externalDebtSublabel({ affiliateDebt: 0 }, 3).startsWith('loan schedule · ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/debt-sublabels.test.ts tests/unit/basis-labels.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Create `src/modules/debt/debt-sublabels.ts`:

```ts
// src/modules/debt/debt-sublabels.ts
//
// Sublabel builders for the two debt headlines (Overview "Total Debt", Capital › Debt "External
// Debt"). KpiStat truncates from the END, so a disclosure clause (affiliate notes excluded —
// ratified 2026-09-24) leads, then the basis clause (2026-09-23 review), then the metric. Shared so
// the ordering rule lives in one place and is unit-tested.
import { affiliateNotesClause, fmtPct } from '@analytics/index';
import type { DebtSummary, PortfolioKpis } from '@analytics/index';

const join = (parts: string[]): string => parts.filter((x) => x.length > 0).join(' · ');

export function overviewTotalDebtSublabel(k: Pick<PortfolioKpis, 'ltv' | 'affiliateDebt'>): string {
  return join([affiliateNotesClause(k.affiliateDebt.value), 'property loan balances', `${fmtPct(k.ltv.value)} LTV`]);
}

export function externalDebtSublabel(d: Pick<DebtSummary, 'affiliateDebt'>, thirdPartyBorrowerCount: number): string {
  const n = thirdPartyBorrowerCount;
  return join([affiliateNotesClause(d.affiliateDebt), 'loan schedule', `${n} third-party borrower loan${n === 1 ? '' : 's'}`]);
}
```

In `src/modules/overview/widgets.tsx`, add `import { overviewTotalDebtSublabel } from '../debt/debt-sublabels';` after line 15. Replace line 52's `sublabel={`property loan balances · ${fmtPct(k.ltv.value)} LTV`}` with `sublabel={overviewTotalDebtSublabel(k)}`. Keep `fmtPct`, because it is still used on line 48.

In `src/modules/debt/DebtModule.tsx`, add `isAffiliateBorrowerLoan` to the file's existing `@analytics/index` import, and add `import { externalDebtSublabel } from './debt-sublabels';`. Replace the External Debt KpiStat's sublabel line with:

```tsx
          sublabel={externalDebtSublabel(d, loans.filter((l) => l.direction === 'borrower' && !isAffiliateBorrowerLoan(l)).length)}
```

In `MaturitiesView`'s Capital Composition `BarList`, replace the `items={[ … ]}` array with:

```tsx
            items={[
              { label: 'External — we pay', value: d.externalDebt, display: fmtUsdCompact(d.externalDebt) },
              ...(d.affiliateDebt > 0
                ? [{ label: 'Affiliate notes — Oxford to Oxford', value: d.affiliateDebt, display: fmtUsdCompact(d.affiliateDebt) }]
                : []),
              { label: 'Internal accrual', value: d.internalOutstanding, display: fmtUsdCompact(d.internalOutstanding) },
              { label: 'Deployed — we receive', value: d.lenderDeployed, display: fmtUsdCompact(d.lenderDeployed) },
            ]}
```

`d.affiliateDebt > 0` is false for the `tests/unit/debt-tabs.test.tsx` mock, which has no `affiliateDebt`, so that suite is unaffected.
- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/debt-sublabels.test.ts tests/unit/basis-labels.test.ts tests/unit/debt-tabs.test.tsx && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/debt/debt-sublabels.ts src/modules/overview/widgets.tsx src/modules/debt/DebtModule.tsx tests/unit/debt-sublabels.test.ts tests/unit/basis-labels.test.ts
git commit -m "feat(debt): disclose affiliate notes beside Total Debt and External Debt" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Per-property LTV on the investment basis (alerts, Portfolio table, drawer, AI)

**Files:**
- Modify: `src/analytics/conditions.ts:1-8` (import), `:369-386` (LTV block of the governor loop)
- Modify: `src/modules/portfolio/PortfolioModule.tsx:5,38`, `src/brain/EntityDrawer.tsx:7-15,300-301`, `server/ai/tools.ts:10,236-244` (`get_property`)
- Test: `tests/unit/conditions.test.ts` (append a describe), `tests/unit/ai-debt-basis.test.ts` (create; Task 7 extends it)

**Interfaces:**
- Consumes: `investmentLtv`, `propertyLtvLabel`, `isAffiliateNoteProperty` (Task 1).
- Produces: unchanged insight ids. `ltv-<id>` and `ltv-governor-<id>` never fire for a property whose only debt is an affiliate note.

- [ ] **Step 1: Reader check.** Run: `git grep -n "\.ltv\b" -- src server ":!src/contracts"`. Expected: the readers in the Pre-flight table plus loan-level `l.ltv` / `ln.ltv` / warehouse `debt_positions.ltv` hits. Loan-level hits are out of scope: they are Loan-Index LTVs, not property rows. Any other *property* `.ltv` reader is a stop.
- [ ] **Step 2: Write the failing tests.** Append to `tests/unit/conditions.test.ts`:

```ts
describe('evaluateConditions — affiliate notes are outside per-property LTV (ratified 2026-09-24)', () => {
  it('an Oxford-affiliate note (live 1100 Rarig shape) fires neither ltv-governor nor ltv', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', name: '1100 Rarig', lender: 'Oxford Capital', loanBalance: 1_111_111, ltv: 0.4444444 })] }), opts);
    expect(out.some((i) => i.id === 'ltv-governor-p1' || i.id === 'ltv-p1')).toBe(false);
  });
  it('an affiliate note at 70% LTV does not fire the 65% ceiling warning either', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', lender: 'Oxford Capital', loanBalance: 700_000, ltv: 0.7 })] }), opts);
    expect(out.some((i) => i.id === 'ltv-p1')).toBe(false);
  });
  it('the same LTV on a third-party loan still fires the info governor insight (id unchanged)', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', name: '1100 Rarig', lender: 'Lender 08', loanBalance: 1_111_111, ltv: 0.4444444 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-governor-p1')?.severity).toBe('info');
  });
});
```

Create `tests/unit/ai-debt-basis.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runTool } from '../../server/ai/tools';

const prop = (o: Record<string, unknown>) => ({
  id: 'p', index: 1, name: 'P', address: 'a', city: null, state: null, market: 'Columbus OH', type: 'Flex', sf: 1000,
  tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 2_000_000, grossIncome: 0,
  expenses: 0, noi: 100_000, noiScenarioAdj: 100_000, debtService: 0, netCashFlow: 0, capRate: 0.05, dscr: null,
  lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null,
  holdYrs: null, encumbered: false, flags: [], ...o,
});

function aiSnap(over: Record<string, unknown> = {}): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-09-13', generatedAt: '2026-09-14T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-09-13' },
    properties: [
      prop({ id: 'rarig', name: '1100 Rarig Ave, Columbus OH', lender: 'Oxford Capital', loanBalance: 1_111_111, ltv: 0.4444, oxfordValue: 2_500_000 }),
      prop({ id: 'easton', name: '29000 Information Lane, Easton MD', lender: 'Firm 03', loanBalance: 2_456_789.12, ltv: 0.39, oxfordValue: 6_300_000 }),
    ],
    leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    cash: { asOf: '2026-09-13', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    ...over,
  } as unknown as PortfolioSnapshot;
}

describe('get_property — per-property LTV on the investment basis', () => {
  it('an affiliate-note property reports "affiliate note", not 44.4%', () => {
    const rows = runTool('get_property', aiSnap(), { query: 'rarig' }).data as Array<{ ltv: string; affiliateNote: boolean }>;
    expect(rows[0]).toMatchObject({ ltv: 'affiliate note', affiliateNote: true });
  });
  it('a third-party-debt property reports its LTV', () => {
    const rows = runTool('get_property', aiSnap(), { query: 'easton' }).data as Array<{ ltv: string; affiliateNote: boolean }>;
    expect(rows[0]).toMatchObject({ ltv: '39.0%', affiliateNote: false });
  });
});
```

Task 7 appends more `describe` blocks to this same file that reuse `aiSnap`.
- [ ] **Step 3: Run them and confirm they fail.** Run: `npx vitest run tests/unit/conditions.test.ts tests/unit/ai-debt-basis.test.ts`. Expected: FAIL. `ltv-governor-p1` fires for Oxford Capital, and `ltv` is `'44.4%'`.
- [ ] **Step 4: Implement.** In `conditions.ts`, add `import { investmentLtv } from './debt-basis';` after line 7. Replace the LTV half of the governor loop (from `if (p.ltv !== null && p.ltv > T.ltvCeiling) {` through the closing `}` of the `else if` block) with:

```ts
    // Ratified 2026-09-24: per-property LTV is on the investment basis — a property whose only
    // debt is an Oxford-affiliate note (src/analytics/debt-basis.ts) has no third-party LTV, so
    // neither the 65% ceiling nor the 40% governor-deviation signal applies. Governor constants are
    // unchanged; ids unchanged.
    const ltv = investmentLtv(p);
    if (ltv !== null && ltv > T.ltvCeiling) {
      out.push({
        id: `ltv-${p.id}`, severity: 'warning', category: 'debt',
        title: `LTV above 65% — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(ltv)} (above the ${fmtPct(T.ltvCeiling)} ceiling).`,
        metric: fmtPct(ltv), entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    } else if (ltv !== null && ltv > gov.ltvCeiling) {
      // B3 Option B: above the ratified LTV governor but within the operational ceiling —
      // an info-level signal so a governor deviation is visible without warning-noise on every levered property.
      out.push({
        id: `ltv-governor-${p.id}`, severity: 'info', category: 'debt',
        title: `Property LTV above aggregate governor — ${p.name}`,
        detail: `Loan-to-value is ${fmtPct(ltv)}. The ${fmtPct(gov.ltvCeiling)} governor applies to the portfolio aggregate; this property is within the ${fmtPct(T.ltvCeiling)} per-property ceiling. Informational.`,
        metric: fmtPct(ltv), entityType: 'property', entityId: p.id,
        impactAnnualUsd: null, spine: 'B', provenance: 'absent',
      });
    }
```

In `PortfolioModule.tsx`, import `propertyLtvLabel, investmentLtv` from `'@analytics/index'` by extending line 5. Replace the `ltv` column (line 38) with:

```tsx
    { key: 'ltv', header: 'LTV', align: 'right', render: (p) => propertyLtvLabel(p), sortValue: (p) => investmentLtv(p) ?? 0 },
```

In `EntityDrawer.tsx`, add `propertyLtvLabel` and `isAffiliateNoteProperty` to the `@analytics/index` import (lines 7-15). Replace the two rows at `:300-301` with:

```tsx
          { label: 'LTV', value: propertyLtvLabel(p) },
          { label: 'Lender', value: p.lender ? `${p.lender}${isAffiliateNoteProperty(p) ? ' (affiliate note — excluded from Total Debt)' : ''}` : '—' },
```

In `server/ai/tools.ts`, add `import { isAffiliateNoteProperty, propertyLtvLabel } from '../../src/analytics/debt-basis';` after line 10. In `get_property`, replace `dscr: p.dscr, ltv: fmtPct(p.ltv),` with:

```ts
        dscr: p.dscr, ltv: propertyLtvLabel(p), affiliateNote: isAffiliateNoteProperty(p),
```

- [ ] **Step 5: Run the tests.** Run: `npx vitest run tests/unit/conditions.test.ts tests/unit/ai-debt-basis.test.ts tests/unit/lease-forecast-conditions.test.ts && npm run typecheck && npm run lint`. Expected: PASS. The pre-existing `ltv-governor-p1` tests use `lender: null`, so they are unchanged.
- [ ] **Step 6: Refute.** Invoke `refute-financial-change` on `conditions.ts` + `debt-basis.ts` usage with these lenses:
  1. A mixed property carrying an affiliate note *plus* third-party debt on one row. That is not representable, because a Property NOI row has one `lender`. Confirm and document that.
  2. A scenario `applyScenario` → `ltv` recompute path.
  3. The brief critical/warning set: the ltv alerts are warning/info, so no email change.
  4. Ids unchanged.

  Record the id.
- [ ] **Step 7: Commit.**

```bash
git add src/analytics/conditions.ts src/modules/portfolio/PortfolioModule.tsx src/brain/EntityDrawer.tsx server/ai/tools.ts tests/unit/conditions.test.ts tests/unit/ai-debt-basis.test.ts
git commit -m "feat(debt): per-property LTV on the investment basis — affiliate notes excluded (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: `checkDebtBasis` — per-row comparison, affiliate notes excluded (items 14 + 1)

**Files:**
- Modify: `server/reconcile-runtime.ts:1-3` (imports), `:155-194` (constant doc + `checkDebtBasis`)
- Modify: `tests/unit/reconcile-runtime.test.ts:413-516` (replace the two `checkDebtBasis` describe blocks and their leading comment through end of file)

**Interfaces:**
- Consumes: `investmentLoanBalance`, `isAffiliateBorrowerLoan`, `DEBT_BASIS_FIELD` (Task 1). `buildLoanPropertyMap(loans, properties, validPropertyIds)` from `server/warehouse/property-crosswalk.ts:106` (existing, pure). It resolves `Loan.collateralProperty` by exact normalized name, then slug, then alias.
- Produces: `checkDebtBasis(s: Pick<PortfolioSnapshot, 'properties' | 'loans'>): DataQualityFlag[]`, with the same signature. It emits one flag per unmatched row: `field` = `debt.basis.property.<propertyId>` or `debt.basis.loan.<loanId>`, `entity: 'debt'`, `severity: 'warn'`. It no longer emits a single net `debt.basis` flag. `isDebtBasisFlag` (Task 1) matches both shapes.

**Rules:**
- Property side = `investmentLoanBalance(p)` over `isInvestmentProperty` rows.
- Loan side = third-party borrower loans (`direction === 'borrower' && !isAffiliateBorrowerLoan`), resolved to a property via `buildLoanPropertyMap` against **all** property rows. A loan resolved to a non-investment row (the residence) is other-holdings debt and is compared on neither side.
- Tolerance is $1,000 per row. Integer cents are rounded per loan before summing, which keeps the check order-independent.

- [ ] **Step 1: Write the failing tests.** Replace `tests/unit/reconcile-runtime.test.ts` from line 413 (the `// 2026-09-23 review: Overview "Total Debt"…` comment) through the end of the file (line 516) with:

```ts
// 2026-09-23 review: Overview "Total Debt" (property loan balances) and Capital › Debt "External Debt"
// (loan schedule) disagreed by the affiliate notes. Round 2 (2026-09-24): affiliate notes are excluded on BOTH
// sides (src/analytics/debt-basis.ts) and the check lists each unmatched row instead of one net gap.
// Warn-only, entity 'debt': never picks a winner, never alters a total, never fires reconcile-fail.
type P = { id: string; name: string; type?: string; lender?: string | null; loanBalance: number };
type L = { id: string; name: string; direction: string; absBalance: number; lender?: string | null; counterparty?: string | null; collateralProperty?: string | null };
const debtSnap = (properties: P[], loans: L[]) => ({ properties, loans }) as never;

// Live shape (data/snapshots/portfolio.json, asOf 2026-09-13), trimmed to the rows that matter.
const EASTON: P = { id: 'p-easton', name: '29000 Information Lane, Easton MD', type: 'Flex', lender: 'Firm 03', loanBalance: 2_456_789.12 };
const RARIG: P = { id: 'p-rarig', name: '1100 Rarig Ave, Columbus OH', type: 'Flex', lender: 'Oxford Capital', loanBalance: 1_111_111 };
const LIVINGSTON: P = { id: 'p-liv', name: '3875-3883 E Livingston Ave, Columbus OH', type: 'Flex', lender: null, loanBalance: 0 };
const RESIDENCE: P = { id: 'p-res', name: '9510 Persimmon Tree Rd, Potomac MD', type: 'Residence', lender: null, loanBalance: 0 };
const EASTON_LOAN: L = { id: 'b-easton', name: '29000 Information Lane', direction: 'borrower', absBalance: 2_456_789.12, lender: 'Oxford / Lender 03', counterparty: 'Oxford / Lender 03', collateralProperty: '29000 Information Lane, Easton MD' };
const LOAN_3883: L = { id: 'b-3883', name: '3883 from Oxford (50%)', direction: 'borrower', absBalance: 333_333, lender: 'Lender 05 / Oxford Capital — Oxford 50% share', counterparty: 'Lender 05 / Oxford Capital — Oxford 50% share', collateralProperty: '3875-3883 E Livingston Ave, Columbus OH' };
const RARIG_NOTE: L = { id: 'n-rarig', name: 'Note Party 01', direction: 'lender', absBalance: 555_555, lender: null, counterparty: 'Firm 04 (Oxford Capital) — Oxford 50% share', collateralProperty: null };

describe('checkDebtBasis — per-row, affiliate notes excluded on both sides (2026-09-24)', () => {
  it('the live shape reconciles: Rarig (affiliate property row) and 3883 (affiliate borrower loan) drop out → no flags', () => {
    expect(checkDebtBasis(debtSnap([EASTON, RARIG, LIVINGSTON, RESIDENCE], [EASTON_LOAN, LOAN_3883, RARIG_NOTE]))).toEqual([]);
  });

  it('a property row that disagrees with its attributed loan is listed by name with both figures and the gap', () => {
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_800_000 }], [EASTON_LOAN]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ entity: 'debt', field: 'debt.basis.property.p-easton', severity: 'warn' });
    expect(flags[0]!.issue).toBe(
      '29000 Information Lane, Easton MD: Property NOI sheet loan balance $2,800,000 vs loan schedule $2,456,789 (29000 Information Lane) — gap $343,211',
    );
  });

  it('a property row with a balance but no attributed loan is listed', () => {
    const flags = checkDebtBasis(debtSnap([{ id: 'p-a', name: 'Alpha Flex', type: 'Flex', lender: 'Lender 08', loanBalance: 1_000_000 }], []));
    expect(flags.map((f) => f.field)).toEqual(['debt.basis.property.p-a']);
    expect(flags[0]!.issue).toContain('(no third-party loan attributed)');
    expect(flags[0]!.issue).toContain('gap $1,000,000');
  });

  it('a third-party loan whose collateral resolves to no property row is listed as unattributed', () => {
    const flags = checkDebtBasis(debtSnap([], [{ id: 'b-x', name: 'Mystery Note', direction: 'borrower', absBalance: 500_000, lender: 'Bank X', counterparty: 'Bank X', collateralProperty: null }]));
    expect(flags).toEqual([{
      entity: 'debt', field: 'debt.basis.loan.b-x', severity: 'warn',
      issue: 'Mystery Note: $500,000 on the loan schedule is not attributed to any property row (collateral blank)',
    }]);
  });

  it('two loans on one property are summed and named together', () => {
    const second: L = { ...EASTON_LOAN, id: 'b-easton-2', name: 'Easton Second', absBalance: 100_000 };
    const flags = checkDebtBasis(debtSnap([EASTON], [EASTON_LOAN, second]));
    expect(flags[0]!.issue).toContain('(29000 Information Lane, Easton Second)');
    expect(flags[0]!.issue).toContain('gap $100,000');
  });

  it('per-row tolerance is strictly > $1,000 (either sign)', () => {
    const at = (bal: number) => checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: bal }], [{ ...EASTON_LOAN, absBalance: 100_000 }]));
    expect(at(101_000)).toEqual([]);
    expect(at(101_001)).toHaveLength(1);
    expect(at(98_999)).toHaveLength(1);
  });

  it('is order-independent at the exact $1,000.00 boundary (integer cents per loan; refute wf_fb49dbb9-c91)', () => {
    const a: L = { ...EASTON_LOAN, id: 'a', name: 'A', absBalance: 0.1 };
    const b: L = { ...EASTON_LOAN, id: 'b', name: 'B', absBalance: 0.2 };
    const prop = { ...EASTON, loanBalance: 1000.3 };
    expect(checkDebtBasis(debtSnap([prop], [a, b]))).toEqual([]);
    expect(checkDebtBasis(debtSnap([prop], [b, a]))).toEqual([]);
  });

  it('a loan collateralised by the residence is other-holdings debt: compared on neither side', () => {
    const resLoan: L = { id: 'b-res', name: 'Persimmon mortgage', direction: 'borrower', absBalance: 900_000, lender: 'Wells', counterparty: 'Wells', collateralProperty: '9510 Persimmon Tree Rd, Potomac MD' };
    expect(checkDebtBasis(debtSnap([{ ...RESIDENCE, loanBalance: 900_000 }], [resLoan]))).toEqual([]);
  });

  it('lender and internal directions never count on the loan side', () => {
    const internal: L = { id: 'i', name: 'Internal', direction: 'internal', absBalance: 2_900_000, counterparty: 'Firm 08' };
    expect(checkDebtBasis(debtSnap([EASTON], [EASTON_LOAN, RARIG_NOTE, internal]))).toEqual([]);
  });

  it('tolerates missing arrays (legacy fixture)', () => {
    expect(checkDebtBasis({ properties: undefined, loans: undefined } as never)).toEqual([]);
  });

  it('is NOT a reconciliation-entity flag and does NOT fire the CRITICAL "reconcile-fail" insight (PR-1 lesson)', () => {
    const flags = checkDebtBasis(debtSnap([{ ...EASTON, loanBalance: 2_800_000 }], [EASTON_LOAN]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.entity).toBe('debt');
    const asOf = '2026-09-24';
    const snap = {
      meta: { schemaVersion: '1.0.0', asOf, generatedAt: '2026-09-24T00:00:00.000Z', source: 't', scenario: 'Base' },
      assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf },
      properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
      renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null,
      cash: { asOf, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
      dataQuality: flags,
    } as unknown as PortfolioSnapshot;
    const insights = evaluateConditions(snap, { now: Date.parse('2026-09-24T12:00:00.000Z') });
    expect(insights.some((i) => i.id === 'reconcile-fail')).toBe(false);
    expect(insights.some((i) => i.severity === 'critical')).toBe(false);
  });

  it('is wired into checkSnapshot and stays warn there', () => {
    const flags = checkSnapshot(base({
      properties: [{ id: 'p1', name: 'Alpha Flex', type: 'Flex', lender: 'Lender 08', loanBalance: 11_300_000 }],
      loans: [{ id: 'n1', name: 'Alpha Loan', direction: 'borrower', absBalance: 10_600_000, lender: 'Lender 08', counterparty: 'Lender 08', collateralProperty: 'Alpha Flex' }],
    }));
    const f = flags.find((x) => x.field === 'debt.basis.property.p1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warn');
    expect(f!.issue).toContain('gap $700,000');
    expect(flags.some((x) => x.severity === 'error')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/reconcile-runtime.test.ts`. Expected: FAIL. The live-shape case yields one `debt.basis` net flag, and the per-row field names don't exist yet.
- [ ] **Step 3: Implement.** In `server/reconcile-runtime.ts`, add after line 3:

```ts
import { DEBT_BASIS_FIELD, investmentLoanBalance, isAffiliateBorrowerLoan } from '../src/analytics/debt-basis';
import { buildLoanPropertyMap } from './warehouse/property-crosswalk';
```

Replace everything from the `// Absolute-dollar tolerance for the debt-basis cross-check below.` comment (line 155) through the closing `}` of `checkDebtBasis` (line 194) with:

```ts
// Absolute-dollar tolerance PER ROW for the debt-basis cross-check below. Two independently-typed
// workbook figures for the same loan can differ by a few dollars of accrual timing; anything past
// this is a share-basis difference or a loan present in one source and not the other.
const DEBT_BASIS_TOLERANCE = 1000;

/**
 * Overview "Total Debt" (property loan balances, Property NOI sheet) vs Capital › Debt "External
 * Debt" (third-party borrower loans, loan schedule), compared ROW BY ROW (item 14, 2026-09-24) so
 * the Data Quality card names the property or loan that disagrees instead of one unexplained net
 * gap (round 1 showed a single net figure with no row to fix).
 *
 * Same basis as both surfaces, by construction:
 *  - investment rows only (the residence is other holdings — isInvestmentProperty);
 *  - Oxford-affiliate notes excluded on BOTH sides (src/analytics/debt-basis.ts — ratified
 *    2026-09-24): a property row whose lender is an affiliate contributes 0, an affiliate
 *    borrower loan is skipped; a loan collateralised by a non-investment row is other-holdings debt
 *    and is compared on neither side.
 * Loans are attributed with the SAME resolver the warehouse snapshot writer uses
 * (buildLoanPropertyMap: exact normalized name → slug → alias; ambiguous/blank = unresolved, never
 * guessed). Integer cents per loan so the $1,000 boundary is order-independent (refute
 * wf_fb49dbb9-c91).
 *
 * entity is 'debt', deliberately NOT 'reconciliation' — see checkStaleLeaseRows: an
 * entity==='reconciliation' flag is a reconciliation failure. These are warn-level basis notes; the
 * Health Reconciliation card lists them via isDebtBasisFlag (src/modules/health/reconciliation-card.ts).
 */
export function checkDebtBasis(s: Pick<PortfolioSnapshot, 'properties' | 'loans'>): DataQualityFlag[] {
  const allProps = s.properties ?? [];
  const investment = allProps.filter(isInvestmentProperty);
  const investmentIds = new Set(investment.map((p) => p.id));
  const thirdParty = (s.loans ?? []).filter((l) => l.direction === 'borrower' && !isAffiliateBorrowerLoan(l));
  const { map, unresolved } = buildLoanPropertyMap(thirdParty, allProps, new Set(allProps.map((p) => p.id)));

  const cents = (n: number): number => Math.round(n * 100);
  const tol = DEBT_BASIS_TOLERANCE * 100;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`; // pinned: CI's ICU default may not group

  const loanCents = new Map<string, number>();
  const loanNames = new Map<string, string[]>();
  for (const l of thirdParty) {
    const pid = map.get(l.id);
    if (pid === undefined || !investmentIds.has(pid)) continue; // unresolved (below) or other-holdings collateral
    loanCents.set(pid, (loanCents.get(pid) ?? 0) + cents(l.absBalance ?? 0));
    loanNames.set(pid, [...(loanNames.get(pid) ?? []), l.name]);
  }

  const flags: DataQualityFlag[] = [];
  for (const p of investment) {
    const propCents = cents(investmentLoanBalance(p));
    const schedCents = loanCents.get(p.id) ?? 0;
    const gap = propCents - schedCents;
    if (Math.abs(gap) <= tol) continue;
    const names = loanNames.get(p.id);
    flags.push({
      entity: 'debt',
      field: `${DEBT_BASIS_FIELD}.property.${p.id}`,
      issue:
        `${p.name}: Property NOI sheet loan balance ${usd(propCents / 100)} vs loan schedule ${usd(schedCents / 100)} ` +
        `${names ? `(${names.join(', ')})` : '(no third-party loan attributed)'} — gap ${usd(Math.abs(gap) / 100)}`,
      severity: 'warn',
    });
  }
  const byId = new Map(thirdParty.map((l) => [l.id, l]));
  for (const id of unresolved) {
    const l = byId.get(id);
    if (!l || cents(l.absBalance ?? 0) <= tol) continue;
    flags.push({
      entity: 'debt',
      field: `${DEBT_BASIS_FIELD}.loan.${l.id}`,
      issue: `${l.name}: ${usd(l.absBalance)} on the loan schedule is not attributed to any property row (collateral ${l.collateralProperty ? `"${l.collateralProperty}"` : 'blank'})`,
      severity: 'warn',
    });
  }
  return flags;
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/reconcile-runtime.test.ts tests/unit/debt-basis.test.ts && npm run reconcile:snapshot && npm run typecheck`. Expected: PASS. `reconcile:snapshot` fails only on errors, and these flags are warn.
- [ ] **Step 5: Live cross-check.** Create `.superpowers/live-check-basis.ts`:

```ts
import { readFileSync } from 'node:fs';
import { checkDebtBasis } from '../server/reconcile-runtime';
import type { PortfolioSnapshot } from '../src/contracts/index';

const s = JSON.parse(readFileSync('data/snapshots/portfolio.json', 'utf8')) as PortfolioSnapshot;
console.log(JSON.stringify(checkDebtBasis(s), null, 2));
```

Run: `npx tsx .superpowers/live-check-basis.ts`. Expected: `[]`. Before this task, the code produced one flag carrying a single net gap. Paste the result in the PR body, then `rm .superpowers/live-check-basis.ts`.
- [ ] **Step 6: Refute.** Invoke `refute-financial-change` on `server/reconcile-runtime.ts` with these lenses:
  1. Attribution. A mis-resolved collateral name must surface as "unattributed", never as a silent match. Confirm `buildLoanPropertyMap`'s ambiguous → unresolved behavior carries through.
  2. The flags are warn-only and entity `'debt'`. No total is altered.
  3. The live snapshot yields `[]` only because the rows tie to the cent, not because a filter hid a real row.
  4. The per-row tolerance cannot mask a material net gap spread across many sub-$1,000 rows. There are 4 third-party loans today. Document the bound: worst case 4 × $1,000.

  Record the id.
- [ ] **Step 7: Commit.**

```bash
git add server/reconcile-runtime.ts tests/unit/reconcile-runtime.test.ts
git commit -m "feat(reconcile): per-row debt-basis comparison, affiliate notes excluded on both sides" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Health › Reconciliation card — never "Consistent" beside a debt-basis flag (item 13a)

**Files:**
- Create: `src/modules/health/reconciliation-card.ts`
- Modify: `src/modules/health/HealthModule.tsx:1-9` (import), `:48` (`recon`), `:75-84` (card)
- Test: `tests/unit/health-reconciliation-card.test.tsx`

**Interfaces:**
- Consumes: `isDebtBasisFlag` (Task 1).
- Produces: `reconciliationCardState(flags: readonly DataQualityFlag[]): { badgeTone: 'green' | 'amber' | 'red'; badgeLabel: string; rows: DataQualityFlag[] }`.

- [ ] **Step 1: Write the failing test.** Create `tests/unit/health-reconciliation-card.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DataQualityFlag } from '../../src/contracts/index';
import { reconciliationCardState } from '../../src/modules/health/reconciliation-card';

const snap: { data: unknown } = { data: undefined };
vi.mock('../../src/data/queries', () => ({ useSnapshot: () => snap }));
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ state: null }) }));

import { HealthModule } from '../../src/modules/health/HealthModule';

const basis: DataQualityFlag = { entity: 'debt', field: 'debt.basis.property.p1', issue: 'Alpha: gap $343,211', severity: 'warn' };
const reconWarn: DataQualityFlag = { entity: 'reconciliation', field: 'cash.history.date', issue: 'missing rows', severity: 'warn' };
const reconError: DataQualityFlag = { entity: 'reconciliation', field: 'properties.noi', issue: 'Σ NOI ≠ workbook', severity: 'error' };
const other: DataQualityFlag = { entity: 'lease', field: 'lease.l1.leaseEnd', issue: 'stale', severity: 'warn' };

describe('reconciliationCardState', () => {
  it('green "Consistent" only when there is neither a reconciliation nor a debt-basis flag', () => {
    expect(reconciliationCardState([other])).toEqual({ badgeTone: 'green', badgeLabel: 'Consistent', rows: [] });
  });
  it('a debt-basis flag alone is amber and never "Consistent"', () => {
    expect(reconciliationCardState([basis])).toEqual({ badgeTone: 'amber', badgeLabel: '1 debt basis gap', rows: [basis] });
  });
  it('warn-only reconciliation rows are amber, not red (item 8 on this card)', () => {
    expect(reconciliationCardState([reconWarn, basis])).toMatchObject({ badgeTone: 'amber', badgeLabel: '2 warnings' });
  });
  it('any error-severity reconciliation flag is red', () => {
    expect(reconciliationCardState([reconError, basis])).toMatchObject({ badgeTone: 'red', badgeLabel: '2 issues', rows: [reconError, basis] });
  });
});

describe('HealthModule Reconciliation card', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('shows the debt-basis row and no "Consistent" badge', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    snap.data = { snapshot: { dataQuality: [basis] } };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><HealthModule /></QueryClientProvider>);
    expect(screen.queryByText('Consistent')).toBeNull();
    expect(screen.getByText('1 debt basis gap')).toBeTruthy();
    expect(screen.getAllByText('Alpha: gap $343,211').length).toBeGreaterThan(0); // Reconciliation + Data Quality cards
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/health-reconciliation-card.test.tsx`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Create `src/modules/health/reconciliation-card.ts`:

```ts
// src/modules/health/reconciliation-card.ts
//
// System Health › Reconciliation card state (item 13, 2026-09-24). Round 1 put the Overview-vs-
// Capital debt-basis flag on entity 'debt' (so it would not fire the CRITICAL reconcile-fail
// insight); this card only listed entity==='reconciliation' flags, so it read "Consistent" beside a
// live affiliate-note basis gap. It now lists reconciliation flags AND debt-basis flags and colours by
// severity: red only for an error, amber for warn-only rows, green only when both lists are empty.
import { isDebtBasisFlag } from '@analytics/index';
import type { DataQualityFlag } from '@contracts/index';

export interface ReconciliationCardState {
  badgeTone: 'green' | 'amber' | 'red';
  badgeLabel: string;
  rows: DataQualityFlag[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function reconciliationCardState(flags: readonly DataQualityFlag[]): ReconciliationCardState {
  const recon = flags.filter((f) => f.entity === 'reconciliation');
  const basis = flags.filter(isDebtBasisFlag);
  const rows = [...recon, ...basis];
  if (rows.length === 0) return { badgeTone: 'green', badgeLabel: 'Consistent', rows };
  if (rows.some((f) => f.severity === 'error')) return { badgeTone: 'red', badgeLabel: plural(rows.length, 'issue'), rows };
  if (recon.length === 0) return { badgeTone: 'amber', badgeLabel: plural(basis.length, 'debt basis gap'), rows };
  return { badgeTone: 'amber', badgeLabel: plural(rows.length, 'warning'), rows };
}
```

In `HealthModule.tsx`, add `import { reconciliationCardState } from './reconciliation-card';` to the imports. Replace line 48 (`const recon = flags.filter((x) => x.entity === 'reconciliation');`) with:

```tsx
  const recon = reconciliationCardState(flags);
```

Replace the Reconciliation `<Card>` (lines 75-84) with:

```tsx
        <Card>
          <CardHeader title="Reconciliation" trailing={<Badge tone={recon.badgeTone}>{recon.badgeLabel}</Badge>} />
          <ul className="flex flex-col">
            {recon.rows.length === 0 ? (
              <Row tone="ok" label="Internal invariants" value="All checks pass" />
            ) : (
              recon.rows.map((r, i) => <Row key={i} tone={r.severity === 'error' ? 'error' : 'warn'} label={r.field} value={r.issue} />)
            )}
          </ul>
        </Card>
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/health-reconciliation-card.test.tsx tests/unit/health-module.test.tsx && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/health/reconciliation-card.ts src/modules/health/HealthModule.tsx tests/unit/health-reconciliation-card.test.tsx
git commit -m "fix(health): Reconciliation card lists debt-basis flags and colours by severity" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: AI answers — one basis per debt figure, basis gap disclosed (item 13b)

**Files:**
- Create: `server/ai/debt-basis-copy.ts`
- Modify: `server/ai/respond.ts:1-5` (imports), `:35-41` (balloon branch rate line), `:54-57` (debt branch), `:66` (summary bullet)
- Modify: `server/ai/tools.ts` `get_portfolio_summary` (`:194-230`) and `get_loans` (`:269-288`)
- Modify: `server/ai/agent.ts:79-87` (`SYSTEM`)
- Test: `tests/unit/ai-debt-basis.test.ts` (append), `tests/unit/ai-respond.test.ts` (append)

**Interfaces:**
- Consumes: `isDebtBasisFlag` (Task 1). `PortfolioKpis.affiliateDebt` and `DebtSummary.affiliateDebt` (Task 2).
- Produces: `TOTAL_DEBT_BASIS`, `EXTERNAL_DEBT_BASIS` (string constants), `debtBasisIssues(flags): string[]`, `externalDebtSentence(d: DebtSummary): string`, `portfolioLtvSentence(k: PortfolioKpis): string` and `debtBasisNote(flags): string | null`.

- [ ] **Step 1: Write the failing tests.** In `tests/unit/ai-debt-basis.test.ts`, add `import { respond } from '../../server/ai/respond';` to the import block at the top of the file. Then append:

```ts
const basisFlag = { entity: 'debt', field: 'debt.basis.property.easton', issue: '29000 Information Lane, Easton MD: … gap $343,211', severity: 'warn' };
const loans = [
  { id: 'b-easton', name: '29000 Information Lane', counterparty: 'Firm 03', direction: 'borrower', absBalance: 2_456_789.12, currentBalance: -2_456_789.12, rate: 0.045, monthlyPmt: 15_000, lender: 'Firm 03', maturity: '2031-01-01', balloon: false, isDemand: false, collateralProperty: '29000 Information Lane, Easton MD' },
  { id: 'b-3883', name: '3883 from Oxford (50%)', counterparty: 'Lender 05 / Oxford Capital — Oxford 50% share', direction: 'borrower', absBalance: 333_333, currentBalance: -333_333, rate: 0.06, monthlyPmt: 3_333, lender: 'Lender 05 / Oxford Capital — Oxford 50% share', maturity: '2035-06-01', balloon: false, isDemand: false, collateralProperty: '3875-3883 E Livingston Ave, Columbus OH' },
];

describe('AI tools — each debt figure carries its basis; the gap is surfaced (item 13)', () => {
  it('get_portfolio_summary states the Total Debt basis, the excluded affiliate notes and any basis flags', () => {
    const d = runTool('get_portfolio_summary', aiSnap({ dataQuality: [basisFlag] }), {}).data as Record<string, unknown>;
    expect(d.totalDebtBasis).toBe('Σ investment-property loan balances (Property NOI sheet); Oxford-affiliate notes excluded');
    expect(d.affiliateNotesExcluded).toBe('$1.11M');
    expect(d.debtBasisFlags).toEqual([basisFlag.issue]);
  });
  it('get_loans states the External Debt basis and the excluded affiliate note', () => {
    const d = runTool('get_loans', aiSnap({ loans }), {}).data as Record<string, unknown>;
    expect(d.externalDebt).toBe('$2.46M');
    expect(d.externalDebtBasis).toBe('Σ third-party borrower loans (loan schedule); Oxford-affiliate notes excluded');
    expect(d.affiliateNotesExcluded).toBe('$333K');
    expect(d).not.toHaveProperty('debtBasisFlags'); // none on this snapshot
  });
});

describe('respond (deterministic) — never two debt bases in one sentence (item 13)', () => {
  it('the debt answer puts External Debt and LTV in separate sentences, each with its basis, plus the basis note', () => {
    const r = respond('what is our debt and ltv?', aiSnap({ loans, dataQuality: [basisFlag] }));
    const lines = r.answer.split('\n');
    const ext = lines.find((l) => l.startsWith('External debt'))!;
    const ltv = lines.find((l) => l.startsWith('Portfolio LTV'))!;
    expect(ext).toContain('(loan schedule, third-party borrower loans)');
    expect(ext).toContain('Oxford-affiliate notes of $333K are excluded');
    expect(ext).not.toContain('LTV');
    expect(ltv).toContain('property loan balances');
    expect(ltv).not.toContain('External');
    expect(lines).toContain('Basis note: the loan schedule and the property loan balances disagree on 1 row — see System Health › Reconciliation.');
  });
  it('no basis note when there is no debt-basis flag', () => {
    expect(respond('debt?', aiSnap({ loans })).answer).not.toContain('Basis note');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/ai-debt-basis.test.ts`. Expected: FAIL. `totalDebtBasis` is undefined, and the answer's line reads `External debt … Portfolio LTV …` in one sentence.
- [ ] **Step 3: Implement.** Create `server/ai/debt-basis-copy.ts`:

```ts
// server/ai/debt-basis-copy.ts
//
// AI copy for the two debt headlines (item 13, 2026-09-24). Overview Total Debt / LTV are PROPERTY
// LOAN BALANCES (Property NOI sheet); Capital › Debt External Debt is the LOAN SCHEDULE (third-party
// borrower loans). Both exclude Oxford-affiliate notes (src/analytics/debt-basis.ts). One basis per
// sentence, and any live debt-basis data-quality flag is surfaced rather than papered over.
import type { DataQualityFlag } from '../../src/contracts/index';
import type { DebtSummary, PortfolioKpis } from '../../src/analytics/types';
import { isDebtBasisFlag } from '../../src/analytics/debt-basis';
import { fmtPct, fmtUsdCompact } from '../../src/analytics/format';

export const TOTAL_DEBT_BASIS = 'Σ investment-property loan balances (Property NOI sheet); Oxford-affiliate notes excluded';
export const EXTERNAL_DEBT_BASIS = 'Σ third-party borrower loans (loan schedule); Oxford-affiliate notes excluded';

export function debtBasisIssues(flags: readonly DataQualityFlag[]): string[] {
  return flags.filter(isDebtBasisFlag).map((f) => f.issue);
}

export function externalDebtSentence(d: DebtSummary): string {
  const rate = d.weightedAvgRate !== null ? fmtPct(d.weightedAvgRate, 2) : '—';
  const aff = d.affiliateDebt > 0 ? ` Oxford-affiliate notes of ${fmtUsdCompact(d.affiliateDebt)} are excluded.` : '';
  return `External debt ${fmtUsdCompact(d.externalDebt)} at ${rate} weighted (loan schedule, third-party borrower loans).${aff}`;
}

export function portfolioLtvSentence(k: PortfolioKpis): string {
  const aff = k.affiliateDebt.value ? `; ${fmtUsdCompact(k.affiliateDebt.value)} of affiliate notes excluded` : '';
  return `Portfolio LTV ${fmtPct(k.ltv.value)} (property loan balances ${fmtUsdCompact(k.totalDebt.value)} ÷ investment value${aff}).`;
}

export function debtBasisNote(flags: readonly DataQualityFlag[]): string | null {
  const n = flags.filter(isDebtBasisFlag).length;
  if (n === 0) return null;
  return `Basis note: the loan schedule and the property loan balances disagree on ${n} row${n === 1 ? '' : 's'} — see System Health › Reconciliation.`;
}
```

In `respond.ts`, add after line 5:

```ts
import { debtBasisNote, externalDebtSentence, portfolioLtvSentence } from './debt-basis-copy';
```

In the balloon branch, replace `out.push(`Weighted avg borrower rate: …`);` with:

```ts
    out.push(`Weighted avg third-party borrower rate: ${a.debt.weightedAvgRate !== null ? fmtPct(a.debt.weightedAvgRate, 2) : '—'}; annual debt service ${fmtUsdCompact(a.debt.annualDebtService)} (loan schedule).`);
```

Replace the debt branch body (the two `out.push` lines after `sources.add('Loan Index');`) with:

```ts
    sources.add('Property NOI');
    // One basis per sentence (item 13, 2026-09-24): External Debt is the loan schedule; LTV is the
    // property loan balances. They are different sources — never quoted in one sentence.
    out.push(externalDebtSentence(a.debt));
    out.push(portfolioLtvSentence(k));
    const note = debtBasisNote(s.dataQuality ?? []);
    if (note) out.push(note);
    out.push(`Capital deployed as lender: ${fmtUsdCompact(a.debt.lenderDeployed)}; internal accrual ${fmtUsdCompact(a.debt.internalOutstanding)}.`);
```

Replace the summary bullet `out.push(`• Debt ${fmtUsdCompact(k.totalDebt.value)} (LTV ${fmtPct(k.ltv.value)}), cash ${fmtUsdCompact(k.totalCash.value)}, WALT ${fmtYears(k.walt.value)}.`);` with:

```ts
    const aff = k.affiliateDebt.value ? ` · +${fmtUsdCompact(k.affiliateDebt.value)} affiliate notes excluded` : '';
    out.push(`• Debt ${fmtUsdCompact(k.totalDebt.value)} (property loan balances; LTV ${fmtPct(k.ltv.value)})${aff}.`);
    out.push(`• Cash ${fmtUsdCompact(k.totalCash.value)}, WALT ${fmtYears(k.walt.value)}.`);
    const note = debtBasisNote(s.dataQuality ?? []);
    if (note) out.push(`• ${note}`);
```

In `server/ai/tools.ts`, add after the debt-basis import from Task 4:

```ts
import { TOTAL_DEBT_BASIS, EXTERNAL_DEBT_BASIS, debtBasisIssues } from './debt-basis-copy';
```

In `get_portfolio_summary`, after `totalDebt: fmtUsdCompact(k.totalDebt.value),` add:

```ts
        totalDebtBasis: TOTAL_DEBT_BASIS,
        ...(k.affiliateDebt.value ? { affiliateNotesExcluded: fmtUsdCompact(k.affiliateDebt.value) } : {}),
        ...(debtBasisIssues(s.dataQuality ?? []).length ? { debtBasisFlags: debtBasisIssues(s.dataQuality ?? []) } : {}),
```

In `get_loans`, after `externalDebt: fmtUsdCompact(d.externalDebt),` add:

```ts
        externalDebtBasis: EXTERNAL_DEBT_BASIS,
        ...(d.affiliateDebt > 0 ? { affiliateNotesExcluded: fmtUsdCompact(d.affiliateDebt) } : {}),
        ...(debtBasisIssues(s.dataQuality ?? []).length ? { debtBasisFlags: debtBasisIssues(s.dataQuality ?? []) } : {}),
```

In `server/ai/agent.ts` `SYSTEM` array, insert before the `"If the tools do not contain the answer…"` line:

```ts
  'DEBT BASIS: totalDebt/ltv (portfolio summary) are property loan balances; externalDebt (loans) is the loan schedule — different sources. Quote each with its basis and never put both in one sentence. If debtBasisFlags is present, say the two figures disagree and name the rows.',
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/ai-debt-basis.test.ts tests/unit/ai-respond.test.ts tests/unit/ai-agent.test.ts && npm run typecheck && npm run lint`. Expected: PASS. `ai-respond.test.ts:82` still finds `LTV`, and `:99` still finds the value/other-holdings line, which is unchanged.
- [ ] **Step 5: Commit.**

```bash
git add server/ai/debt-basis-copy.ts server/ai/respond.ts server/ai/tools.ts server/ai/agent.ts tests/unit/ai-debt-basis.test.ts
git commit -m "feat(ai): one basis per debt figure; surface debt-basis flags and excluded affiliate notes" -m "Refute-Skip: AI copy/labels only — every figure is an engine output changed and refuted in Tasks 2 and 5; no new financial math" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR A close-out:**
- [ ] `git fetch origin` and rebase onto `origin/main` if it moved. Re-run the Pre-flight reader greps.
- [ ] `npm run gate`. Expected: green (rerun once on 0xC0000005).
- [ ] `npx tsx scripts/check-refute-required.ts`. Expected: PASS.
- [ ] Browser check (`dev:server:once` + `dev:web` per `.claude/launch.json`; delete any copied `.env` afterwards). Overview Total Debt tile, Capital › Debt KPI strip + Maturities › Capital Composition, Portfolio LTV column for 1100 Rarig, System Health › Reconciliation. Light + dark, 1440 px and 375 px. Take screenshots.
- [ ] `git push -u origin fix/cc-review-round2`. Open PR `fix(debt): affiliate notes out of investment debt + per-row debt-basis reconciliation (round 2 · A)`. The body lists files, tests, the live-snapshot table rows for Total Debt / LTV / External Debt / checkDebtBasis, the refute ids, and **Q1** (affiliate list) as a merge blocker.
- [ ] Review. Use the `adversarial-merge-gate` skill, because the PR touches financial and alert code. The reviewer model must be at least as strong as the implementer's.

---

## PR B — Residence, governor loop, alert tiering (items 2, 3, 4, 5, 6, 7, 8)

Branch: `git switch -c fix/cc-r2-b-residence-alerts` from PR A's head. The PR body says `Base branch: fix/cc-review-round2. Merge PR A first.`

### Task 8: Equity Invested discloses other holdings; residence debt disclosed on Total Debt (item 2) (architect-owned: `src/analytics/engine.ts`)

**Files:**
- Modify: `src/analytics/types.ts` (`PortfolioKpis`: two cells after `otherHoldingsCount`)
- Modify: `src/analytics/engine.ts` (`portfolioKpis` return object, after `otherHoldingsCount:`)
- Modify: `src/modules/overview/other-holdings.ts` (two clause helpers)
- Modify: `src/modules/debt/debt-sublabels.ts` (`overviewTotalDebtSublabel` leads with the other-holdings debt clause)
- Modify: `src/modules/overview/widgets.tsx:53` (Equity Invested sublabel)
- Modify: `tests/unit/debt-sublabels.test.ts`, `tests/unit/basis-labels.test.ts` (fixture helpers gain the two cells)
- Test: `tests/unit/portfolio-kpis-residence.test.ts` (append), `tests/unit/overview-kpi-other-holdings.test.tsx` (append)

**Interfaces:**
- Consumes: `overviewTotalDebtSublabel` (Task 3).
- Produces: `PortfolioKpis.otherHoldingsEquity: Cell`, `PortfolioKpis.otherHoldingsDebt: Cell`, `otherHoldingsEquityClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsEquity'>): string` (e.g. `'+$900K other holdings'`) and `otherHoldingsDebtClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsDebt'>): string` (e.g. `'+$X other-holdings debt'`). `overviewTotalDebtSublabel` now takes `Pick<PortfolioKpis, 'ltv' | 'affiliateDebt' | 'otherHoldingsCount' | 'otherHoldingsDebt'>`.

Equity Invested stays investment-only, as ratified. The residence's equity is disclosed with the shared formatter, so it renders as `+$NNNK other holdings` (`fmtUsdCompact` switches to K below $1M). That is the same figure as the memo's. (The tests below use a synthetic 900_000.)

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/portfolio-kpis-residence.test.ts`:

```ts
describe('portfolioKpis — residence equity and debt are other holdings (ratified 2026-09-24)', () => {
  const s = {
    properties: [
      p({ id: 'a', oxfordValue: 10_000_000, equityInvested: 1_000_000, loanBalance: 2_000_000, lender: 'Firm 03' }),
      p({ id: 'res', type: 'Residence', oxfordValue: 2_000_000, equityInvested: 900_000, loanBalance: 400_000, lender: 'Wells' }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-24' },
  } as unknown as PortfolioSnapshot;
  it('equityInvested and totalDebt stay investment-only; the residence is carried as other holdings', () => {
    const k = portfolioKpis(s);
    expect(k.equityInvested.value).toBe(1_000_000);
    expect(k.otherHoldingsEquity.value).toBe(900_000);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.otherHoldingsDebt.value).toBe(400_000);
  });
});
```

Append to `tests/unit/overview-kpi-other-holdings.test.tsx`, inside the existing top-level `describe`:

```tsx
  it('Equity Invested discloses the residence equity as other holdings (ratified 2026-09-24)', () => {
    renderStrip(snapshot([investment, residence]));
    expect(screen.getByText('+$900K other holdings')).toBeTruthy();
  });
```

In `tests/unit/debt-sublabels.test.ts`, replace the `k` helper and add one case:

```ts
const k = (ltv: number, affiliate: number, otherDebt = 0) =>
  ({ ltv: cell(ltv), affiliateDebt: cell(affiliate), otherHoldingsCount: cell(otherDebt ? 1 : 0), otherHoldingsDebt: cell(otherDebt) }) as unknown as PortfolioKpis;
```

```ts
  it('residence debt, when any, is disclosed first', () => {
    expect(overviewTotalDebtSublabel(k(0.2, 1_111_111, 400_000))).toBe('+$400K other-holdings debt · +$1.11M affiliate notes · property loan balances · 20.0% LTV');
  });
```

In `tests/unit/basis-labels.test.ts`, change the Total Debt fixture line to:

```ts
    const k = { ltv: cell(0.2), affiliateDebt: cell(0), otherHoldingsCount: cell(0), otherHoldingsDebt: cell(0) } as unknown as PortfolioKpis;
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/portfolio-kpis-residence.test.ts tests/unit/overview-kpi-other-holdings.test.tsx tests/unit/debt-sublabels.test.ts`. Expected: FAIL (`otherHoldingsEquity` undefined; no `+$900K other holdings` text).
- [ ] **Step 3: Implement.** In `types.ts` `PortfolioKpis`, after `otherHoldingsCount: Cell;` add:

```ts
  /** Residence equity / loan balance — disclosed beside Equity Invested / Total Debt (ratified 2026-09-24). */
  otherHoldingsEquity: Cell;
  otherHoldingsDebt: Cell;
```

In `engine.ts` `portfolioKpis`, after the `otherHoldingsCount:` line add:

```ts
    otherHoldingsEquity: cell(sum(other.map((x) => x.equityInvested)), 'Property NOI · Σ equity invested (Residence)', 'confirmed'),
    otherHoldingsDebt: cell(sum(other.map((x) => x.loanBalance)), 'Property NOI · Σ loan balance (Residence)', 'confirmed'),
```

In `src/modules/overview/other-holdings.ts`, append:

```ts
/** Equity Invested disclosure (ratified 2026-09-24): the headline stays investment-only; the
 *  residence's equity is reported beside it, e.g. "+$900K other holdings" — or '' with none. */
export function otherHoldingsEquityClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsEquity'>): string {
  return k.otherHoldingsCount.value && k.otherHoldingsEquity.value
    ? `+${fmtUsdCompact(k.otherHoldingsEquity.value)} other holdings`
    : '';
}

/** Total Debt disclosure for a residence mortgage (governor loop is investment-only — ratified
 *  2026-09-24): "+$X other-holdings debt", or '' when the residence carries no loan balance. */
export function otherHoldingsDebtClause(k: Pick<PortfolioKpis, 'otherHoldingsCount' | 'otherHoldingsDebt'>): string {
  return k.otherHoldingsCount.value && k.otherHoldingsDebt.value
    ? `+${fmtUsdCompact(k.otherHoldingsDebt.value)} other-holdings debt`
    : '';
}
```

In `src/modules/debt/debt-sublabels.ts`, add `import { otherHoldingsDebtClause } from '../overview/other-holdings';` and replace `overviewTotalDebtSublabel` with:

```ts
export function overviewTotalDebtSublabel(
  k: Pick<PortfolioKpis, 'ltv' | 'affiliateDebt' | 'otherHoldingsCount' | 'otherHoldingsDebt'>,
): string {
  return join([
    otherHoldingsDebtClause(k),
    affiliateNotesClause(k.affiliateDebt.value),
    'property loan balances',
    `${fmtPct(k.ltv.value)} LTV`,
  ]);
}
```

In `widgets.tsx`, extend line 15 to `import { investmentPropertiesSublabel, otherHoldingsEquityClause } from './other-holdings';`. Replace line 53 with:

```tsx
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} sublabel={otherHoldingsEquityClause(k) || undefined} accentColor="var(--accent)" />
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/portfolio-kpis-residence.test.ts tests/unit/overview-kpi-other-holdings.test.tsx tests/unit/debt-sublabels.test.ts tests/unit/basis-labels.test.ts tests/unit/principal-kpis.test.ts && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` on `engine.ts` + `types.ts` with these lenses:
  1. `equityInvested` and `totalDebt` headlines are unchanged in value. Only disclosure cells are added.
  2. `applyScenario` passes the residence through, so the two new cells are workbook figures in every scenario and are tagged `'confirmed'`.
  3. Every surface that shows Equity or Total Debt uses the shared clause helper: Overview only today (`git grep -n "equityInvested.value" -- src server`).

  Record the id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/types.ts src/analytics/engine.ts src/modules/overview/other-holdings.ts src/modules/debt/debt-sublabels.ts src/modules/overview/widgets.tsx tests/unit/portfolio-kpis-residence.test.ts tests/unit/overview-kpi-other-holdings.test.tsx tests/unit/debt-sublabels.test.ts tests/unit/basis-labels.test.ts
git commit -m "feat(kpis): disclose residence equity (+other holdings) beside Equity Invested; residence debt beside Total Debt" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Residence excluded from capital-allocation verdicts and the Notion Property Register sync (item 3)

**Files:**
- Modify: `server/warehouse/capital-allocation.ts:61` (import), `:1154` (property loop), `:1369-1373` (`portfolioNoi`, `propertyCount`)
- Test: `tests/unit/capital-allocation.residence.test.ts`

**Interfaces:**
- Consumes: `isInvestmentProperty` (`src/analytics/property-basis.ts`).
- Produces: `buildCapitalAllocationReport(...)` returns entries for investment properties only. `propertyCount` and `portfolioNoi` use the same basis. `POST /capital-allocation/sync-notion` (`server/warehouse/api.ts:966-990`) maps `report.entries` into `syncCapitalActionsToNotion` unchanged, so the residence's Notion Property Register row is **never written, and its existing values stay untouched**. No Notion code changes.

- [ ] **Step 1: Reader check.** Run: `git grep -n "buildCapitalAllocationReport(" -- server src scripts`. Expected: `server/warehouse/api.ts:948,974,1013` and `server/warehouse/insights-api.ts:80` only. All four want verdict entries, and none expects one entry per snapshot property (`git grep -n "entries.length\|propertyCount" -- server/warehouse/api.ts server/warehouse/insights-api.ts server/warehouse/ic-memo.ts`).
- [ ] **Step 2: Write the failing test.** Create `tests/unit/capital-allocation.residence.test.ts`:

```ts
// @vitest-environment node
//
// Ratified 2026-09-24 (Gabriel): the residence is excluded from capital-allocation verdicts and — because
// POST /capital-allocation/sync-notion writes exactly report.entries — from the Notion Property Register
// sync (its existing Notion row is left untouched). Mock scaffolding mirrors
// capital-allocation.balloon-fresh.test.ts: every engine input is stubbed so the report's property loop
// is the only thing under test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DebtScoringModule from '../../server/warehouse/debt-scoring';
import type { WarehouseDb as WarehouseDbForMock } from '../../server/warehouse/db';

vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn().mockReturnValue([]) }));
vi.mock('../../server/warehouse/debt-scoring', async (importOriginal) => {
  const actual = await importOriginal<typeof DebtScoringModule>();
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  return {
    ...actual,
    scoreDebtPositions: vi.fn().mockReturnValue([]),
    scoreDebtPositionsWithTrust: vi.fn((db: unknown) => ({ scores: [], bookTrust: readDebtBookTrust(db as WarehouseDbForMock) })),
  };
});
vi.mock('../../server/warehouse/metrics', () => ({ propertyPeriodMetrics: vi.fn().mockReturnValue([]) }));
vi.mock('../../src/analytics/lease-forecast', () => ({ renewalSignals: vi.fn().mockReturnValue([]), bucketExpiry: vi.fn().mockReturnValue('24m+') }));
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')) }));
vi.mock('../../server/macro/market-benchmarks', () => ({ getMacroMarketBenchmarks: vi.fn().mockRejectedValue(new Error('no benchmarks in test')) }));
vi.mock('../../server/macro/regional-macro', () => ({ getRegionalMacro: vi.fn().mockRejectedValue(new Error('no regional in test')) }));

import { openWarehouse } from '../../server/warehouse/db';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const ASOF = '2026-09-24';
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = ASOF; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

const row = (id: string, type: string, noi: number) => ({
  index: 1, id, name: id, address: id, city: null, state: null, market: 'Columbus OH', type, tenantCount: 1, occPct: 1,
  acqDate: null, estValue100: 1_200_000, oxfordOwnPct: 1, oxfordValue: 1_200_000, noi, noiScenarioAdj: noi,
  grossIncome: noi, expenses: 0, debtService: 0, netCashFlow: noi, sf: 5_000, capRate: null, dscr: null, lender: null,
  loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null,
  encumbered: false, flags: [],
});

function snapshot(): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [row('inv-a', 'Flex', 80_000), row('inv-b', 'Retail', 40_000), row('9510-persimmon-tree-rd-potomac-md', 'Residence', 0)],
    leases: [], loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [], renewalStages: {}, tenantNotes: {},
    dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, quickbooks: null,
    marketRents: {}, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

// Same property_master seeding as capital-allocation.balloon-fresh.test.ts freshDb() — the residence has
// NO property_master row in production (it has no P&L files — server/warehouse/reconcile-noi.ts:418).
function freshDb(prefix: string) {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), prefix)), 'test.sqlite'));
  const ins = db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 5000, '2020-01-01', 1, 'active')
  `);
  ins.run('inv-a', 'inv-a');
  ins.run('inv-b', 'inv-b');
  return db;
}

describe('buildCapitalAllocationReport — residence excluded (ratified 2026-09-24)', () => {
  it('entries, propertyCount and portfolioNoi cover investment properties only', async () => {
    const db = freshDb('ca-residence-');
    const report = await buildCapitalAllocationReport(db, snapshot());
    expect(report.entries.map((e) => e.propertyId).sort()).toEqual(['inv-a', 'inv-b']);
    expect(report.propertyCount).toBe(2);
    expect(report.portfolioNoi).toBe(120_000);
  });
  it('the sync-notion payload built from report.entries (api.ts:975-980) never names the residence', async () => {
    const db = freshDb('ca-residence-sync-');
    const report = await buildCapitalAllocationReport(db, snapshot());
    const payload = report.entries.map((e) => ({ propertyName: e.propertyName, capitalAction: e.capitalAction, priorityScore: e.priorityScore }));
    expect(payload.some((x) => x.propertyName === '9510-persimmon-tree-rd-potomac-md')).toBe(false);
    expect(payload).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `npx vitest run tests/unit/capital-allocation.residence.test.ts`. Expected: FAIL (3 entries, `propertyCount` 3).
- [ ] **Step 4: Implement.** In `server/warehouse/capital-allocation.ts`, add after line 61:

```ts
import { isInvestmentProperty } from '../../src/analytics/property-basis';
```

Immediately before `const entries: CapitalAllocationEntry[] = [];` insert:

```ts
  // Ratified 2026-09-24 (Gabriel): the residence is not an investment asset — no capital-allocation
  // verdict, and because POST /capital-allocation/sync-notion writes exactly report.entries, no Notion
  // Property Register write either (its existing Notion row is left untouched). Same predicate as every
  // investment KPI (src/analytics/property-basis.ts).
  const investmentProperties = snapshot.properties.filter(isInvestmentProperty);
```

Change `for (const property of snapshot.properties) {` to `for (const property of investmentProperties) {`. Replace the `portfolioNoi` line with:

```ts
  const portfolioNoi = investmentProperties.reduce((sum, p) => sum + (p.noi ?? 0), 0);
```

In the return object, change `propertyCount: snapshot.properties.length,` to `propertyCount: investmentProperties.length,`.
- [ ] **Step 5: Run the tests.** Run: `npx vitest run tests/unit/capital-allocation.residence.test.ts tests/unit/capital-allocation.test.ts tests/unit/capital-allocation.integration.test.ts tests/unit/capital-allocation-api.test.ts tests/unit/notion-writeback.test.ts tests/unit/capital-allocation.balloon-fresh.test.ts tests/unit/capital-allocation.book-trust.round19.test.ts`. Expected: PASS. Existing fixtures carry no Residence rows. If one does, assert the investment-only count and name the reason in the test.
- [ ] **Step 6: Refute.** Invoke `refute-financial-change` on `capital-allocation.ts` with these lenses:
  1. `priorityScore` ranking of the 13 investment entries is unchanged, because the residence contributed nothing to peer medians here.
  2. The Notion writeback cannot touch the residence page by any path.
  3. IC memo / insights CF generator consumers accept 13 entries.
  4. `buildPortfolioAllocation` verdicts already exclude the residence via `property_master`. Cite `reconcile-noi.ts:418`.

  Record the id.
- [ ] **Step 7: Commit.**

```bash
git add server/warehouse/capital-allocation.ts tests/unit/capital-allocation.residence.test.ts
git commit -m "feat(capital): residence excluded from capital-allocation verdicts and the Notion Property Register sync (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Filter bar reads "13 investment · 1 other holding" (item 4)

**Files:**
- Create: `src/shell/filter-slice.ts`
- Modify: `src/shell/PortfolioFilterContext.tsx` (add `isPortfolioFiltered` after `filterProperties`, ~line 95)
- Modify: `src/shell/PortfolioFilterBar.tsx:19-26` (props), `:30` (`isFiltered`), `:92-97` (readout)
- Modify: `src/shell/AppShell.tsx:18,28-46` (`FilterBarWithSlice`)
- Test: `tests/unit/filter-slice.test.ts`, `tests/unit/portfolio-filter.test.tsx` (append)

**Interfaces:**
- Produces: `filterSliceReadout(all: readonly SliceRow[], matched: readonly SliceRow[], isFiltered: boolean): string | undefined`, where `SliceRow = { readonly type?: string | null; readonly noi: number }`, and `isPortfolioFiltered(f: PortfolioFilterState): boolean`. `PortfolioFilterBarProps.slice` is replaced by `readout?: string`. The readout is rendered whenever it is present, filtered or not.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/filter-slice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterSliceReadout } from '../../src/shell/filter-slice';

const inv = (noi: number) => ({ type: 'Flex', noi });
const res = { type: 'Residence', noi: 0 };
const live = [...Array.from({ length: 13 }, () => inv(300_000)), res]; // 13 investment + the residence

describe('filterSliceReadout (ratified 2026-09-24)', () => {
  it('unfiltered live shape reads "13 investment · 1 other holding"', () => {
    expect(filterSliceReadout(live, live, false)).toBe('13 investment · 1 other holding');
  });
  it('filtered: "N of 13 investment · $X.XM NOI", NOI over matched investment rows only', () => {
    expect(filterSliceReadout(live, [inv(300_000), inv(200_000), inv(100_000)], true)).toBe('3 of 13 investment · $0.6M NOI');
  });
  it('filtered to the residence type: "0 of 13 investment · 1 other holding · $0.0M NOI"', () => {
    expect(filterSliceReadout(live, [res], true)).toBe('0 of 13 investment · 1 other holding · $0.0M NOI');
  });
  it('plural other holdings; no "of" when a filter matches every investment row', () => {
    expect(filterSliceReadout([inv(1), res, res], [inv(1), res, res], true)).toBe('1 investment · 2 other holdings · $0.0M NOI');
  });
  it('no rows yet → no readout', () => {
    expect(filterSliceReadout([], [], false)).toBeUndefined();
  });
});
```

Append to `tests/unit/portfolio-filter.test.tsx`, inside `describe('PortfolioFilterBar', …)`:

```tsx
  it('shows the readout even when unfiltered (13 investment · 1 other holding)', () => {
    render(
      <PortfolioFilterProvider>
        <PortfolioFilterBar managers={[]} readout="13 investment · 1 other holding" />
      </PortfolioFilterProvider>,
    );
    expect(screen.getByText('13 investment · 1 other holding')).toBeTruthy();
  });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/filter-slice.test.ts tests/unit/portfolio-filter.test.tsx`. Expected: FAIL (module missing; `readout` is not a prop).
- [ ] **Step 3: Implement.** Create `src/shell/filter-slice.ts`:

```ts
// src/shell/filter-slice.ts
//
// Filter-bar readout (ratified 2026-09-24): counts read "N investment · M other holding(s)" — the same
// basis as every investment KPI (isInvestmentProperty) — never a residence-inclusive "14 of 14 assets".
// Unfiltered: "13 investment · 1 other holding". Filtered: "3 of 13 investment · $0.6M NOI" (NOI over the
// matched INVESTMENT rows only), with the other-holdings clause only when a matched row is one.
import { isInvestmentProperty } from '@analytics/index';

export interface SliceRow {
  readonly type?: string | null;
  readonly noi: number;
}

export function filterSliceReadout(all: readonly SliceRow[], matched: readonly SliceRow[], isFiltered: boolean): string | undefined {
  if (all.length === 0) return undefined;
  const totalInvestment = all.filter(isInvestmentProperty).length;
  const investment = matched.filter(isInvestmentProperty);
  const other = matched.length - investment.length;
  const count =
    isFiltered && investment.length !== totalInvestment
      ? `${investment.length} of ${totalInvestment} investment`
      : `${investment.length} investment`;
  const otherClause = other > 0 ? ` · ${other} other holding${other === 1 ? '' : 's'}` : '';
  const noi = isFiltered ? ` · $${(investment.reduce((sum, p) => sum + p.noi, 0) / 1_000_000).toFixed(1)}M NOI` : '';
  return `${count}${otherClause}${noi}`;
}
```

In `src/shell/PortfolioFilterContext.tsx`, after `filterProperties`, add:

```ts
/** True when any dimension is narrowed — shared by the bar's styling and the shell's readout. */
export function isPortfolioFiltered(f: PortfolioFilterState): boolean {
  return f.market !== 'all' || f.propertyType !== 'all' || f.manager !== 'all';
}
```

In `PortfolioFilterBar.tsx`:
1. Replace the `slice?: …` prop and its doc comment with:

```ts
  /** Display-only readout ("13 investment · 1 other holding" / "3 of 13 investment · $0.6M NOI"),
   *  computed by the mounting component (src/shell/filter-slice.ts) — rendered whenever present. */
  readout?: string;
```

2. Change the signature to `export function PortfolioFilterBar({ managers, readout }: PortfolioFilterBarProps) {`.
3. Replace the `isFiltered` computation with `const isFiltered = isPortfolioFiltered(filter);`, importing `isPortfolioFiltered` from `./PortfolioFilterContext` alongside `usePortfolioFilter`.
4. Replace the `{isFiltered && slice && ( … )}` block with:

```tsx
      {readout && (
        <span className="num ml-auto text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {readout}
        </span>
      )}
```

In `AppShell.tsx`:
1. Replace the line-18 import with `import { PortfolioFilterProvider, filterProperties, isPortfolioFiltered, usePortfolioFilter } from './PortfolioFilterContext';` and add `import { filterSliceReadout } from './filter-slice';`.
2. Replace `FilterBarWithSlice` and its doc comment (lines 28-46) with:

```tsx
/**
 * Reads the active portfolio filter from context and derives the display-only readout (investment vs
 * other-holdings counts, ratified 2026-09-24 — src/shell/filter-slice.ts) from already-fetched snapshot
 * rows — no new fetch. Lives INSIDE PortfolioFilterProvider so it can consume the filter.
 */
function FilterBarWithSlice({ properties }: { properties: Property[] }) {
  const { filter } = usePortfolioFilter();
  const matched = filterProperties(properties, filter);
  return <PortfolioFilterBar managers={NO_MANAGERS} readout={filterSliceReadout(properties, matched, isPortfolioFiltered(filter))} />;
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/filter-slice.test.ts tests/unit/portfolio-filter.test.tsx && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/shell/filter-slice.ts src/shell/PortfolioFilterContext.tsx src/shell/PortfolioFilterBar.tsx src/shell/AppShell.tsx tests/unit/filter-slice.test.ts tests/unit/portfolio-filter.test.tsx
git commit -m "feat(shell): filter bar reads investment vs other-holdings counts (13 investment · 1 other holding)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Per-property DSCR/LTV governor loop over investment properties only (item 5)

**Files:**
- Modify: `src/analytics/conditions.ts` (import; `for (const p of s.properties) {` at line 351)
- Test: `tests/unit/conditions.test.ts` (append)

**Interfaces:**
- Consumes: `isInvestmentProperty`.
- Produces: no `dscr-floor-`, `dscr-`, `ltv-` or `ltv-governor-` insight for a Residence row. Ids and governor constants are unchanged. A residence mortgage is disclosed as other-holdings debt instead (Task 8).

- [ ] **Step 1: Write the failing test.** Append to `tests/unit/conditions.test.ts`:

```ts
describe('evaluateConditions — governor loop runs on investment properties only (ratified 2026-09-24)', () => {
  it('a residence row with a sub-floor DSCR and a 70% LTV fires no DSCR/LTV alert', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'res', type: 'Residence', dscr: 0.9, lender: 'Wells', loanBalance: 900_000, ltv: 0.7 })] }), opts);
    expect(out.filter((i) => i.entityId === 'res' && i.category === 'debt')).toEqual([]);
  });
  it('the same figures on an investment row still fire, ids unchanged', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', dscr: 0.9, lender: 'Wells', loanBalance: 900_000, ltv: 0.7 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-floor-p1')?.severity).toBe('critical');
    expect(out.find((i) => i.id === 'ltv-p1')?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/conditions.test.ts`. Expected: FAIL (`dscr-floor-res` and `ltv-res` fire).
- [ ] **Step 3: Implement.** Add `import { isInvestmentProperty } from './property-basis';` beside the Task 4 import. Replace `for (const p of s.properties) {` (the governor loop, line 351) with:

```ts
  // Ratified 2026-09-24 (Gabriel): per-property DSCR/LTV governor alerts are an INVESTMENT signal —
  // the residence is excluded (a residence mortgage is disclosed as other-holdings debt on the Total
  // Debt tile instead). Governor constants and insight ids unchanged.
  for (const p of s.properties.filter(isInvestmentProperty)) {
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/conditions.test.ts tests/unit/lease-forecast-conditions.test.ts tests/unit/insurance-conditions.test.ts`. Expected: PASS.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` on `conditions.ts` with these lenses:
  1. No investment property loses a governor alert. The filter is exactly `type !== 'Residence'`.
  2. The brief critical set: the live residence has `dscr` null, so there is no live change.
  3. Ids are unchanged.

  Record the id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/conditions.test.ts
git commit -m "fix(alerts): DSCR/LTV governor loop over investment properties only (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: L-1 lease-expiry insights — critical under 60 days, warning at 60–90 days (item 6)

**Files:**
- Modify: `src/analytics/conditions.ts:53-55` (threshold comment), `:457-468` (L-1 block)
- Modify: `tests/unit/conditions.test.ts:300-304`, `tests/unit/lease-forecast-conditions.test.ts:56-71` (C-1)

**Interfaces:**
- Produces: `lease-expiry-<leaseId>` (id unchanged) has severity `daysToExpiry < ALERT_THRESHOLDS.leaseCriticalDays (60) ? 'critical' : 'warning'`. That is the same line as the legacy `expiring-` insight (`conditions.ts:408`), the Calendar "Critical (<60d)" KPI and `src/brain/critical-dates.ts:27`, giving one 60-day line everywhere. `impactAnnualUsd` is unchanged.

- [ ] **Step 1: Update and add the failing tests.** In `tests/unit/conditions.test.ts`, replace the test at lines 300-304 (`'lease at exactly 60d is the single L-1 critical …'`) with:

```ts
  it('lease at exactly 60d is the single L-1 WARNING — one <60d critical line everywhere (ratified 2026-09-24)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(60) })] }), opts);
    expect(out.find((i) => i.id === 'lease-expiry-l1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
```

In `tests/unit/lease-forecast-conditions.test.ts`, replace the C-1 describe title and first test (lines 56-71) with:

```ts
describe('C-1: L-1 — expiring ≤90d, no stage → critical under 60d, warning 60–90d (ratified 2026-09-24)', () => {
  it('<60d expiry, no stage → exactly one L-1, critical, impactAnnualUsd=annualRent, spine:A, category:lease', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(45), monthsToExpiry: 1.5, annualRent: 24000 });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    const ins = out.filter((i) => i.id === `lease-expiry-l1`);
    expect(ins).toHaveLength(1);
    const i = ins[0]!;
    expect(i.severity).toBe('critical');
    expect(i.category).toBe('lease');
    expect(i.spine).toBe('A');
    expect(i.provenance).toBe('real');
    expect(i.impactAnnualUsd).toBe(24000);
    expect(i.entityType).toBe('lease');
    expect(i.entityId).toBe('l1');
  });

  it.each([
    [59, 'critical'],
    [60, 'warning'],
    [75, 'warning'],
    [90, 'warning'],
  ])('%id → %s (same id, impact unchanged)', (days, severity) => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(days), monthsToExpiry: days / 30, annualRent: 18000 });
    const ins = evaluateConditions(snap({ leases: [l] }), opts).find((i) => i.id === 'lease-expiry-l1');
    expect(ins?.severity).toBe(severity);
    expect(ins?.impactAnnualUsd).toBe(18000);
  });
```

Keep the existing `'exactly 90d (3 months) expiry, no stage → fires L-1'` test and the rest of the describe as they are.
- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/conditions.test.ts tests/unit/lease-forecast-conditions.test.ts`. Expected: FAIL (60/75/90 are `'critical'`).
- [ ] **Step 3: Implement.** In `conditions.ts`, replace the `expiryNoSignalDays` comment (lines 53-54) with:

```ts
  // expiryNoSignalDays: ≤90d expiry with no renewal stage advance triggers L-1. Severity follows the
  // single leaseCriticalDays line (ratified 2026-09-24): <60d critical, 60–90d warning.
```

In the L-1 `out.push` (line 468), replace `severity: 'critical',` with:

```ts
          severity: daysToExpiry < T.leaseCriticalDays ? 'critical' : 'warning',
```

- [ ] **Step 4: Run the full suite.** Run: `npx vitest run`. Expected: PASS. Any other suite that pinned `critical` for an L-1 at 60–90 days must be updated to `'warning'`, with a one-line comment citing the 2026-09-24 ruling. Fix only such pins, and list each file in the commit body.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` on the diff with these lenses:
  1. Brief dead-man diff: 60–90d leases leave the critical set. Confirm through `diffCriticalAlerts` that clear-streaks retire them without emailing, and that no id changes.
  2. Snooze/read persistence is keyed by id, so it is unaffected.
  3. Risk $ totals are unchanged, because warnings count as risk in `buildSummary`.
  4. Boundary: day 59 is critical and day 60 is a warning, matching `critical-dates.ts:27`.

  Record the id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/conditions.test.ts tests/unit/lease-forecast-conditions.test.ts
git commit -m "fix(alerts): L-1 lease expiry is critical under 60d, warning at 60-90d — one 60-day line (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: L-5 rollover-concentration contributes $0 to Risk $ (item 7)

**Files:**
- Modify: `src/analytics/conditions.ts:556-568` (L-5 push)
- Modify: `tests/unit/lease-forecast-conditions.test.ts:188-201` (C-6 first test)
- Test: `tests/unit/lease-forecast-conditions.test.ts` (append)

**Interfaces:**
- Produces: `rollover-concentration-<bucket>` (id and severity `'warning'` unchanged) now carries `impactAnnualUsd: null`. `totalsBySpine` skips null, so it contributes $0. `sortByImpactDesc` sorts it after dollar items in its tier, `brief/render.ts` never picks it as the top-impact line, and TierBoard shows "—". The bucket rent stays in `detail`.

- [ ] **Step 1: Update and add the failing tests.** In `tests/unit/lease-forecast-conditions.test.ts`, replace the C-6 first test (lines 188-201) with:

```ts
  it('0-6m bucket ≥15% of total → L-5 warning; impact is null ($0 to Risk $ — its rent is already in the per-lease expiry alerts)', () => {
    // Total rent: 100000. l1 expiring in 3m: 20000 = 20% → fires
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(90), monthsToExpiry: 3, annualRent: 20000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(365), monthsToExpiry: 12, annualRent: 80000 });
    const out = evaluateConditions(snap({ leases: [l1, l2] }), opts);
    const ins = out.find((i) => i.id === 'rollover-concentration-0-6m');
    expect(ins).toBeDefined();
    expect(ins!.severity).toBe('warning');
    expect(ins!.spine).toBe('A');
    expect(ins!.provenance).toBe('derived');
    expect(ins!.impactAnnualUsd).toBeNull();
    expect(ins!.detail).toContain('$20K');
  });
```

Add `import { mergeInsightSources, buildSummary } from '../../src/modules/insights/insights.logic';` to the file's imports, then append at the end of the file:

```ts
describe('L-5 does not double-count Risk $ (ratified 2026-09-24)', () => {
  it('Workbook-basis Risk $ equals the per-lease expiry impact alone', () => {
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(90), monthsToExpiry: 3, annualRent: 20000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(365), monthsToExpiry: 12, annualRent: 80000 });
    const s = snap({ leases: [l1, l2] });
    const out = evaluateConditions(s, opts);
    expect(out.some((i) => i.id === 'rollover-concentration-0-6m')).toBe(true); // still alerts
    const { merged } = mergeInsightSources(out, [], s);
    const workbook = buildSummary(merged).riskImpactBySpine.find((t) => t.label === 'Workbook basis')!;
    expect(workbook.totalUsd).toBe(20000); // L-1 on l1 only; was 40000 with L-5 counted
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/lease-forecast-conditions.test.ts`. Expected: FAIL (impact 20000; Risk $ 40000).
- [ ] **Step 3: Implement.** In the L-5 `out.push`, replace the `detail:` and `impactAnnualUsd: bucketRent,` lines with:

```ts
            detail: `${fmtPct(bucketPct)} of total annual rent (${fmtUsdCompact(bucketRent)}) expires in the ${bucket} window — above the ${fmtPct(T.tenantNoiConcentrationInfo)} concentration threshold. That rent is already counted in the per-lease expiry alerts, so this alert adds nothing to Risk $.`,
```

```ts
            // Ratified 2026-09-24: a concentration signal, not a new exposure — the bucket's rent is the
            // same rent the per-lease expiry alerts (L-1 / expiring-) already carry, so it contributes $0
            // to Risk $ (null is skipped by totalsBySpine). Still alerts; id unchanged.
            impactAnnualUsd: null,
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/lease-forecast-conditions.test.ts tests/unit/conditions.test.ts tests/unit/insights-logic.test.ts tests/unit/insights-module.test.tsx`. Expected: PASS.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` on the diff with these lenses:
  1. Every `impactAnnualUsd` reader in the Pre-flight table handles null. `fillImpact` does not refill it, because it has no `entityId`.
  2. Brief top-impact line: `render.ts:52` skips null.
  3. An L-5 bucket whose leases produced **no** per-lease expiry alert: the 6-12m bucket is beyond the 180d legacy window. Document that such rent is then in no Risk $ figure. This is the ratified trade-off. The alert and its detail still show the dollars.

  Record the id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/lease-forecast-conditions.test.ts
git commit -m "fix(alerts): L-5 rollover concentration contributes \$0 to Risk \$ (no double count; ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: `reconcile-fail` fires only on error-severity reconciliation flags (item 8)

**Files:**
- Modify: `src/analytics/conditions.ts:797-812` (data-quality block)
- Test: `tests/unit/conditions.test.ts` (inside `describe('evaluateConditions — data quality & deals', …)`)

**Interfaces:**
- Produces: `reconcile-fail` (id and severity `'critical'` unchanged) fires only when at least one flag has `entity === 'reconciliation' && severity === 'error'`. Its detail lists only those error fields. Warn-level reconciliation flags stay in Health › Data Quality and the (amber) Reconciliation card from Task 6.

- [ ] **Step 1: Write the failing tests.** Add inside the `'evaluateConditions — data quality & deals'` describe:

```ts
  it('warn-only reconciliation flags do NOT fire reconcile-fail (ratified 2026-09-24)', () => {
    const out = evaluateConditions(snap({ dataQuality: [{ entity: 'reconciliation', field: 'cash.history.date', issue: 'missing rows', severity: 'warn' }] }), opts);
    expect(out.some((i) => i.id === 'reconcile-fail')).toBe(false);
  });
  it('mixed flags: reconcile-fail counts and names only the error-severity fields', () => {
    const out = evaluateConditions(snap({ dataQuality: [
      { entity: 'reconciliation', field: 'cash.history.date', issue: 'missing rows', severity: 'warn' },
      { entity: 'reconciliation', field: 'properties.noi', issue: 'Σ NOI ≠ workbook', severity: 'error' },
    ] }), opts);
    const i = out.find((x) => x.id === 'reconcile-fail')!;
    expect(i.severity).toBe('critical');
    expect(i.metric).toBe('1');
    expect(i.detail).toContain('(properties.noi)');
    expect(i.detail).not.toContain('cash.history.date');
  });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/conditions.test.ts`. Expected: FAIL (warn fires the critical insight).
- [ ] **Step 3: Implement.** Replace `const reconFlags = s.dataQuality.filter((f) => f.entity === 'reconciliation');` with:

```ts
  // Ratified 2026-09-24: the CRITICAL reconcile-fail insight (and its alert email) fires only on
  // ERROR-severity reconciliation flags — a publish-blocking inconsistency (hasReconciliationError,
  // server/reconcile-runtime.ts, uses the same test). Warn-level flags stay in System Health.
  const reconFlags = s.dataQuality.filter((f) => f.entity === 'reconciliation' && f.severity === 'error');
```

- [ ] **Step 4: Run the full suite.** Run: `npx vitest run`. Expected: PASS. Any suite that expected `reconcile-fail` from a **warn** reconciliation flag is updated to use `severity: 'error'`, or to assert its absence, with a comment citing the ruling. Start with `tests/unit/brain.test.ts:258`, which is a comment only, and list any edited file in the commit body.
- [ ] **Step 5: Refute.** Invoke `refute-financial-change` with these lenses:
  1. Every `checkSnapshot` flag that is a true integrity breach is emitted at `'error'`. Enumerate the `flag(...)` calls with default severity `'error'` in `reconcile-runtime.ts`. The `annualRent`, `counterparties.links` and `checkCashInvariants` warns are the only warn-level ones.
  2. Alignment with `hasReconciliationError`: publish gating and the critical insight now use the same test.
  3. The brief email volume only goes down.

  Record the id.
- [ ] **Step 6: Commit.**

```bash
git add src/analytics/conditions.ts tests/unit/conditions.test.ts
git commit -m "fix(alerts): reconcile-fail fires only on error-severity reconciliation flags (ratified 2026-09-24)" -m "Refute-Reviewed: wf_<runId>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR B close-out:**
- [ ] Rebase onto PR A's head (or `origin/main` if A merged). Re-run the Pre-flight greps.
- [ ] `npm run gate`, then `npx tsx scripts/check-refute-required.ts`. Expected: green / PASS.
- [ ] Live cross-check. Create `.superpowers/live-check-b.ts`:

```ts
import { readFileSync } from 'node:fs';
import { buildAnalytics } from '../src/analytics/engine';
import type { PortfolioSnapshot } from '../src/contracts/index';

const s = JSON.parse(readFileSync('data/snapshots/portfolio.json', 'utf8')) as PortfolioSnapshot;
const a = buildAnalytics(s, 'Base', '2026-09-24');
const l1 = a.insights.filter((i) => i.id.startsWith('lease-expiry-'));
console.log(JSON.stringify({
  equity: a.kpis.equityInvested.value, otherEquity: a.kpis.otherHoldingsEquity.value,
  l1Critical: l1.filter((i) => i.severity === 'critical').map((i) => i.title),
  l1Warning: l1.filter((i) => i.severity === 'warning').map((i) => i.title),
  l5: a.insights.filter((i) => i.id.startsWith('rollover-concentration-')).map((i) => i.id),
  rarigGovernor: a.insights.some((i) => i.id === 'ltv-governor-1100-rarig-ave-columbus-oh'),
}, null, 2));
```

Run: `npx tsx .superpowers/live-check-b.ts`. Expected output:
- `equity` unchanged from before this task (investment-only), `otherEquity` equal to the residence's equity.
- `l1Critical`: exactly 2 titles, `Expiring, no renewal signal — …` ending in Tenant 026 LLC and TENANT 057 LLC (37d).
- `l1Warning`: exactly 3 titles, ending in Tenant 039 LLC, Tenant 050 LLC, and Tenant 109 LLC (67d).
- `l5` = `[]`, `rarigGovernor` = `false`.

Paste the output into the PR body, then `rm .superpowers/live-check-b.ts`.
- [ ] Browser check: Overview KPI strip (Equity sublabel), filter bar unfiltered and filtered to Residence, Capital › Allocation (13 rows), Brain › Insights tiers. Light and dark, 1440 and 375. Screenshots.
- [ ] `git push -u origin fix/cc-r2-b-residence-alerts`. Open PR `fix(cc): residence out of allocation/Notion/governor loop; L-1/L-5/reconcile-fail tiering (round 2 · B)`. The body starts `Base branch: fix/cc-review-round2. Merge PR A first.` and includes the refute ids and live output.
- [ ] Review: `adversarial-merge-gate` (alert + allocation engine).

---

## PR C — Freshness + UX (items 9, 10, 12)

Branch: `git switch -c fix/cc-r2-c-freshness-ux` from PR B's head. The body says `Base branch: fix/cc-r2-b-residence-alerts. Merge PR B first.`

### Task 15: AR feed freshness = newest import, plus "N leases with stale AR" (item 9) (architect-owned: `server/index.ts`)

**Files:**
- Modify: `server/feed-freshness.ts` (import, `FeedFreshness.note`, `assessFeeds` third param, new `arFeedInput`)
- Modify: `server/index.ts:47` (import), `:283-303` (`/api/health` AR input)
- Modify: `src/lib/feed-health.ts` (`FeedHealth.note?`)
- Create: `src/modules/health/feed-row.ts`
- Modify: `src/modules/health/HealthModule.tsx:145-175` (Data Feeds card)
- Test: `tests/unit/feed-freshness.test.ts` (append), `tests/unit/feed-row.test.ts` (create)

**Interfaces:**
- Consumes: `isArStale` (`src/analytics/conditions.ts:903`), which is the same per-record staleness definition the collections gate uses.
- Produces:
  - `arFeedInput(arrears: Readonly<Record<string, { asOfDate?: Date | string | null }>>, now: number): { lastAt: string | null; staleLeaseCount: number; note: string | undefined }`
  - `assessFeeds(input, now, notes?: Partial<Record<FeedId, string>>)`, which sets `FeedFreshness.note` only when a note is given
  - `feedRowValue(f: FeedHealth): string`, `feedRowTone(f: FeedHealth): 'ok' | 'warn' | 'error'`, and `feedsBadge(feeds: readonly FeedHealth[]): { tone: 'red' | 'amber' | 'green'; label: string }`

- [ ] **Step 1: Write the failing tests.** Append to `tests/unit/feed-freshness.test.ts` (and change its import to `import { assessFeeds, arFeedInput, FEED_MAX_AGE_DAYS } from '../../server/feed-freshness';`):

```ts
describe('arFeedInput — newest import drives freshness; stale per-lease records ride as a note (ratified 2026-09-24)', () => {
  const NOW2 = Date.parse('2026-09-24T12:00:00Z');
  const none = { snapshot: null, cashHistory: null, dailyBrief: null, leaseMarket: null, docIndex: null };

  it('live shape: 37 records from 2026-08-21 + 7 from 2026-07-15 → fresh at 34d with "7 leases with stale AR"', () => {
    const arrears: Record<string, { asOfDate?: Date | null }> = {};
    for (let i = 0; i < 37; i++) arrears[`f${i}`] = { asOfDate: new Date('2026-08-21T00:00:00.000Z') };
    for (let i = 0; i < 7; i++) arrears[`s${i}`] = { asOfDate: new Date('2026-07-15T00:00:00.000Z') };
    const ar = arFeedInput(arrears, NOW2);
    expect(ar).toEqual({ lastAt: '2026-08-21T00:00:00.000Z', staleLeaseCount: 7, note: '7 leases with stale AR' });
    const feed = assessFeeds({ ...none, ar: ar.lastAt }, NOW2, { ar: ar.note }).find((f) => f.id === 'ar')!;
    expect(feed).toMatchObject({ status: 'fresh', ageDays: 34, note: '7 leases with stale AR' });
  });
  it('accepts ISO strings (a JSON-loaded snapshot) as well as Dates', () => {
    const ar = arFeedInput({ a: { asOfDate: '2026-09-20T00:00:00.000Z' } }, NOW2);
    expect(ar).toEqual({ lastAt: '2026-09-20T00:00:00.000Z', staleLeaseCount: 0, note: undefined });
  });
  it('a null asOfDate is stale but never the newest import; singular note', () => {
    const ar = arFeedInput({ a: { asOfDate: null }, b: { asOfDate: new Date('2026-09-20T00:00:00.000Z') } }, NOW2);
    expect(ar).toEqual({ lastAt: '2026-09-20T00:00:00.000Z', staleLeaseCount: 1, note: '1 lease with stale AR' });
  });
  it('legacy records with no asOfDate field are neither dated nor stale; empty → missing', () => {
    expect(arFeedInput({ a: {} }, NOW2)).toEqual({ lastAt: null, staleLeaseCount: 0, note: undefined });
    expect(arFeedInput({}, NOW2)).toEqual({ lastAt: null, staleLeaseCount: 0, note: undefined });
  });
  it('assessFeeds without notes adds no note key (backward compatible)', () => {
    const feed = assessFeeds({ ...none, ar: '2026-09-20T00:00:00.000Z' }, NOW2).find((f) => f.id === 'ar')!;
    expect('note' in feed).toBe(false);
  });
});
```

Create `tests/unit/feed-row.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { feedRowTone, feedRowValue, feedsBadge } from '../../src/modules/health/feed-row';
import type { FeedHealth } from '../../src/lib/feed-health';

const f = (o: Partial<FeedHealth>): FeedHealth => ({ id: 'ar', label: 'AR aging (QuickBooks)', lastAt: null, ageDays: 34, maxAgeDays: 35, status: 'fresh', fix: 'Run the QuickBooks AR export + ar-import-headless', ...o });

describe('feed-row', () => {
  it('a note leads the value and turns a fresh row amber', () => {
    const row = f({ note: '7 leases with stale AR' });
    expect(feedRowValue(row)).toBe('7 leases with stale AR · 34d old');
    expect(feedRowTone(row)).toBe('warn');
  });
  it('unchanged wording for fresh / stale / missing without a note', () => {
    expect(feedRowValue(f({}))).toBe('34d old');
    expect(feedRowTone(f({}))).toBe('ok');
    expect(feedRowValue(f({ status: 'stale', ageDays: 71 }))).toBe('71d old (max 35d) — Run the QuickBooks AR export + ar-import-headless');
    expect(feedRowValue(f({ status: 'missing', ageDays: null }))).toBe('never — Run the QuickBooks AR export + ar-import-headless');
    expect(feedRowTone(f({ status: 'missing' }))).toBe('error');
  });
  it('badge: red on missing, amber on stale or a note, green otherwise; counts every non-ok row', () => {
    expect(feedsBadge([f({}), f({ status: 'missing' })])).toEqual({ tone: 'red', label: '1 need attention' });
    expect(feedsBadge([f({ note: 'x' }), f({ status: 'stale' })])).toEqual({ tone: 'amber', label: '2 need attention' });
    expect(feedsBadge([f({})])).toEqual({ tone: 'green', label: '0 need attention' });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/feed-freshness.test.ts tests/unit/feed-row.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement `server/feed-freshness.ts`.** Change line 1 to `import { ALERT_THRESHOLDS, isArStale } from '../src/analytics/conditions';`. Add `note?: string;` as the last field of `FeedFreshness`, with the doc comment `/** Optional disclosure shown before the age, e.g. "7 leases with stale AR". */`. Replace `assessFeeds` with:

```ts
export function assessFeeds(input: FeedInputs, now: number, notes: Partial<Record<FeedId, string>> = {}): FeedFreshness[] {
  return (Object.keys(META) as FeedId[]).map((id) => {
    const lastAt = input[id];
    const t = lastAt ? Date.parse(lastAt) : NaN;
    const ok = Number.isFinite(t);
    const ageMs = ok ? now - t : null;
    // Display keeps whole-day granularity; status decides on exact elapsed ms so a sub-day
    // budget (dailyBrief = 1.5 days = 36h) doesn't get rounded away by Math.floor (I-3, 2026-09-23
    // review — the card badge and this row disagreed on when the daily brief goes stale).
    const ageDays = ok ? Math.floor(ageMs! / DAY_MS) : null;
    const maxAgeDays = FEED_MAX_AGE_DAYS[id];
    const status: FeedStatus = ageMs === null ? 'missing' : ageMs > maxAgeDays * DAY_MS ? 'stale' : 'fresh';
    const note = notes[id];
    return { id, label: META[id].label, lastAt, ageDays, maxAgeDays, status, fix: META[id].fix, ...(note ? { note } : {}) };
  });
}

/**
 * AR feed input (ratified 2026-09-24). Feed age = the NEWEST stamped AR import — "when did an import
 * last land" — instead of the oldest record, which kept the row red for weeks after a fresh import
 * because a handful of leases were simply absent from it. Those per-lease records still matter
 * (collections gating withholds exactly their alerts), so they are counted with the SAME definition
 * the gate uses (isArStale, src/analytics/conditions.ts) and surfaced as a note on the row.
 * Records with no asOfDate FIELD are pre-Track-B/manual: neither dated nor stale (isArStale → false).
 * Accepts Date or ISO string (in-memory Zod-coerced snapshot vs a JSON-loaded one).
 */
export function arFeedInput(
  arrears: Readonly<Record<string, { asOfDate?: Date | string | null }>>,
  now: number,
): { lastAt: string | null; staleLeaseCount: number; note: string | undefined } {
  let newest: number | null = null;
  let stale = 0;
  for (const r of Object.values(arrears)) {
    if (!('asOfDate' in r)) continue;
    const t = r.asOfDate ? new Date(r.asOfDate).getTime() : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    if (isArStale(r as { asOfDate?: Date | null }, now)) stale += 1;
  }
  return {
    lastAt: newest === null ? null : new Date(newest).toISOString(),
    staleLeaseCount: stale,
    note: stale > 0 ? `${stale} lease${stale === 1 ? '' : 's'} with stale AR` : undefined,
  };
}
```

- [ ] **Step 4: Implement `server/index.ts` (architect-owned; the sentinel must be fresh).** Change line 47 to `import { assessFeeds, arFeedInput } from './feed-freshness';`. In the `/api/health` handler, delete the `const arDates = …` block (lines 283-286). Replace the `const feeds = assessFeeds({ … }, Date.now());` statement with:

```ts
  const now = Date.now();
  // AR (ratified 2026-09-24): age = the NEWEST stamped import; per-lease stale records are a note.
  const ar = arFeedInput(snap?.tenantArrears ?? {}, now);
  const feeds = assessFeeds({
    snapshot: snap?.meta.generatedAt ?? null,
    cashHistory: snap?.cash.history.at(-1)?.date ?? null,
    ar: ar.lastAt,
    dailyBrief: briefHealth?.ranAt ?? null,
    leaseMarket: leaseMarketAt,
    docIndex: docIndexBuiltAt(),
  }, now, ar.note ? { ar: ar.note } : {});
```

- [ ] **Step 5: Implement the client.** In `src/lib/feed-health.ts`, add `note?: string;` as the last field of `FeedHealth`. Create `src/modules/health/feed-row.ts`:

```ts
// src/modules/health/feed-row.ts
//
// System Health › Data Feeds row/badge presentation. A feed may carry a disclosure `note` (e.g. the AR
// feed's "7 leases with stale AR", ratified 2026-09-24): it leads the row value and turns an otherwise
// fresh row amber, so a fresh import with stragglers is visible without reading red.
import type { FeedHealth } from '@/lib/feed-health';

export function feedRowValue(f: FeedHealth): string {
  const base =
    f.status === 'fresh'
      ? `${f.ageDays}d old`
      : f.status === 'missing'
        ? `never — ${f.fix}`
        : `${f.ageDays}d old (max ${f.maxAgeDays}d) — ${f.fix}`;
  return f.note ? `${f.note} · ${base}` : base;
}

export function feedRowTone(f: FeedHealth): 'ok' | 'warn' | 'error' {
  if (f.status === 'missing') return 'error';
  if (f.status === 'stale' || f.note) return 'warn';
  return 'ok';
}

/** M5 (2026-09-23): missing outranks stale in the badge tone; a noted row counts as needing attention. */
export function feedsBadge(feeds: readonly FeedHealth[]): { tone: 'red' | 'amber' | 'green'; label: string } {
  const tones = feeds.map(feedRowTone);
  const n = tones.filter((t) => t !== 'ok').length;
  return { tone: tones.includes('error') ? 'red' : tones.includes('warn') ? 'amber' : 'green', label: `${n} need attention` };
}
```

In `HealthModule.tsx`, add `import { feedRowTone, feedRowValue, feedsBadge } from './feed-row';`. Replace the Data Feeds `<Card>` (lines 145-175, the `{!healthErr && health?.feeds && ( … )}` block) with:

```tsx
        {!healthErr && health?.feeds && (() => {
          const badge = feedsBadge(health.feeds);
          return (
            <Card>
              <CardHeader title="Data Feeds" trailing={<Badge tone={badge.tone}>{badge.label}</Badge>} />
              <ul className="flex flex-col">
                {health.feeds.map((f) => (
                  <Row key={f.id} tone={feedRowTone(f)} label={f.label} value={feedRowValue(f)} />
                ))}
              </ul>
            </Card>
          );
        })()}
```

- [ ] **Step 6: Run the tests.** Run: `npx vitest run tests/unit/feed-freshness.test.ts tests/unit/feed-row.test.ts tests/unit/health-module.test.tsx tests/unit/health-signal.test.tsx && npm run typecheck && npm run lint`. Expected: PASS. The existing red/amber/green badge tests (`health-module.test.tsx:154-175`) still hold. `healthSignal.ts` reads `status` only, so the TopBar dot does not tint for a note-only row. That is by design, and the Health card is where the note lives.
- [ ] **Step 7: Refute.** Commit with `Refute-Skip: feed-freshness display plumbing — no financial math; staleness definition reused verbatim from isArStale (collections gate unchanged)`. The commit touches `server/**`. This is truthful: no alert, gate or total changes.
- [ ] **Step 8: Commit.**

```bash
git add server/feed-freshness.ts server/index.ts src/lib/feed-health.ts src/modules/health/feed-row.ts src/modules/health/HealthModule.tsx tests/unit/feed-freshness.test.ts tests/unit/feed-row.test.ts
git commit -m "fix(health): AR feed age = newest import, with 'N leases with stale AR' on the Data Feeds row (ratified 2026-09-24)" -m "Refute-Skip: feed-freshness display plumbing — no financial math; staleness definition reused verbatim from isArStale (collections gate unchanged)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Overview layout storage key bump — the new default applies to everyone (item 10)

**Files:**
- Modify: `src/brain/useWorkspaces.ts:13` (`KEY`), `:20-31` (`load`)
- Modify: `tests/unit/use-workspaces.test.ts:3-5` (imports / `KEY`) and append one test

**Interfaces:**
- Produces: `WORKSPACES_STORAGE_KEY = 'ora-overview-workspaces:v2'` and `LEGACY_WORKSPACES_KEYS: readonly string[] = ['ora-overview-workspaces']`, both exported. On first load the legacy keys are **removed and not migrated**. Gabriel accepted that saved custom layouts are discarded. The next forced reset bumps to `:v3` and appends `:v2` to the legacy list.

- [ ] **Step 1: Write the failing test.** In `tests/unit/use-workspaces.test.ts`, replace lines 3-5 (`import { useWorkspaces } …` and `const KEY = 'ora-overview-workspaces';`) with:

```ts
import { useWorkspaces, WORKSPACES_STORAGE_KEY as KEY, LEGACY_WORKSPACES_KEYS } from '../../src/brain/useWorkspaces';
```

Append inside the top-level `describe('useWorkspaces', …)`:

```ts
  const LEGACY_IDS = ['kpis', 'insights'];
  const LEGACY_HIDDEN = ['insights'];
  it('discards a layout saved under the legacy key: the new default applies and the old key is removed (ratified 2026-09-24)', () => {
    expect(KEY).toBe('ora-overview-workspaces:v2');
    expect(LEGACY_WORKSPACES_KEYS).toEqual(['ora-overview-workspaces']);
    // The pre-bump shape: a saved Default that SHOWS the Insights tier board.
    localStorage.setItem('ora-overview-workspaces', JSON.stringify({ workspaces: { Default: { order: ['kpis', 'insights'], hidden: [] } }, active: 'Default' }));
    const { result } = renderHook(() => useWorkspaces(LEGACY_IDS, LEGACY_HIDDEN));
    expect(result.current.visibleOrder).toEqual(['kpis']);
    expect(result.current.hiddenIds).toEqual(['insights']);
    expect(localStorage.getItem('ora-overview-workspaces')).toBeNull();
    expect(localStorage.getItem(KEY)).toContain('insights');
  });
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/use-workspaces.test.ts`. Expected: FAIL (no `WORKSPACES_STORAGE_KEY` export).
- [ ] **Step 3: Implement.** In `src/brain/useWorkspaces.ts`, replace line 13 (`const KEY = 'ora-overview-workspaces';`) with:

```ts
/** Versioned storage key. Bumped 2026-09-24 (Gabriel ratified): the new default Overview layout (full
 *  Insights tier board hidden) must apply to EVERYONE, so every layout saved under an older key is
 *  DISCARDED — deliberately not migrated. For the next forced reset: bump the suffix and append the
 *  current key to LEGACY_WORKSPACES_KEYS. */
export const WORKSPACES_STORAGE_KEY = 'ora-overview-workspaces:v2';
export const LEGACY_WORKSPACES_KEYS: readonly string[] = ['ora-overview-workspaces'];
const KEY = WORKSPACES_STORAGE_KEY;
```

In `load`, insert as the first statement inside the `try {`, before `const raw = …`:

```ts
    // Idempotent (StrictMode may call the initializer twice): drop superseded layouts, never migrate.
    for (const legacy of LEGACY_WORKSPACES_KEYS) localStorage.removeItem(legacy);
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/use-workspaces.test.ts tests/unit/overview-module-wiring.test.tsx tests/unit/overview-default-layout.test.ts && npm run lint`. Expected: PASS. `useWorkspaces.ts` is a `.ts` hook module, so exporting constants does not trip the react-refresh rule.
- [ ] **Step 5: Commit.**

```bash
git add src/brain/useWorkspaces.ts tests/unit/use-workspaces.test.ts
git commit -m "feat(overview): bump the layout storage key so the new default applies to everyone (saved layouts discarded — ratified 2026-09-24)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: Empty states — Obligations (Insurance / Taxes) and Lease Market when the warehouse has no data (item 12)

**Files:**
- Create: `src/primitives/EmptyState.tsx`, `src/lib/warehouse-empty.ts`
- Modify: `src/modules/insurance/SavingsBoard.tsx:59` (after `if (!report) return null;`)
- Modify: `src/modules/taxes/TaxesModule.tsx:90` (after `if (!report) return null;`)
- Modify: `src/modules/lease-market/LeaseMarketModule.tsx:357` (after `if (!data) return …`)
- Modify: `tests/unit/taxes-module.test.tsx:751,828,847,874,900` (non-empty seeds)
- Test: `tests/unit/warehouse-empty.test.ts` (create), `tests/unit/insurance-module.test.tsx`, `tests/unit/taxes-module.test.tsx`, `tests/unit/lease-market-module-smoke.test.tsx` (append one case each)

**Interfaces:**
- Produces:
  - `isInsuranceAnalysisEmpty(r: Pick<InsuranceAnalysisReport, 'policiesN'>): boolean`, true when `policiesN === 0`
  - `isTaxAnalysisEmpty(r: Pick<TaxAnalysisReport, 'assessments' | 'appeals' | 'opportunities' | 'ledgerTaxAnnualUsd'>): boolean`, true when all three arrays are empty **and** `ledgerTaxAnnualUsd === null`
  - `isLeaseMarketEmpty(s: Pick<LeaseMarketSummaryResponse, 'kpis' | 'freshness'>): boolean`, true when `kpis.activeSpaces === 0` **and** every market's `lastLandingDate === null` (nothing has ever been ingested)
  - `EMPTY_COPY`: `{ insurance, taxes, leaseMarket }`, each `{ title, message, detail, command }`
  - `<EmptyState title message detail? command? />` (component only)
- The offline (mirror), loading and error states are unchanged. These empty states apply only to a **successfully loaded, empty** report.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/warehouse-empty.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isInsuranceAnalysisEmpty, isTaxAnalysisEmpty, isLeaseMarketEmpty } from '../../src/lib/warehouse-empty';

describe('warehouse-empty predicates', () => {
  it('insurance: empty iff no policies', () => {
    expect(isInsuranceAnalysisEmpty({ policiesN: 0 })).toBe(true);
    expect(isInsuranceAnalysisEmpty({ policiesN: 3 })).toBe(false);
  });
  it('taxes: empty iff no assessments/appeals/opportunities AND no ledger tax', () => {
    expect(isTaxAnalysisEmpty({ assessments: [], appeals: [], opportunities: [], ledgerTaxAnnualUsd: null })).toBe(true);
    expect(isTaxAnalysisEmpty({ assessments: [], appeals: [], opportunities: [], ledgerTaxAnnualUsd: 120_000 })).toBe(false);
    expect(isTaxAnalysisEmpty({ assessments: [{}] as never, appeals: [], opportunities: [], ledgerTaxAnnualUsd: null })).toBe(false);
  });
  it('lease market: empty iff no active spaces AND nothing ever landed', () => {
    const f = (lastLandingDate: string | null) => ({ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate, lastCompleteDate: null, lastCompleteness: null, partialReason: null, stale: false });
    const k = (activeSpaces: number) => ({ marketsFresh: 0, marketsEnabled: 1, activeSpaces, newInLatest: 0, priceCutsInLatest: 0, stale: 0, radarCandidates: 0 });
    expect(isLeaseMarketEmpty({ kpis: k(0), freshness: [f(null)] })).toBe(true);
    expect(isLeaseMarketEmpty({ kpis: k(0), freshness: [f('2026-09-01')] })).toBe(false); // ingested, compute pending — existing notice covers it
    expect(isLeaseMarketEmpty({ kpis: k(13), freshness: [f(null)] })).toBe(false);
  });
});
```

Append to `tests/unit/insurance-module.test.tsx`, inside `describe('SavingsBoard tiers', …)`:

```tsx
  it('a loaded but EMPTY analysis (no policies in the warehouse) renders the empty state, not a blank board', () => {
    const empty: InsuranceAnalysisReport = { ...insufficientReport(), premiumAnnualTotal: 0, policiesN: 0, tivKnownN: 0, rebidCandidates: [], renewalCalendar: [] };
    render(
      <QueryClientProvider client={seededClient(empty)}>
        <SavingsBoard />
      </QueryClientProvider>,
    );
    expect(screen.getByText('No insurance policies in the warehouse yet.')).toBeTruthy();
    expect(screen.getByText('npx tsx scripts/import-insurance-data.ts --policies <policies.json>')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Tier board' })).toBeNull();
  });
```

In `tests/unit/taxes-module.test.tsx`, add below `makeReport` (line 116):

```ts
/** A report with SOME data — TaxesModule renders its KPI strip + views only when the warehouse is not empty. */
const NON_EMPTY: Partial<TaxAnalysisReport> = { ledgerTaxAnnualUsd: 120_000 };
```

Change `makeReport()` to `makeReport(NON_EMPTY)` at lines 751, 828, 847, 874 and 900, the five call sites that seed an otherwise-empty report into a rendered `TaxesModule`. Then append:

```tsx
describe('TaxesModule — empty warehouse', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('a loaded but EMPTY tax analysis renders the empty state with the import command', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const qc = seededClient();
    qc.setQueryData(TAX_KEYS.analysis, makeReport());
    qc.setQueryData(TAX_STRATEGY_KEY, makeStrategyReport());
    renderTaxes(qc);
    expect(screen.getByText('No property-tax data in the warehouse yet.')).toBeTruthy();
    expect(screen.getByText('npx tsx scripts/import-assessments.ts <assessments.csv>')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Taxes views' })).toBeNull();
  });
});
```

Append to `tests/unit/lease-market-module-smoke.test.tsx`, inside `describe('LeaseMarketModule', …)`:

```tsx
  it('never-ingested warehouse renders the empty state with the ingest+compute command', () => {
    renderWith({
      ...SUMMARY,
      lastComputedAt: null,
      kpis: { marketsFresh: 0, marketsEnabled: 1, activeSpaces: 0, newInLatest: 0, priceCutsInLatest: 0, stale: 0, radarCandidates: 0 },
      freshness: [{ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate: null, lastCompleteDate: null, lastCompleteness: null, partialReason: null, stale: false }],
      curve: [], domByMarket: [], benchmarks: [],
    });
    expect(screen.getByText('No CoStar exports have been ingested yet.')).toBeTruthy();
    expect(screen.getByText('npm run lease-market:ingest && npm run lease-market:compute')).toBeTruthy();
  });
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/warehouse-empty.test.ts tests/unit/insurance-module.test.tsx tests/unit/taxes-module.test.tsx tests/unit/lease-market-module-smoke.test.tsx`. Expected: FAIL (module missing; empty-state text absent).
- [ ] **Step 3: Implement.** Create `src/lib/warehouse-empty.ts`:

```ts
// src/lib/warehouse-empty.ts
//
// "Loaded, but the warehouse has nothing yet" predicates + copy (item 12, 2026-09-24). Distinct from the
// offline (static mirror → WarehouseUnavailableError) and error states, which each module already
// renders; these fire only on a SUCCESSFUL, EMPTY report, where the modules used to render a blank body.
import type { InsuranceAnalysisReport } from '@contracts/insurance-analysis';
import type { TaxAnalysisReport } from '@contracts/tax';
import type { LeaseMarketSummaryResponse } from '@contracts/lease-market';

export function isInsuranceAnalysisEmpty(r: Pick<InsuranceAnalysisReport, 'policiesN'>): boolean {
  return r.policiesN === 0;
}

export function isTaxAnalysisEmpty(
  r: Pick<TaxAnalysisReport, 'assessments' | 'appeals' | 'opportunities' | 'ledgerTaxAnnualUsd'>,
): boolean {
  return r.assessments.length === 0 && r.appeals.length === 0 && r.opportunities.length === 0 && r.ledgerTaxAnnualUsd === null;
}

/** Nothing ever ingested. Ingested-but-not-computed keeps LeaseMarketModule's existing compute notice. */
export function isLeaseMarketEmpty(s: Pick<LeaseMarketSummaryResponse, 'kpis' | 'freshness'>): boolean {
  return s.kpis.activeSpaces === 0 && s.freshness.every((f) => f.lastLandingDate === null);
}

export const EMPTY_COPY = {
  insurance: {
    title: 'Savings Board',
    message: 'No insurance policies in the warehouse yet.',
    detail: 'Re-bid candidates, the renewal watch and the own-book benchmark are computed from policy terms in the warehouse. Import the policy/premium history (and dec pages for TIV), then reload.',
    command: 'npx tsx scripts/import-insurance-data.ts --policies <policies.json>',
  },
  taxes: {
    title: 'Taxes',
    message: 'No property-tax data in the warehouse yet.',
    detail: 'Assessments, appeals and opportunities need assessment rows (template: docs/templates/property-tax-assessments.template.csv) or ledger Taxes rows.',
    command: 'npx tsx scripts/import-assessments.ts <assessments.csv>',
  },
  leaseMarket: {
    title: 'Lease Market',
    message: 'No CoStar exports have been ingested yet.',
    detail: 'Drop the CoStar exports in the lease-market intake folder, ingest them, then compute the signals.',
    command: 'npm run lease-market:ingest && npm run lease-market:compute',
  },
} as const;
```

Create `src/primitives/EmptyState.tsx`:

```tsx
// src/primitives/EmptyState.tsx — a loaded-but-empty module body: what is missing and the command that fills it.
import { Card, CardHeader } from './Card';
import { Badge } from './Badge';

export interface EmptyStateProps {
  title: string;
  message: string;
  detail?: string;
  command?: string;
}

export function EmptyState({ title, message, detail, command }: EmptyStateProps) {
  return (
    <Card>
      <CardHeader title={title} trailing={<Badge tone="neutral">no data</Badge>} />
      <div role="status" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</div>
        {detail && <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 460 }}>{detail}</div>}
        {command && <code className="num text-2xs" style={{ color: 'var(--text-primary)' }}>{command}</code>}
      </div>
    </Card>
  );
}
```

`SavingsBoard.tsx`: import `EmptyState` from `'@/primitives/EmptyState'` and `EMPTY_COPY, isInsuranceAnalysisEmpty` from `'@/lib/warehouse-empty'`. After `if (!report) return null;` add:

```tsx
  if (isInsuranceAnalysisEmpty(report)) return <EmptyState {...EMPTY_COPY.insurance} />;
```

`TaxesModule.tsx`: the same imports. After `if (!report) return null;` add:

```tsx
  if (isTaxAnalysisEmpty(report)) return <EmptyState {...EMPTY_COPY.taxes} />;
```

`LeaseMarketModule.tsx`: the same imports. After `if (!data) return <Card>…</Card>;` add:

```tsx
  if (isLeaseMarketEmpty(data)) return <EmptyState {...EMPTY_COPY.leaseMarket} />;
```

All three hooks are called above these early returns, so hook order is unchanged. In `LeaseMarketModule`, `useMemo` for `points` runs before `if (summary.isLoading)`.
- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/warehouse-empty.test.ts tests/unit/insurance-module.test.tsx tests/unit/taxes-module.test.tsx tests/unit/lease-market-module-smoke.test.tsx tests/unit/obligations-destination.test.tsx && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/primitives/EmptyState.tsx src/lib/warehouse-empty.ts src/modules/insurance/SavingsBoard.tsx src/modules/taxes/TaxesModule.tsx src/modules/lease-market/LeaseMarketModule.tsx tests/unit/warehouse-empty.test.ts tests/unit/insurance-module.test.tsx tests/unit/taxes-module.test.tsx tests/unit/lease-market-module-smoke.test.tsx
git commit -m "feat(ux): empty states for Insurance, Taxes and Lease Market when the warehouse has no data" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR C close-out:**
- [ ] Rebase onto PR B's head (or `origin/main`), then `npm run gate` and `npx tsx scripts/check-refute-required.ts`.
- [ ] Live check against the running dev server (`/api/health`). The AR row reads `7 leases with stale AR · 34d old` on 2026-09-24, and tomorrow's date shifts the age. Open Overview with a pre-seeded legacy `ora-overview-workspaces` localStorage entry and confirm the Insights board is hidden. Open Obligations › Insurance/Taxes and Lease Market against an empty temp warehouse (`WAREHOUSE_DB=<tmp>`) to see the three empty states. Take screenshots, light and dark, at 1440 and 375.
- [ ] `git push -u origin fix/cc-r2-c-freshness-ux`. Open PR `fix(cc): AR freshness, Overview layout reset, warehouse empty states (round 2 · C)`. The body starts `Base branch: fix/cc-r2-b-residence-alerts. Merge PR B first.`
- [ ] Review: code-reviewer pass (`pr-review-toolkit:review-pr`). `server/index.ts` is architect-owned, so note Gabriel's ack in the body.

---

## PR D — Cold start: document index off the main thread (item 11)

Branch: `git switch -c fix/cc-r2-d-doc-index-worker origin/main`. It shares no files with A–C.

**Why this is non-trivial.** `loadDiskIndex` (`server/sources/documents.ts:262-280`) opens a ~179 MB sqlite-vec file with synchronous better-sqlite3 and reads **every** chunk's text into memory. `server/startup.ts` only defers that one macrotask, so the event loop still freezes. The load took about 7 minutes on a cold, AV-scanned start (2026-09-23 review), and `/api/health` hangs for that whole window. The returned `VecIndex` holds a live `db` handle that `queryIndex` uses for every search (`documents.ts:369-390`). A better-sqlite3 handle cannot cross threads, so moving the load also moves every query.

**Design.** A dedicated worker thread owns the database for the life of the process. The main thread keeps what must stay there: the transformers.js embedder, which is async and already off the hot path, and the `DocHit` shaping (`condense`, score). They talk over a small typed protocol (`load` → `opened` + `loaded`; `knn` → `knn-result`/`knn-error`; `close`). A side effect of the protocol is that the worker no longer holds all chunk text in memory. It reads the ≤ `limit` hit rows by `rowid` per query, which is also more correct than the old `chunks[rowid]` array-index assumption. The same protocol runs in-process behind `DOC_INDEX_WORKER=0`. That is the rollback switch, and it is also how vitest exercises the whole path: vitest's fork workers cannot load a `.ts` Worker entry, while tsx-launched processes can. The smoke script in Task 19 proves the real-worker path.

**Complexity.** Three tasks, about 350 lines of new code plus tests. The main risk is the tsx worker spawn (execArgv inheritance). Task 19 Step 5 validates it first on a fixture, and Step 6 carries the fallback.

### Task 18: Doc-index protocol + worker-side core (parity with the in-process path)

**Files:**
- Create: `server/sources/doc-index-protocol.ts`, `server/sources/doc-index-core.ts`
- Test: `tests/unit/doc-index-core.test.ts`

**Interfaces:**
- Produces:
  - Types: `DocIndexInfo { docs: Array<{ name: string; chunks: number }>; chunkCount: number; builtAt: string; dim: number }`, `KnnRow { chunk: DocChunk; distance: number }`, `DocIndexRequest`, `DocIndexResponse`.
  - `readBuiltAt(db): string`, `readIndexInfo(db): DocIndexInfo`, `knn(db, vector: Float32Array, limit: number): KnnRow[]`.
  - `createDocIndexHandler(): { handle(msg: DocIndexRequest, emit: (r: DocIndexResponse) => void): void; close(): void }`. The db is opened `{ readonly: true, fileMustExist: true }`, so a missing file is a `load-error` and never a newly created empty DB.

- [ ] **Step 1: Write the failing test.** Create `tests/unit/doc-index-core.test.ts`:

```ts
// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, embedMissing, loadDiskIndex, queryIndex, writeChunkPlan, type DocChunk, type Embedder } from '../../server/sources/documents';
import { createDocIndexHandler, knn, readIndexInfo, type DocIndexHandler } from '../../server/sources/doc-index-core';
import type { DocIndexRequest, DocIndexResponse, KnnRow } from '../../server/sources/doc-index-protocol';

// Same deterministic 3-dim fake embedder + corpus as tests/unit/documents.test.ts.
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([l.includes('renew') ? 1 : 0, l.includes('roof') ? 1 : 0, l.includes('rent') ? 1 : 0]);
  });
const CHUNKS: DocChunk[] = [
  { docId: 'tenant 155 llc', docName: 'Tenant 155 LLC Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function tempRoot(): string { const r = mkdtempSync(join(tmpdir(), 'dicore-')); roots.push(r); return r; }
async function diskIndex(): Promise<string> {
  const p = join(tempRoot(), 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  return p;
}
function openRo(p: string) { const db = new Database(p, { readonly: true, fileMustExist: true }); sqliteVec.load(db); return db; }
function run(h: DocIndexHandler, msg: DocIndexRequest): DocIndexResponse[] { const out: DocIndexResponse[] = []; h.handle(msg, (r) => out.push(r)); return out; }
const rowsOf = (r: DocIndexResponse | undefined): KnnRow[] => (r && r.type === 'knn-result' ? r.rows : []);

describe('doc-index-core — worker-side ops match the in-process path', () => {
  it('readIndexInfo equals loadDiskIndex docs / chunk count / builtAt', async () => {
    const p = await diskIndex();
    const legacy = loadDiskIndex(p);
    const db = openRo(p);
    try {
      const info = readIndexInfo(db);
      expect(info.docs).toEqual(legacy.docs);
      expect(info.chunkCount).toBe(legacy.index.chunks.length);
      expect(info.builtAt).toBe(legacy.builtAt);
      expect(info.dim).toBe(3);
    } finally { db.close(); legacy.index.close(); }
  });

  it('knn returns the same ranking as queryIndex', async () => {
    const p = await diskIndex();
    const legacy = loadDiskIndex(p);
    const db = openRo(p);
    try {
      const [qv] = await fakeEmbedder(['renewal']);
      const rows = knn(db, qv!, 3);
      const hits = await queryIndex(legacy.index, 'renewal', fakeEmbedder, 3);
      expect(rows.map((r) => r.chunk.docName)).toEqual(hits.map((h) => h.doc));
      expect(rows[0]!.chunk).toEqual(CHUNKS[0]);
    } finally { db.close(); legacy.index.close(); }
  });

  it('handler: knn before load → knn-error; load → opened then loaded; knn → knn-result; close is idempotent', async () => {
    const p = await diskIndex();
    const h = createDocIndexHandler();
    const [qv] = await fakeEmbedder(['roof']);
    expect(run(h, { type: 'knn', id: 1, vector: qv!, limit: 3 })).toEqual([{ type: 'knn-error', id: 1, message: 'index not loaded' }]);
    expect(run(h, { type: 'load', dbPath: p }).map((r) => r.type)).toEqual(['opened', 'loaded']);
    const [res] = run(h, { type: 'knn', id: 2, vector: qv!, limit: 1 });
    expect(res).toMatchObject({ type: 'knn-result', id: 2 });
    expect(rowsOf(res)[0]!.chunk.docName).toBe('Roof Warranty.pdf');
    expect(run(h, { type: 'close' })).toEqual([]);
    h.close();
  });

  it('a missing file is a load-error and is never created', () => {
    const missing = join(tempRoot(), 'nope.sqlite');
    const res = run(createDocIndexHandler(), { type: 'load', dbPath: missing });
    expect(res.map((r) => r.type)).toEqual(['load-error']);
    expect(existsSync(missing)).toBe(false);
  });

  it('a partially-embedded (resumable) index counts every planned chunk and only returns embedded ones', async () => {
    const p = join(tempRoot(), 'doc-index.sqlite');
    writeChunkPlan(p, CHUNKS, 3);
    await embedMissing(p, fakeEmbedder, { batchSize: 1, limit: 2 }); // Tenant 155 LLC + Roof embedded; Rent planned only
    const h = createDocIndexHandler();
    const loaded = run(h, { type: 'load', dbPath: p })[1];
    expect(loaded).toMatchObject({ type: 'loaded', info: { chunkCount: 3 } });
    const [qv] = await fakeEmbedder(['rent']);
    expect(rowsOf(run(h, { type: 'knn', id: 1, vector: qv!, limit: 3 })[0]).map((r) => r.chunk.docName).sort()).toEqual(['Tenant 155 LLC Lease.pdf', 'Roof Warranty.pdf']);
    h.close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/doc-index-core.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Create `server/sources/doc-index-protocol.ts`:

```ts
// server/sources/doc-index-protocol.ts — messages between the main thread and the doc-index worker
// (item 11, 2026-09-24). The worker owns the sqlite-vec handle; the main thread embeds and shapes hits.
import type { DocChunk } from './documents';

export interface DocIndexInfo {
  docs: Array<{ name: string; chunks: number }>;
  chunkCount: number;
  builtAt: string;
  dim: number;
}

export interface KnnRow {
  chunk: DocChunk;
  distance: number;
}

export type DocIndexRequest =
  | { type: 'load'; dbPath: string }
  | { type: 'knn'; id: number; vector: Float32Array; limit: number }
  | { type: 'close' };

export type DocIndexResponse =
  | { type: 'opened'; builtAt: string }
  | { type: 'loaded'; info: DocIndexInfo }
  | { type: 'load-error'; message: string }
  | { type: 'knn-result'; id: number; rows: KnnRow[] }
  | { type: 'knn-error'; id: number; message: string };
```

Create `server/sources/doc-index-core.ts`:

```ts
// server/sources/doc-index-core.ts
//
// Worker-side document-index operations (item 11, 2026-09-24). Runs inside the doc-index worker thread
// (doc-index-worker.ts) — or in-process behind DOC_INDEX_WORKER=0 / in tests — and is the ONLY code that
// touches the on-disk sqlite-vec file on the server path. Opened read-only + fileMustExist: serving never
// writes the index and never creates an empty one. Unlike the legacy loadDiskIndex it does not hold every
// chunk's text in memory: a query reads just its ≤ limit hit rows by rowid (also more correct than the
// old chunks[rowid] array-index assumption).
import Database, { type Database as BetterSQLite3Database } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { DocIndexInfo, DocIndexRequest, DocIndexResponse, KnnRow } from './doc-index-protocol';

const EMBED_DIM_DEFAULT = 384; // all-MiniLM-L6-v2 — same default as documents.ts
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function readBuiltAt(db: BetterSQLite3Database): string {
  const row = db.prepare(`SELECT v FROM index_info WHERE k = 'builtAt'`).get() as { v: string } | undefined;
  return row?.v ?? '';
}

/** Per-document chunk counts in first-appearance (rowid) order — identical to loadDiskIndex's `docs`. */
export function readIndexInfo(db: BetterSQLite3Database): DocIndexInfo {
  const docs = db
    .prepare('SELECT docName AS name, COUNT(*) AS chunks FROM chunk_meta GROUP BY docName ORDER BY MIN(rowid)')
    .all() as Array<{ name: string; chunks: number }>;
  const dimRow = db.prepare(`SELECT v FROM index_info WHERE k = 'dim'`).get() as { v: string } | undefined;
  return {
    docs,
    chunkCount: docs.reduce((n, d) => n + d.chunks, 0),
    builtAt: readBuiltAt(db),
    dim: Number(dimRow?.v ?? EMBED_DIM_DEFAULT),
  };
}

/** Nearest neighbours → chunk + distance, closest first. Planned-but-unembedded chunks never match. */
export function knn(db: BetterSQLite3Database, vector: Float32Array, limit: number): KnnRow[] {
  const hits = db
    .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(vector, limit) as Array<{ rowid: bigint | number; distance: number }>;
  const meta = db.prepare('SELECT docId, docName, idx, text FROM chunk_meta WHERE rowid = ?');
  const out: KnnRow[] = [];
  for (const h of hits) {
    const m = meta.get(Number(h.rowid)) as { docId: string; docName: string; idx: number; text: string } | undefined;
    if (m) out.push({ chunk: { docId: m.docId, docName: m.docName, idx: m.idx, text: m.text }, distance: h.distance });
  }
  return out;
}

export interface DocIndexHandler {
  /** `emit` is called as soon as each response is ready — the worker posts `opened` BEFORE the
   *  chunk-count scan, so /api/health can report the build time during a cold load. */
  handle(msg: DocIndexRequest, emit: (res: DocIndexResponse) => void): void;
  close(): void;
}

export function createDocIndexHandler(): DocIndexHandler {
  let db: BetterSQLite3Database | null = null;
  const close = (): void => {
    db?.close();
    db = null;
  };
  return {
    handle(msg, emit) {
      switch (msg.type) {
        case 'load': {
          close();
          try {
            const next = new Database(msg.dbPath, { readonly: true, fileMustExist: true });
            try {
              sqliteVec.load(next);
            } catch (e) {
              next.close();
              throw e;
            }
            db = next;
            emit({ type: 'opened', builtAt: readBuiltAt(next) });
            emit({ type: 'loaded', info: readIndexInfo(next) });
          } catch (e) {
            close();
            emit({ type: 'load-error', message: errMsg(e) });
          }
          return;
        }
        case 'knn': {
          if (!db) {
            emit({ type: 'knn-error', id: msg.id, message: 'index not loaded' });
            return;
          }
          try {
            emit({ type: 'knn-result', id: msg.id, rows: knn(db, msg.vector, msg.limit) });
          } catch (e) {
            emit({ type: 'knn-error', id: msg.id, message: errMsg(e) });
          }
          return;
        }
        case 'close':
          close();
          return;
      }
    },
    close,
  };
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/doc-index-core.test.ts tests/unit/documents.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add server/sources/doc-index-protocol.ts server/sources/doc-index-core.ts tests/unit/doc-index-core.test.ts
git commit -m "feat(docs): worker-side document-index core + message protocol (parity with the in-process path)" -m "Refute-Skip: document-search transport plumbing — no deal, financial or alert logic (documents.ts is already on the refute exemption list for the same reason)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Worker entry, transports and `DocIndexClient` — plus a real-worker smoke

**Files:**
- Create: `server/sources/doc-index-worker.ts`, `server/sources/doc-index-client.ts`, `scripts/doc-index-worker-smoke.ts`
- Test: `tests/unit/doc-index-client.test.ts`

**Interfaces:**
- Consumes: `createDocIndexHandler` and the protocol (Task 18).
- Produces:
  - `interface DocIndexTransport { send(msg: DocIndexRequest): void; onMessage(cb: (msg: DocIndexResponse) => void): void; onFailure(cb: (err: Error) => void): void; terminate(): Promise<void> }`
  - `workerTransport(): DocIndexTransport`, which spawns `doc-index-worker.ts`
  - `inProcessDocIndexTransport(): DocIndexTransport & { readonly handled: number }`, the same protocol on the main thread and deferred with `setImmediate`
  - `class DocIndexClient { static start(dbPath: string, transport?: DocIndexTransport): DocIndexClient; readonly ready: Promise<DocIndexInfo>; get builtAt(): string | null; get info(): DocIndexInfo | null; knn(vector: Float32Array, limit: number): Promise<KnnRow[]>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test.** Create `tests/unit/doc-index-client.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex, type DocChunk, type Embedder } from '../../server/sources/documents';
import { DocIndexClient, inProcessDocIndexTransport, type DocIndexTransport } from '../../server/sources/doc-index-client';
import type { DocIndexResponse } from '../../server/sources/doc-index-protocol';

const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([l.includes('renew') ? 1 : 0, l.includes('roof') ? 1 : 0, l.includes('rent') ? 1 : 0]);
  });
const CHUNKS: DocChunk[] = [
  { docId: 'tenant 155 llc', docName: 'Tenant 155 LLC Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];
const roots: string[] = [];
const clients: DocIndexClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function diskIndex(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'diclient-')); roots.push(root);
  const p = join(root, 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  return p;
}

describe('DocIndexClient over the in-process transport (the vitest-reachable path; the worker path is proven by scripts/doc-index-worker-smoke.ts)', () => {
  it('start() does no index work synchronously; ready resolves after exactly one handled message', async () => {
    const p = await diskIndex();
    const t = inProcessDocIndexTransport();
    const c = DocIndexClient.start(p, t); clients.push(c);
    expect(t.handled).toBe(0); // counted, not timed (memory: no-wallclock-assertions-in-tests)
    expect(c.info).toBeNull();
    const info = await c.ready;
    expect(t.handled).toBe(1);
    expect(info.chunkCount).toBe(3);
    expect(info.docs.map((d) => d.name)).toEqual(['Tenant 155 LLC Lease.pdf', 'Roof Warranty.pdf', 'Rent Schedule.pdf']);
    expect(c.builtAt).toBe(info.builtAt);
  });

  it('knn resolves the nearest chunk', async () => {
    const p = await diskIndex();
    const c = DocIndexClient.start(p, inProcessDocIndexTransport()); clients.push(c);
    const [qv] = await fakeEmbedder(['renewal']);
    const rows = await c.knn(qv!, 3);
    expect(rows[0]!.chunk.docId).toBe('tenant 155 llc');
  });

  it('a load failure rejects ready and every later knn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diclient-missing-')); roots.push(root);
    const c = DocIndexClient.start(join(root, 'nope.sqlite'), inProcessDocIndexTransport()); clients.push(c);
    await expect(c.ready).rejects.toThrow(/doc index load failed/);
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow(/doc index load failed/);
  });

  it('a transport failure rejects in-flight queries (a crashed worker never hangs a request)', async () => {
    let onMsg: ((m: DocIndexResponse) => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    const t: DocIndexTransport = {
      send: (msg) => {
        if (msg.type === 'load') setImmediate(() => onMsg?.({ type: 'loaded', info: { docs: [], chunkCount: 1, builtAt: 'x', dim: 3 } }));
        // knn: never answered — simulate the worker dying mid-query
        if (msg.type === 'knn') setImmediate(() => onFail?.(new Error('doc-index worker exited (code 1)')));
      },
      onMessage: (cb) => { onMsg = cb; },
      onFailure: (cb) => { onFail = cb; },
      terminate: async () => undefined,
    };
    const c = DocIndexClient.start('ignored', t); clients.push(c);
    await c.ready;
    await expect(c.knn(new Float32Array([1, 0, 0]), 3)).rejects.toThrow('doc-index worker exited (code 1)');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run tests/unit/doc-index-client.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `server/sources/doc-index-worker.ts`:

```ts
// server/sources/doc-index-worker.ts — worker-thread entry for the document index (item 11, 2026-09-24).
// Spawned by workerTransport() (doc-index-client.ts). Owns the sqlite-vec handle for the process lifetime
// so no synchronous index I/O ever runs on the HTTP server's event loop.
import { parentPort } from 'node:worker_threads';
import { createDocIndexHandler } from './doc-index-core';
import type { DocIndexRequest } from './doc-index-protocol';

const port = parentPort;
if (!port) throw new Error('doc-index-worker.ts must run as a worker thread (see doc-index-client.ts)');
const handler = createDocIndexHandler();
port.on('message', (msg: DocIndexRequest) => {
  handler.handle(msg, (res) => port.postMessage(res));
  if (msg.type === 'close') port.close();
});
```

Create `server/sources/doc-index-client.ts`:

```ts
// server/sources/doc-index-client.ts
//
// Main-thread side of the document index (item 11, 2026-09-24). DocIndexClient speaks the doc-index
// protocol over a transport: workerTransport() (default — a worker thread owns the sqlite-vec handle, so
// a cold ~179 MB load never blocks /api/health) or inProcessDocIndexTransport() (DOC_INDEX_WORKER=0
// rollback switch, and the vitest path — vitest's fork workers cannot load a .ts Worker entry). The
// in-process transport runs the SAME handler on the main thread, deferred by setImmediate: behaviourally
// the pre-2026-09-24 path (it blocks the loop while it works), kept deliberately as the escape hatch.
import { Worker } from 'node:worker_threads';
import { createDocIndexHandler } from './doc-index-core';
import type { DocIndexInfo, DocIndexRequest, DocIndexResponse, KnnRow } from './doc-index-protocol';

export interface DocIndexTransport {
  send(msg: DocIndexRequest): void;
  onMessage(cb: (msg: DocIndexResponse) => void): void;
  /** A worker 'error' or 'exit' — every in-flight and future query must reject, never hang. */
  onFailure(cb: (err: Error) => void): void;
  terminate(): Promise<void>;
}

export function workerTransport(): DocIndexTransport {
  // Under tsx the worker inherits the parent's execArgv (tsx's loader), so a .ts entry resolves.
  const w = new Worker(new URL('./doc-index-worker.ts', import.meta.url));
  return {
    send: (msg) => w.postMessage(msg),
    onMessage: (cb) => {
      w.on('message', cb);
    },
    onFailure: (cb) => {
      w.on('error', cb);
      w.on('exit', (code) => cb(new Error(`doc-index worker exited (code ${code})`)));
    },
    terminate: async () => {
      await w.terminate();
    },
  };
}

export function inProcessDocIndexTransport(): DocIndexTransport & { readonly handled: number } {
  const handler = createDocIndexHandler();
  let onMsg: ((m: DocIndexResponse) => void) | null = null;
  let onFail: ((e: Error) => void) | null = null;
  let handled = 0;
  return {
    get handled() {
      return handled;
    },
    send(msg) {
      setImmediate(() => {
        handled += 1;
        handler.handle(msg, (res) => onMsg?.(res));
      });
    },
    onMessage(cb) {
      onMsg = cb;
    },
    onFailure(cb) {
      onFail = cb;
    },
    async terminate() {
      handler.close(); // synchronous: the file handle is released before this call returns
      onFail?.(new Error('doc-index transport terminated'));
    },
  };
}

type Pending = { resolve: (rows: KnnRow[]) => void; reject: (err: Error) => void };

export class DocIndexClient {
  readonly ready: Promise<DocIndexInfo>;
  private readonly transport: DocIndexTransport;
  private builtAtValue: string | null = null;
  private infoValue: DocIndexInfo | null = null;
  private failure: Error | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(transport: DocIndexTransport, dbPath: string) {
    this.transport = transport;
    let resolveReady: ((info: DocIndexInfo) => void) | null = null;
    let rejectReady: ((err: Error) => void) | null = null;
    this.ready = new Promise<DocIndexInfo>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Callers await `ready`; this only stops an early failure being reported as unhandled before one attaches.
    this.ready.catch(() => undefined);
    transport.onMessage((m) => {
      switch (m.type) {
        case 'opened':
          this.builtAtValue = m.builtAt || null;
          break;
        case 'loaded':
          this.infoValue = m.info;
          this.builtAtValue = m.info.builtAt || null;
          resolveReady?.(m.info);
          break;
        case 'load-error': {
          const err = new Error(`doc index load failed: ${m.message}`);
          this.fail(err);
          rejectReady?.(err);
          break;
        }
        case 'knn-result':
          this.settle(m.id, (p) => p.resolve(m.rows));
          break;
        case 'knn-error':
          this.settle(m.id, (p) => p.reject(new Error(m.message)));
          break;
      }
    });
    transport.onFailure((err) => {
      this.fail(err);
      rejectReady?.(err);
    });
    transport.send({ type: 'load', dbPath });
  }

  static start(dbPath: string, transport: DocIndexTransport = workerTransport()): DocIndexClient {
    return new DocIndexClient(transport, dbPath);
  }

  /** Build time as soon as the worker has opened the file (before the chunk-count scan finishes). */
  get builtAt(): string | null {
    return this.builtAtValue;
  }

  get info(): DocIndexInfo | null {
    return this.infoValue;
  }

  async knn(vector: Float32Array, limit: number): Promise<KnnRow[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    return new Promise<KnnRow[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ type: 'knn', id, vector, limit });
    });
  }

  async close(): Promise<void> {
    this.transport.send({ type: 'close' });
    await this.transport.terminate();
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    fn(p);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
```

Create `scripts/doc-index-worker-smoke.ts`:

```ts
// scripts/doc-index-worker-smoke.ts — proves the REAL worker-thread path under tsx and measures the main
// thread's worst stall while the index loads (item 11). Not part of the gate (spawns a thread, touches disk).
//   npx tsx scripts/doc-index-worker-smoke.ts --fixture       # temp 3-chunk index (always available)
//   npx tsx scripts/doc-index-worker-smoke.ts [path]          # a real index (default: docIndexPath())
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DocIndexClient } from '../server/sources/doc-index-client';
import { buildIndex, docIndexPath, type Embedder } from '../server/sources/documents';

const fixture = process.argv.includes('--fixture');
let cleanup: string | null = null;
let path = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? docIndexPath();
if (fixture) {
  cleanup = mkdtempSync(join(tmpdir(), 'doc-index-smoke-'));
  path = join(cleanup, 'doc-index.sqlite');
  const embed: Embedder = async (texts) => texts.map((t) => new Float32Array([t.length % 2, 1, 0]));
  (await buildIndex([{ docId: 'a', docName: 'A.pdf', idx: 0, text: 'alpha' }, { docId: 'b', docName: 'B.pdf', idx: 0, text: 'beta!' }], embed, { dbPath: path })).close();
}

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const t0 = Date.now();
const client = DocIndexClient.start(path);
try {
  const info = await client.ready;
  lag.disable();
  const rows = await client.knn(new Float32Array(Array.from({ length: info.dim }, (_, i) => (i === 0 ? 1 : 0))), 1);
  console.log(JSON.stringify({ path, documents: info.docs.length, chunks: info.chunkCount, builtAt: info.builtAt, firstHit: rows[0]?.chunk.docName ?? null, loadMs: Date.now() - t0, maxMainThreadStallMs: Math.round(lag.max / 1e6) }));
} finally {
  await client.close();
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run the unit tests.** Run: `npx vitest run tests/unit/doc-index-client.test.ts && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Prove the real worker spawns under tsx.** Run: `npx tsx scripts/doc-index-worker-smoke.ts --fixture`. Expected: one JSON line with `"documents":2`, `"chunks":2`, and `firstHit` non-null. `maxMainThreadStallMs` should be well under 100.
- [ ] **Step 6: Fallback, only if Step 5 fails with `ERR_UNKNOWN_FILE_EXTENSION` or a module-resolution error from the worker.** This means tsx's loader did not reach the worker. In `workerTransport()`, construct the worker as `new Worker(new URL('./doc-index-worker.ts', import.meta.url), { execArgv: [...process.execArgv, '--import', 'tsx'] })`. Update the comment to say why, and rerun Step 5. If it still fails, stop and report. Do not proceed to Task 20 with a worker that cannot spawn.
- [ ] **Step 7: Real-index measurement.** Run: `npx tsx scripts/doc-index-worker-smoke.ts C:/Users/Owner/oxford-command-center/data/doc-index.sqlite`. This is the main checkout's index, opened read-only. If it doesn't exist, record "no real index on this machine" and skip. Expected: `maxMainThreadStallMs` stays in the tens of ms even when `loadMs` is large. Paste the line into the PR D body.
- [ ] **Step 8: Commit.**

```bash
git add server/sources/doc-index-worker.ts server/sources/doc-index-client.ts scripts/doc-index-worker-smoke.ts tests/unit/doc-index-client.test.ts
git commit -m "feat(docs): DocIndexClient over a worker-thread transport (in-process transport as rollback + test path)" -m "Refute-Skip: document-search transport plumbing and a diagnostic script — no deal, financial or alert logic" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: Wire `documents.ts` to the client — `/api/health` stays responsive during a cold load

**Files:**
- Modify: `server/sources/documents.ts` (`queryIndex` → `shapeHits`; cache type; `buildDocIndex`; `ensureIndex`; `warmDocIndex`; `searchDocuments`; `docStatus`; `docIndexBuiltAt`; `resetDocCacheForTests`; new `setDocIndexTransportForTests`)
- Modify: `server/startup.ts:9-13` (comment only)
- Modify: `tests/unit/doc-index-freshness.test.ts` (inject the in-process transport)
- Test: `tests/unit/doc-index-wiring.test.ts` (create)

**Interfaces:**
- Consumes: `DocIndexClient`, `workerTransport`, `inProcessDocIndexTransport`, `DocIndexTransport` (Task 19). `KnnRow` (Task 18).
- Produces:
  - `shapeHits(rows: readonly KnnRow[], query: string): DocHit[]`, exported.
  - `searchDocuments(query: string, limit = 5, embed: Embedder = realEmbedder)`, which gains an optional third parameter. Existing callers (`server/index.ts:545,580`) are unchanged.
  - `setDocIndexTransportForTests(f: (() => DocIndexTransport) | null): void`.
  - `docIndexBuiltAt()` now also returns the build time while a disk load is in flight (from the worker's `opened` message).
  - `loadDiskIndex` stays exported for tests and scripts, but is no longer on the server path.

- [ ] **Step 1: Write the failing tests.** Create `tests/unit/doc-index-wiring.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIndex, docIndexBuiltAt, docStatus, resetDocCacheForTests, searchDocuments, setDocIndexTransportForTests, warmDocIndex,
  type DocChunk, type Embedder,
} from '../../server/sources/documents';
import { inProcessDocIndexTransport } from '../../server/sources/doc-index-client';

const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase();
    return new Float32Array([l.includes('renew') ? 1 : 0, l.includes('roof') ? 1 : 0, l.includes('rent') ? 1 : 0]);
  });
const CHUNKS: DocChunk[] = [
  { docId: 'tenant 155 llc', docName: 'Tenant 155 LLC Lease.pdf', idx: 0, text: 'Tenant has one option to renew for five years (the renewal option).' },
  { docId: 'roof', docName: 'Roof Warranty.pdf', idx: 0, text: 'The membrane roof carries a 20-year warranty.' },
  { docId: 'rent', docName: 'Rent Schedule.pdf', idx: 0, text: 'Base rent escalates 3% annually.' },
];
const prev = { path: process.env.DOC_INDEX_PATH, dir: process.env.DOCUMENTS_DIR, worker: process.env.DOC_INDEX_WORKER };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const roots: string[] = [];
afterEach(() => {
  resetDocCacheForTests();
  setDocIndexTransportForTests(null);
  restore('DOC_INDEX_PATH', prev.path); restore('DOCUMENTS_DIR', prev.dir); restore('DOC_INDEX_WORKER', prev.worker);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function diskIndexAtEnv(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'diwire-')); roots.push(root);
  const p = join(root, 'doc-index.sqlite');
  (await buildIndex(CHUNKS, fakeEmbedder, { dbPath: p })).close();
  process.env.DOC_INDEX_PATH = p;
  delete process.env.DOCUMENTS_DIR;
  return p;
}
function counting() {
  const made: Array<ReturnType<typeof inProcessDocIndexTransport>> = [];
  setDocIndexTransportForTests(() => { const t = inProcessDocIndexTransport(); made.push(t); return t; });
  return made;
}

describe('documents.ts over DocIndexClient (item 11)', () => {
  it('warmDocIndex hands the disk load to the transport and does none of it on the calling tick', async () => {
    await diskIndexAtEnv();
    const made = counting();
    const pending = warmDocIndex();
    expect(made).toHaveLength(1);
    expect(made[0]!.handled).toBe(0); // counted, not timed
    await pending;
    expect(made[0]!.handled).toBe(1);
    expect(docIndexBuiltAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('search and status go through the client', async () => {
    await diskIndexAtEnv();
    counting();
    const hits = await searchDocuments('renewal', 3, fakeEmbedder);
    expect(hits[0]).toMatchObject({ doc: 'Tenant 155 LLC Lease.pdf', docId: 'tenant 155 llc', chunkIdx: 0 });
    expect(hits[0]!.snippet.toLowerCase()).toContain('renew');
    const s = await docStatus();
    expect(s).toMatchObject({ documents: 3, chunks: 3 });
  });

  it('concurrent first callers share ONE load', async () => {
    await diskIndexAtEnv();
    const made = counting();
    await Promise.all([searchDocuments('roof', 1, fakeEmbedder), docStatus(), warmDocIndex()]);
    expect(made).toHaveLength(1);
  });

  it('a failed load rejects, is not cached, and the next call retries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'diwire-bad-')); roots.push(root);
    const bad = join(root, 'doc-index.sqlite');
    writeFileSync(bad, 'not a sqlite database');
    process.env.DOC_INDEX_PATH = bad;
    const made = counting();
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    await expect(warmDocIndex()).rejects.toThrow(/doc index load failed/);
    expect(made).toHaveLength(2);
    expect(docIndexBuiltAt()).toBeNull();
  });

  it('DOC_INDEX_WORKER=0 (rollback switch) runs the same protocol in-process', async () => {
    await diskIndexAtEnv();
    setDocIndexTransportForTests(null);
    process.env.DOC_INDEX_WORKER = '0';
    await warmDocIndex();
    expect(docIndexBuiltAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await searchDocuments('rent', 1, fakeEmbedder))[0]!.doc).toBe('Rent Schedule.pdf');
  });
});
```

In `tests/unit/doc-index-freshness.test.ts`:
1. Extend the import with `setDocIndexTransportForTests` from `documents`, and add `import { inProcessDocIndexTransport } from '../../server/sources/doc-index-client';`.
2. Add `setDocIndexTransportForTests(null);` to the `afterEach`.
3. In the third test (`'returns the real build time once a disk-persisted index is loaded into cache'`), insert `setDocIndexTransportForTests(() => inProcessDocIndexTransport());` right after `resetDocCacheForTests();`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/unit/doc-index-wiring.test.ts`. Expected: FAIL (`setDocIndexTransportForTests` is not exported).
- [ ] **Step 3: Implement `documents.ts`.** Add the imports:

```ts
import { DocIndexClient, inProcessDocIndexTransport, workerTransport, type DocIndexTransport } from './doc-index-client';
import type { KnnRow } from './doc-index-protocol';
```

Replace `queryIndex` (lines 368-390) with:

```ts
/** Nearest-neighbor query over an IN-PROCESS index (in-memory fallback / tests) → cited, scored passages. */
export async function queryIndex(index: VecIndex, query: string, embed: Embedder, limit = 5): Promise<DocHit[]> {
  const q = query.trim();
  if (!q || index.chunks.length === 0) return [];
  const [qv] = await embed([q]);
  if (!qv) return [];
  const rows = index.db
    .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(qv, limit) as Array<{ rowid: bigint | number; distance: number }>;
  const knnRows: KnnRow[] = [];
  for (const r of rows) {
    const chunk = index.chunks[Number(r.rowid)];
    if (chunk) knnRows.push({ chunk, distance: r.distance });
  }
  return shapeHits(knnRows, q);
}

/** KNN rows → cited, scored passages (closest first). Shared by the in-process and worker paths. */
export function shapeHits(rows: readonly KnnRow[], query: string): DocHit[] {
  return rows.map(({ chunk, distance }) => ({
    doc: chunk.docName,
    snippet: condense(chunk.text, query),
    score: 1 / (1 + distance), // distance→similarity (monotonic, 0..1)
    docId: chunk.docId,
    chunkIdx: chunk.idx,
  }));
}
```

Replace the cache declaration, `resetDocCacheForTests`, `buildDocIndex`'s final `cache = …` line, `ensureIndex`, `warmDocIndex`, `searchDocuments`, `docStatus` and `docIndexBuiltAt` (lines 605-708, keeping `collectDocChunks` unchanged between them) as follows:

```ts
// `fromDisk` distinguishes a real, persisted index (builtAt is a meaningful timestamp for freshness
// reporting) from an in-memory fallback/empty index (builtAt is just "when this process stood up a
// placeholder" and must never be reported as the index's actual build time — see docIndexBuiltAt).
// A disk index is served by a DocIndexClient (worker thread by default — item 11, 2026-09-24); an
// in-memory fallback keeps a VecIndex on the main thread (it is empty or tiny by construction).
type DocCache = {
  index: VecIndex | null;
  client: DocIndexClient | null;
  docs: Array<{ name: string; chunks: number }>;
  chunkCount: number;
  builtAt: string;
  fromDisk: boolean;
};
let cache: DocCache | null = null;
let loading: { client: DocIndexClient; done: Promise<DocCache> } | null = null;

/** Worker thread by default; DOC_INDEX_WORKER=0 runs the same protocol in-process — the pre-2026-09-24
 *  main-thread behaviour, kept as the rollback switch. */
function defaultDocIndexTransport(): DocIndexTransport {
  return process.env.DOC_INDEX_WORKER === '0' ? inProcessDocIndexTransport() : workerTransport();
}
let transportFactory: () => DocIndexTransport = defaultDocIndexTransport;

/** Test-only: inject the transport (vitest cannot spawn a .ts Worker); null restores the default. */
export function setDocIndexTransportForTests(f: (() => DocIndexTransport) | null): void {
  transportFactory = f ?? defaultDocIndexTransport;
}

/** Test-only: clear the module-level index cache so a test can start from a known-empty state.
 * Closes any open handle first — otherwise a Windows temp-dir cleanup right after a disk-loaded-index
 * test EPERMs on the still-open file (the in-process transport releases it synchronously). */
export function resetDocCacheForTests(): void {
  cache?.index?.close();
  if (cache?.client) void cache.client.close().catch(() => undefined);
  if (loading) void loading.client.close().catch(() => undefined);
  cache = null;
  loading = null;
}
```

(`collectDocChunks` is unchanged and sits here.)

```ts
export async function buildDocIndex(embed: Embedder = realEmbedder): Promise<void> {
  const { chunks, docs, truncated } = await collectDocChunks();
  if (truncated) {
    console.warn(
      `[documents] file cap (${maxFiles()}) reached under ${process.env.DOCUMENTS_DIR} — some documents are NOT indexed; raise DOCUMENTS_MAX_FILES.`,
    );
  }
  const filterNote = process.env.DOCUMENTS_PATH_INCLUDE ? ` matching /${process.env.DOCUMENTS_PATH_INCLUDE}/i` : '';
  console.log(`[documents] indexed ${docs.length} documents (${chunks.length} chunks)${filterNote}`);
  cache = { index: await buildIndex(chunks, embed), client: null, docs, chunkCount: chunks.length, builtAt: new Date().toISOString(), fromDisk: false };
}

/** One shared load per process; a failure is not cached, so the next caller retries. */
function loadFromDisk(p: string): Promise<DocCache> {
  if (loading) return loading.done;
  const client = DocIndexClient.start(p, transportFactory());
  const done = client.ready.then(
    (info) => {
      cache = { index: null, client, docs: info.docs, chunkCount: info.chunkCount, builtAt: info.builtAt, fromDisk: true };
      loading = null;
      console.log(`[documents] loaded on-disk index — ${info.docs.length} documents, ${info.chunkCount} chunks (${p})`);
      return cache;
    },
    (err: unknown) => {
      loading = null;
      void client.close().catch(() => undefined);
      throw err;
    },
  );
  loading = { client, done };
  return done;
}

async function ensureIndex(): Promise<DocCache> {
  if (cache) return cache;
  const p = docIndexPath();
  if (existsSync(p)) return loadFromDisk(p);
  await buildDocIndex(); // in-memory fallback (empty when DOCUMENTS_DIR unset)
  return cache!;
}

/**
 * Startup warm-up. Loads the persisted on-disk index if present — in a worker thread (item 11), so the
 * HTTP server keeps answering while a cold ~179 MB file loads. If it's absent but a corpus is configured,
 * we deliberately do NOT build the full corpus in-process (that OOM-crashes the box) — we log guidance to
 * run `npm run index:docs` and serve an empty index.
 */
export async function warmDocIndex(): Promise<void> {
  const p = docIndexPath();
  if (existsSync(p)) {
    await ensureIndex();
    return;
  }
  if (process.env.DOCUMENTS_DIR) {
    console.warn(
      `[documents] no on-disk index at ${p} — run \`npm run index:docs\` to build it. Serving an EMPTY document index until then.`,
    );
    cache = { index: await buildIndex([], realEmbedder), client: null, docs: [], chunkCount: 0, builtAt: new Date().toISOString(), fromDisk: false };
  }
  // No DOCUMENTS_DIR → leave cache null; first request lazily builds an empty index (harmless).
}

/** The injectable doc searcher handed to the agent (server only). `embed` is injectable for tests. */
export async function searchDocuments(query: string, limit = 5, embed: Embedder = realEmbedder): Promise<DocHit[]> {
  const c = await ensureIndex();
  if (c.client) {
    const q = query.trim();
    if (!q || c.chunkCount === 0) return [];
    const [qv] = await embed([q]);
    if (!qv) return [];
    return shapeHits(await c.client.knn(qv, limit), q);
  }
  if (!c.index) return [];
  return queryIndex(c.index, query, embed, limit);
}

export async function docStatus(): Promise<{ configured: boolean; dir: string | null; documents: number; chunks: number; engine: string; docs: Array<{ name: string; chunks: number }>; builtAt: string }> {
  const { docs, chunkCount, builtAt } = await ensureIndex();
  return { configured: !!process.env.DOCUMENTS_DIR, dir: process.env.DOCUMENTS_DIR ?? null, documents: docs.length, chunks: chunkCount, engine: 'semantic (all-MiniLM-L6-v2 + sqlite-vec)', docs: docs.slice(0, 50), builtAt };
}

/** Build time of the loaded index, WITHOUT forcing a load (safe for /api/health). Only a disk index has a
 * meaningful build time — an in-memory fallback stamps `builtAt` with "now" as a placeholder, which must
 * never read as fresh (I-1, 2026-09-23 review). While a disk load is in flight, the worker's `opened`
 * message supplies it, so the Data Feeds row does not flash "never" during a cold start. */
export function docIndexBuiltAt(): string | null {
  if (cache) return cache.fromDisk && cache.builtAt ? cache.builtAt : null;
  return loading?.client.builtAt ?? null;
}
```

In `server/startup.ts`, replace the doc comment above `startServer` with:

```ts
/**
 * Bind first, then do heavy work one macrotask later. The document index used to load synchronously on
 * this thread (~179 MB better-sqlite3 + sqlite-vec read; ~7 min on a cold, AV-scanned start — 2026-09-23
 * review). Since item 11 (2026-09-24) warmDocs() hands it to a worker thread (server/sources/
 * doc-index-client.ts), so this deferral now only orders startup; it no longer has to absorb a stall.
 */
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run tests/unit/doc-index-wiring.test.ts tests/unit/doc-index-freshness.test.ts tests/unit/documents.test.ts tests/unit/doc-index-core.test.ts tests/unit/doc-index-client.test.ts tests/unit/server-startup.test.ts && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Live check (the acceptance test for item 11).**
  1. Copy the main checkout's `.env` into the worktree. Point `DOC_INDEX_PATH` at `C:/Users/Owner/oxford-command-center/data/doc-index.sqlite`, which is opened read-only. Start `npm run dev:server:once`.
  2. **Within the first 2 seconds** of "listening", run `curl -s -m 5 http://127.0.0.1:<port>/api/health`. Expected: HTTP 200 immediately, even while the log has not yet printed `[documents] loaded on-disk index`. The `docIndex` feed shows its real age, not "never".
  3. After the load line, run `curl -s "http://127.0.0.1:<port>/api/documents/search?q=renewal%20option&limit=3"` and expect hits.
  4. Stop the server (server-stop is part of the done bar). Delete the copied `.env`.
  5. Record both curl outputs in the PR body.
- [ ] **Step 6: Commit.**

```bash
git add server/sources/documents.ts server/startup.ts tests/unit/doc-index-wiring.test.ts tests/unit/doc-index-freshness.test.ts
git commit -m "feat(docs): serve the on-disk document index from a worker thread — /api/health stays responsive on a cold start" -m "Refute-Skip: document-search plumbing (documents.ts is refute-exempt; startup.ts is a comment) — no deal, financial or alert logic" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR D close-out:**
- [ ] `git fetch origin && git rebase origin/main`, then `npm run gate` and `npx tsx scripts/check-refute-required.ts`.
- [ ] `git push -u origin fix/cc-r2-d-doc-index-worker`. Open PR `feat(docs): document index off the main thread (round 2 · D)`. The body carries the design paragraph above, the smoke JSON lines (fixture and real), the two live curl outputs, and the rollback: `DOC_INDEX_WORKER=0`.
- [ ] Review: code-reviewer pass plus `pr-review-toolkit:silent-failure-hunter` on the client, because failure propagation is the risk surface.

---

## PR E — Ops Runbook (item 15)

Branch: `git switch -c docs/cc-r2-e-ops-runbook origin/main`.

### Task 21: Ops Runbook R1–R8 tracked checklist

**Files:**
- Create: `docs/ops/2026-09-24-ops-runbook-r1-r8.md`

Source: the round-1 plan's "Ops Runbook" table (`docs/superpowers/plans/2026-09-23-command-center-review-fixes.md:2391-2402`), plus the round-2 rulings: the tracked checklist runs until the Data Feeds card is all green, and Gabriel retires the old Expired rows in the workbook. Data Feeds row labels and budgets come from `server/feed-freshness.ts` (`FEED_MAX_AGE_DAYS`, `META`).

- [ ] **Step 1: Verify every command in the doc resolves.** Run: `git grep -n "\"index:docs\"\|\"lease-market:ingest\"\|\"lease-market:compute\"\|\"warehouse:import-loss-runs\"" package.json && ls scripts/ar-import-headless.ts scripts/import-insurance-data.ts scripts/import-assessments.ts scripts/reindex-loop.ps1 scripts/bake-mirror.ts`. Expected: all present.
- [ ] **Step 2: Write the doc.** Create `docs/ops/2026-09-24-ops-runbook-r1-r8.md` with exactly:

````markdown
# Ops Runbook R1–R8 — tracked checklist

Status: OPEN until **System Health › Data Feeds shows "0 need attention" (green)** and every row below is checked.
Owner of this checklist: Gabriel (with supervised Claude sessions for the command rows).
Source: 2026-09-23 review Ops Runbook (docs/superpowers/plans/2026-09-23-command-center-review-fixes.md), ratified follow-up 2026-09-24.

Guardrails: business-OneDrive files are edited by Gabriel only (Invariant 5). Recurring jobs are registered ONLY through the
`register-scheduled-task` skill (supervised `create_scheduled_task`, never registry JSON). Nothing here is a code change.

| # | Item | Owner | Exact command / action | Expected Data Feeds status when done | Done |
|---|---|---|---|---|---|
| R1 | Cash history rows missing after **2026-07-10** (08-10, 09-10) | Gabriel | Add the 2026-08-10 and 2026-09-10 rows to *Cash Data* in the Master Workbook; save (the watcher re-parses). | **Cash history (monthly rows)** fresh (≤ 40d); Health › Data Quality has no `cash.history.date` flag | [ ] |
| R2 | AR aging import stale (newest import 2026-08-21; 7 leases older) | Supervised session → Gabriel runs the QB export | 1) Export AR aging from QuickBooks Desktop into `AR_INBOX`. 2) `npx tsx scripts/ar-import-headless.ts` 3) Fleet check on why the Monday 08:20 import stopped: `automation-health-monitor` → `fleet-advisory-remediation`. | **AR aging (QuickBooks)** fresh (≤ 35d) with **no** "N leases with stale AR" note | [ ] |
| R3 | Daily brief last ran **2026-07-09** | Supervised session | Confirm whether the snapshot-refresh / brief task (runs `scripts/bake-mirror.ts` → brief) was paused or retired; re-register via `register-scheduled-task` if retired. | **Daily brief** fresh (< 36h); Health › Daily Brief card "OK" | [ ] |
| R4 | Lease Market never computed | Supervised session | `npm run lease-market:ingest` (CoStar exports in the intake folder) then `npm run lease-market:compute`; register weekly via `register-scheduled-task`. | **Lease market compute** fresh (≤ 14d); Lease Market module shows KPIs, not the empty state | [ ] |
| R5 | Document index built **2026-06-06** | Supervised session | `npm run index:docs -- --replan` once, then repeat `npm run index:docs` (or `scripts/reindex-loop.ps1`) until it reports 0 remaining; register monthly. Requires `DOCUMENTS_EXCLUDE` + `DOCUMENTS_INCLUDE_DIRS` in `.env` (the reindex safety guard refuses otherwise). | **Document index (Ask)** fresh (≤ 30d) | [ ] |
| R6 | Insurance: 8 policy lines show expired (1100 Rarig, ETC POA, 1851 S Club, 9050 Red Branch, 3034 Westerville); TIV null on all 30 | Gabriel supplies dec pages; supervised session imports | Confirm renewals were bound; `npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json>` (terms + TIV) and `--policies <policies.json>` (premium history); verify with the `insurance-declaration-checker` agent. | Not a Data Feeds row — Obligations › Insurance shows a **Rate vs Benchmark** value and no Expired lines in the Policy Tracker | [ ] |
| R7 | Workbook rows: **Example Consulting** $0 rent "Active"; **Tenant 038 LLC** / **Tenant 059 LLC** ended 2024-09-01 (retire) | Gabriel | Fix Example Consulting's rent/status and retire the Tenant 038 and Tenant 059 rows in the Master Workbook (no code change — ratified 2026-09-24). | **Workbook snapshot** fresh (≤ 2d) after re-parse; Health › Data Quality has no `lease.<id>.leaseEnd` flag for those tenants | [ ] |
| R8 | Leasing velocity has no data (`lease_events` = 0 rows) | New spec session | Spec an importer that derives vacate/commence events from historical rent rolls or the Notion Tenant DB history (brainstorming → `/plan`), then add the velocity trend chart. Output: `docs/superpowers/specs/<date>-lease-events-importer.md`. | Not a Data Feeds row — spec merged; velocity chart ticket opened | [ ] |

Close-out: when every box is checked and Data Feeds reads "0 need attention", set Status to CLOSED with the date and
record it in the project `event_log.md`.
````

- [ ] **Step 3: Commit.**

```bash
git add docs/ops/2026-09-24-ops-runbook-r1-r8.md
git commit -m "docs(ops): R1-R8 tracked runbook until Data Feeds is all green" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**PR E close-out:** `npm run governance && npm run lint`. The full gate is optional for a docs-only PR, but run it if CI requires it. Then push and open PR `docs(ops): R1–R8 runbook checklist (round 2 · E)`. Gabriel merges.

---

## Verification before calling round 2 done

- Each PR: `npm run gate` green; `npx tsx scripts/check-refute-required.ts` passes; every refute run id is recorded in its commit trailer and PR body. For UI tasks, browser screenshots in light and dark at 1440 px and 375 px.
- After A–D merge, verify on `origin/main` and not on a branch. Re-run the three live cross-check scripts from Tasks 2, 5 and PR B, then delete them. Expected: the live-snapshot table at the top of this plan, row for row.
- System Health: Reconciliation never says "Consistent" beside a debt-basis flag, and the AR row shows the newest-import age plus the stale-lease note. With the server freshly restarted, `/api/health` answers within 5 s.
- Update `architecture/status.json` `cc-review-round2` to `"status": "merged"` (architect-owned; sentinel). Remove the worktree. It has real `node_modules` from `npm ci`, not a junction, but still check `node-modules-junction-footgun` before `git worktree remove`.

## Self-review (run 2026-09-24 against the ratified list)

- **Coverage.** Item 1 is Tasks 1, 2, 3, 4 and 5. Item 2 is Task 8, item 3 Task 9, item 4 Task 10, item 5 Task 11, item 6 Task 12, item 7 Task 13, item 8 Task 14, item 9 Task 15, item 10 Task 16, item 11 Tasks 18–20, item 12 Task 17, item 13 Tasks 6 and 7, item 14 Task 5, and item 15 Task 21. No gaps.
- **Placeholder scan.** No TBD, TODO or "similar to" references. `wf_<runId>` is filled from each task's refute step.
- **Type consistency.** These names are consistent across tasks:
  - `affiliateDebt` is used in Tasks 2, 3 and 7.
  - `otherHoldingsEquity` / `otherHoldingsDebt` are used in Task 8.
  - `isDebtBasisFlag` is used in Tasks 1, 6 and 7.
  - `DEBT_BASIS_FIELD` is used in Tasks 1 and 5.
  - `overviewTotalDebtSublabel` is created in Task 3 and extended in Task 8.
  - `KnnRow` / `DocIndexTransport` / `DocIndexClient` are used in Tasks 18–20.
  - `arFeedInput` / `note` are used in Task 15.
- **Known trade-offs and blocking questions for Gabriel.**
  - **Q1 (blocks the PR A merge).** No affiliate field exists in the workbook or snapshot. Identification is an explicit whole-phrase lender list, `['Oxford Capital']`, applied to the property `lender` and the borrower-loan lender/counterparty. Confirm the list is complete. Specifically: is any of "NOTE PARTY 08"/"NOTEPARTY08", "Firm 08", "EG(Oxford)" or "Muirkirk Properties" an Oxford affiliate that could appear as the *lender* on a borrower note? Today those names appear only on internal-direction rows, or on third-party loans as the borrower entity. The robust long-term fix is an "Affiliate" column on the Loan Index and Property NOI sheets.
  - **Q2 (non-blocking).** 1100 Rarig's DSCR (2.53x) is still computed on its affiliate debt service. The ruling covers Total Debt and LTV only, so this plan leaves DSCR unchanged.
  - **Q3 (non-blocking).** External Debt's weighted rate and annual debt service move to the third-party basis (5.50%). The maturity ladder keeps the affiliate note, and Capital Deployed keeps the Note Party 01 lender position.
  - **Architect ack (blocks Tasks 0, 2, 8 and 15).** These tasks touch `architecture/status.json`, `src/analytics/engine.ts` and `server/index.ts`.
