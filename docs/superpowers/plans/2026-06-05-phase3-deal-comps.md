# Command Center Phase 3 (⑦) — Deal Comps Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand market-comps capability to the Acquisitions deal drawer — a "Refresh comps" button that web-searches sale/rent/submarket comparables, caches them to the deal's overlay (tagged AI-sourced + dated), surfaced in a rebuilt **wide deal drawer** with six substantive cards (incl. a **Replacement Cost** card per ORA convention), a stage-progression track, and a right-side comps panel.

**Architecture:** Three tracks. **(A) Replacement Cost** — a pure, unit-tested calc using the firm's documented $85–$120/SF basis. **(B) Comps backend** — a new `CompSet` contract, a `dealComps` overlay key (same additive pattern as Phase 2's `renewalStages`/`tenantNotes`), and `server/ai/comps.ts` which calls Anthropic's native **`web_search_20250305`** server tool in a single non-streaming request and has the model end by calling a `record_comps` client tool (structured output we validate with Zod). A `POST /api/actions/deal-comps` endpoint runs it and caches the result. **(C) Deal drawer v2** — a dedicated wide `DealDrawer` component (the generic 440px panel stays for every other entity type), rendering the six cards + stage track + comps panel.

**Tech Stack:** React 19, TypeScript (`noUncheckedIndexedAccess` ON), Zod, @tanstack/react-query, Hono (server), Vitest, Tailwind v4, framer-motion, Lucide. **Anthropic web search** via raw `fetch` (the app already calls `https://api.anthropic.com/v1/messages` with `anthropic-version: 2023-06-01`).

**One branch:** `feat/cc-phase3-deal-comps`. Recommended order **A → B → C** (A is a pure dependency of the drawer's Replacement Cost card; B's contract/overlay must exist before the drawer reads `dealComps`).

## Key facts learned from the codebase (read before starting)

- **The AI agent** (`server/ai/agent.ts`) calls Anthropic with raw `fetch` (no SDK), `anthropic-version: 2023-06-01`, streaming. It runs **spine-local tools only — no web access today.** Comps deliberately use a **separate, non-streaming** routine (`server/ai/comps.ts`) so the web-search complexity stays out of the Ask-agent loop.
- **Anthropic web search** is the server tool `{ type: 'web_search_20250305', name: 'web_search', max_uses: N }`. In a **non-streaming** request, Anthropic executes the searches inside the request and the model continues its turn; when the model finishes by calling a **client** tool (`record_comps`), the response returns `stop_reason: 'tool_use'` with that block's `input` — which we read directly (no second round-trip, since we don't execute client tools here). If web search is disabled on the org or the key is missing, the routine returns `{ ok: false, error }` and the UI shows the message — the feature still ships; enabling web search is an account toggle.
- **The deal drawer today** (`src/brain/EntityDrawer.tsx`) is a generic 440px `Panel` rendering a `Content` object from `resolve()`. The `deal` case returns a flat stat list + Draft-LOI action + stage-advance `writeAction`. Phase 3 replaces the **deal view only** with a dedicated wide `DealDrawer`; all other entity types keep the existing `Panel`. The existing handlers — `onAdvanceStage` (confirm + `advanceDealStage` + invalidate), `ui.openDraft`, `ui.openEntity`, and `canWrite = computeFreshness(state).kind === 'live'` — are reused.
- **`Deal` contract** (`src/contracts/deal.ts`): `id, name, shortName, location, market, sf, buildings, stage, estPrice, capRate, irr, equityMultiple, holdYrs, lender, status, nextAction, owner, targetCloseDate, confidential, estimatedFields[]`. No loan-terms fields beyond `lender`. No replacement-cost field.
- **Replacement-cost basis:** `markets.md` documents the ORA range **$85–$120/SF (by market + building class)**; per-market validated figures are "pending." So the Replacement Cost card uses that range honestly (price-to-replacement vs. range), not faux per-market precision.
- **Overlay pattern** (proven twice in Phase 2): additive `Overlay` key → `EMPTY_OVERLAY` + both `loadOverlay` returns + `applyOverlay` (no base mutation) → a `.default({})` field on `PortfolioSnapshot` (so the baked mirror carries it) → a `brain` mutator → a `POST /api/actions/*` endpoint → a client wrapper. `data/overlay.json` stays gitignored. **Adding a required-with-default field to `PortfolioSnapshot` forces non-cast literals in tests to include it** — expect to add `dealComps: {}` to `tests/unit/analytics.test.ts`'s `snap()` and the `Overlay` literals in `tests/unit/overlay.test.ts` (parse.ts uses `PortfolioSnapshot.parse({...})` so it needs no edit).
- **Formatters** from `@analytics/index`: `fmtUsd`, `fmtUsdCompact`, `fmtPct`, `fmtSf`, `fmtNum`, `fmtMultiple`, `fmtDate`. **Primitives/UI:** `Badge`/`BadgeTone`; CSS-var styling (`var(--surface-raised|overlay)`, `var(--border-subtle|strong)`, `var(--text-primary|secondary|tertiary)`, `var(--accent)`, `var(--color-pos|neg|warn|info)`, `text-2xs`).

## File Structure

| File | Track | Responsibility |
|---|---|---|
| `src/brain/replacement-cost.ts` (create) | A | `REPLACEMENT_COST_PSF` + pure `replacementCostAnalysis(deal)` |
| `tests/unit/replacement-cost.test.ts` (create) | A | Null-SF, low/mid/high, verdict thresholds, price-to-replacement |
| `src/contracts/comps.ts` (create) | B | Zod `SaleComp`/`RentComp`/`SubmarketStat`/`CompSet`/`DealCompsActionInput` + `RECORD_COMPS_TOOL` JSON schema |
| `src/contracts/index.ts` (modify) | B | Re-export `./comps`; add `dealComps` field to `PortfolioSnapshot` |
| `server/overlay.ts` (modify) | B | `dealComps` overlay key; merge in `applyOverlay` |
| `server/ai/comps.ts` (create) | B | `fetchDealComps(deal, opts)` → web-search-backed `CompSet` (injectable `fetchImpl`) |
| `tests/unit/comps.test.ts` (create) | B | `fetchDealComps` parsing/validation/error paths with a mocked fetch |
| `server/brain.ts` (modify) | B | `setDealComps(dealId, comps)` mutator |
| `server/index.ts` (modify) | B | `POST /api/actions/deal-comps` |
| `src/data/actions.ts` (modify) | B | `refreshDealComps(dealId)` client wrapper (returns the `CompSet`) |
| `tests/unit/overlay.test.ts` (modify) | B | `applyOverlay` merges `dealComps`; `dealComps: {}` ripple on existing literals |
| `src/brain/DealDrawer.tsx` (create) | C | Wide deal drawer: 6 cards + stage track + comps panel + refresh |
| `src/brain/EntityDrawer.tsx` (modify) | C | Route `selected.type === 'deal'` to `DealDrawer` |

---

# TRACK A — Replacement Cost (pure)

## Task A1: Replacement-cost analysis

**Files:**
- Create: `src/brain/replacement-cost.ts`
- Test: `tests/unit/replacement-cost.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/replacement-cost.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { REPLACEMENT_COST_PSF, replacementCostAnalysis } from '../../src/brain/replacement-cost';

describe('replacementCostAnalysis', () => {
  it('exposes the ORA $85–$120/SF basis', () => {
    expect(REPLACEMENT_COST_PSF.low).toBe(85);
    expect(REPLACEMENT_COST_PSF.high).toBe(120);
    expect(REPLACEMENT_COST_PSF.mid).toBe(102.5);
  });

  it('returns null when SF is missing or non-positive', () => {
    expect(replacementCostAnalysis({ sf: null, estPrice: 1_000_000 })).toBeNull();
    expect(replacementCostAnalysis({ sf: 0, estPrice: 1_000_000 })).toBeNull();
  });

  it('computes low/mid/high replacement cost from SF', () => {
    const r = replacementCostAnalysis({ sf: 50_000, estPrice: null })!;
    expect(r.low).toBe(50_000 * 85);
    expect(r.mid).toBe(50_000 * 102.5);
    expect(r.high).toBe(50_000 * 120);
    expect(r.priceToReplacementMid).toBeNull();
    expect(r.verdict).toBeNull();
  });

  it('flags a discount when price is well below mid replacement', () => {
    // 50k SF → mid = 5.125M. Price 4M → 0.78 → discount.
    const r = replacementCostAnalysis({ sf: 50_000, estPrice: 4_000_000 })!;
    expect(r.priceToReplacementMid).toBeCloseTo(4_000_000 / (50_000 * 102.5), 4);
    expect(r.verdict).toBe('Discount to replacement');
  });

  it('flags near-replacement within ±10% of mid', () => {
    const mid = 50_000 * 102.5;
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid })!.verdict).toBe('Near replacement');
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid * 1.05 })!.verdict).toBe('Near replacement');
  });

  it('flags a premium when price exceeds 110% of mid', () => {
    const mid = 50_000 * 102.5;
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid * 1.25 })!.verdict).toBe('Premium to replacement');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/replacement-cost.test.ts`
Expected: FAIL — cannot find module `../../src/brain/replacement-cost`.

- [ ] **Step 3: Write the implementation**

Create `src/brain/replacement-cost.ts`:

```typescript
import type { Deal } from '../contracts/index';

/**
 * ORA replacement-cost basis — firm range $85–$120/SF, building-class dependent (per markets.md;
 * per-market validated figures pending). Drives the deal-drawer Replacement Cost card.
 */
export const REPLACEMENT_COST_PSF = { low: 85, mid: 102.5, high: 120 } as const;

export type ReplacementVerdict = 'Discount to replacement' | 'Near replacement' | 'Premium to replacement';

export interface ReplacementCostAnalysis {
  sf: number;
  low: number; // sf × $85
  mid: number; // sf × $102.5
  high: number; // sf × $120
  estPrice: number | null;
  priceToReplacementMid: number | null; // estPrice ÷ mid
  verdict: ReplacementVerdict | null;
  basis: string;
}

/** Replacement-cost analysis for a deal. Null when SF is unknown (can't compute). */
export function replacementCostAnalysis(deal: Pick<Deal, 'sf' | 'estPrice'>): ReplacementCostAnalysis | null {
  if (deal.sf === null || deal.sf <= 0) return null;
  const sf = deal.sf;
  const low = sf * REPLACEMENT_COST_PSF.low;
  const mid = sf * REPLACEMENT_COST_PSF.mid;
  const high = sf * REPLACEMENT_COST_PSF.high;
  const estPrice = deal.estPrice;
  const priceToReplacementMid = estPrice !== null && mid > 0 ? estPrice / mid : null;
  const verdict: ReplacementVerdict | null =
    priceToReplacementMid === null
      ? null
      : priceToReplacementMid < 0.9
        ? 'Discount to replacement'
        : priceToReplacementMid <= 1.1
          ? 'Near replacement'
          : 'Premium to replacement';
  return { sf, low, mid, high, estPrice, priceToReplacementMid, verdict, basis: 'ORA $85–$120/SF (building-class dependent)' };
}
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/replacement-cost.test.ts`
Expected: PASS (6 tests).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/brain/replacement-cost.ts tests/unit/replacement-cost.test.ts
git commit -m "feat(comps): pure replacement-cost analysis (ORA $85–$120/SF basis)"
```

---

# TRACK B — Comps backend

## Task B1: CompSet contract + record_comps tool schema

**Files:**
- Create: `src/contracts/comps.ts`
- Test: `tests/unit/comps.test.ts` (created here; extended in B4)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/comps.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CompSet, SaleComp, DealCompsActionInput, RECORD_COMPS_TOOL } from '../../src/contracts/comps';

describe('CompSet contract', () => {
  it('defaults all comp arrays and fills nullable comp fields', () => {
    const cs = CompSet.parse({ sourcedAt: '2026-06-05T00:00:00.000Z' });
    expect(cs.saleComps).toEqual([]);
    expect(cs.rentComps).toEqual([]);
    expect(cs.submarketStats).toEqual([]);
    expect(cs.sources).toEqual([]);
    expect(cs.summary).toBeNull();
  });

  it('parses a sale comp with sparse fields (address + source required)', () => {
    const sc = SaleComp.parse({ address: '123 Main', source: 'LoopNet' });
    expect(sc.address).toBe('123 Main');
    expect(sc.pricePerSf).toBeNull();
    expect(SaleComp.safeParse({ source: 'x' }).success).toBe(false); // address required
  });

  it('validates the action input', () => {
    expect(DealCompsActionInput.safeParse({ dealId: 'd1' }).success).toBe(true);
    expect(DealCompsActionInput.safeParse({ dealId: '' }).success).toBe(false);
  });

  it('exposes a record_comps tool schema for the model', () => {
    expect(RECORD_COMPS_TOOL.name).toBe('record_comps');
    expect(RECORD_COMPS_TOOL.input_schema.type).toBe('object');
    expect(Object.keys(RECORD_COMPS_TOOL.input_schema.properties)).toEqual(
      expect.arrayContaining(['saleComps', 'rentComps', 'submarketStats', 'summary', 'sources']),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/comps.test.ts`
Expected: FAIL — cannot find module `../../src/contracts/comps`.

- [ ] **Step 3: Write the implementation**

Create `src/contracts/comps.ts`:

```typescript
import { z } from 'zod';

/** A comparable sale. Web data is sparse → only address + source are required. */
export const SaleComp = z.object({
  address: z.string(),
  market: z.string().nullable().default(null),
  sf: z.number().nullable().default(null),
  price: z.number().nullable().default(null),
  pricePerSf: z.number().nullable().default(null),
  capRate: z.number().nullable().default(null), // decimal (0.08 = 8%)
  date: z.string().nullable().default(null),
  source: z.string(),
});
export type SaleComp = z.infer<typeof SaleComp>;

/** A comparable lease. */
export const RentComp = z.object({
  address: z.string(),
  sf: z.number().nullable().default(null),
  rentPerSf: z.number().nullable().default(null), // $/SF/yr (NNN unless noted)
  leaseType: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  source: z.string(),
});
export type RentComp = z.infer<typeof RentComp>;

/** A free-form submarket statistic (vacancy, asking-rent trend, absorption, supply…). */
export const SubmarketStat = z.object({
  label: z.string(),
  value: z.string(),
  source: z.string().nullable().default(null),
});
export type SubmarketStat = z.infer<typeof SubmarketStat>;

/** The cached comp research for one deal. Always AI-sourced; `sourcedAt` drives the freshness tag. */
export const CompSet = z.object({
  saleComps: z.array(SaleComp).default([]),
  rentComps: z.array(RentComp).default([]),
  submarketStats: z.array(SubmarketStat).default([]),
  summary: z.string().nullable().default(null),
  sources: z.array(z.string()).default([]),
  sourcedAt: z.string(), // ISO timestamp the research was cached
});
export type CompSet = z.infer<typeof CompSet>;

/** POST /api/actions/deal-comps body. */
export const DealCompsActionInput = z.object({ dealId: z.string().min(1) });
export type DealCompsActionInput = z.infer<typeof DealCompsActionInput>;

/**
 * Anthropic client-tool schema. The model web-searches freely, then ends its turn by calling
 * record_comps exactly once with structured findings — which we read from the response and
 * validate with CompSet (stamping sourcedAt ourselves).
 */
export const RECORD_COMPS_TOOL = {
  name: 'record_comps',
  description: 'Record the market comparables you found. Call this exactly once, last, with all findings.',
  input_schema: {
    type: 'object',
    properties: {
      saleComps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            market: { type: ['string', 'null'] },
            sf: { type: ['number', 'null'] },
            price: { type: ['number', 'null'] },
            pricePerSf: { type: ['number', 'null'] },
            capRate: { type: ['number', 'null'], description: 'decimal, e.g. 0.08 for 8%' },
            date: { type: ['string', 'null'] },
            source: { type: 'string', description: 'URL or publication' },
          },
          required: ['address', 'source'],
        },
      },
      rentComps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            address: { type: 'string' },
            sf: { type: ['number', 'null'] },
            rentPerSf: { type: ['number', 'null'], description: '$/SF/yr, NNN unless noted' },
            leaseType: { type: ['string', 'null'] },
            date: { type: ['string', 'null'] },
            source: { type: 'string' },
          },
          required: ['address', 'source'],
        },
      },
      submarketStats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            source: { type: ['string', 'null'] },
          },
          required: ['label', 'value'],
        },
      },
      summary: { type: ['string', 'null'], description: 'one-paragraph read of pricing/positioning + any data gaps' },
      sources: { type: 'array', items: { type: 'string' }, description: 'all source URLs/publications used' },
    },
    required: ['saleComps', 'rentComps', 'submarketStats'],
  },
} as const;
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/comps.test.ts`
Expected: PASS (4 tests).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/contracts/comps.ts tests/unit/comps.test.ts
git commit -m "feat(comps): CompSet contract + record_comps tool schema"
```

---

## Task B2: Wire dealComps into snapshot contract + overlay

**Files:**
- Modify: `src/contracts/index.ts`
- Modify: `server/overlay.ts`
- Modify: `tests/unit/overlay.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the END of `tests/unit/overlay.test.ts` (it already imports `applyOverlay`, `EMPTY_OVERLAY`, `PortfolioSnapshot`):

```typescript
describe('applyOverlay — dealComps (Phase 3)', () => {
  const baseD = { deals: [{ id: 'd1' }], tasks: [], leases: [] } as unknown as PortfolioSnapshot;
  const cs = { saleComps: [], rentComps: [], submarketStats: [], summary: null, sources: [], sourcedAt: '2026-06-05T00:00:00.000Z' };

  it('surfaces dealComps onto the snapshot', () => {
    const out = applyOverlay(baseD, { ...EMPTY_OVERLAY, dealComps: { d1: cs } });
    expect(out.dealComps.d1).toEqual(cs);
  });

  it('defaults to an empty record and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseD, EMPTY_OVERLAY).dealComps).toEqual({});
    expect(EMPTY_OVERLAY.dealComps).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/overlay.test.ts`
Expected: FAIL — `dealComps` undefined.

- [ ] **Step 3: Extend the snapshot contract**

In `src/contracts/index.ts`:
- Add the re-export with the others: `export * from './comps';`
- Add the import at the top with the other contract imports: `import { CompSet } from './comps';`
- In `PortfolioSnapshot`, after the `tenantNotes` field, add:

```typescript
  /** Overlay-sourced, AI-researched market comps per deal (Phase 3). Workbook has none → empty. */
  dealComps: z.record(z.string(), CompSet).default({}),
```

- [ ] **Step 4: Extend the overlay**

In `server/overlay.ts`:
- Update the type import to add `CompSet`:

```typescript
import type { PortfolioSnapshot, Task, DealStage, RenewalStage, CompSet } from '../src/contracts/index';
```

- Add to the `Overlay` interface (after `tenantNotes`):

```typescript
  /** dealId → cached AI-sourced comp research. */
  dealComps: Record<string, CompSet>;
```

- Update `EMPTY_OVERLAY`:

```typescript
export const EMPTY_OVERLAY: Overlay = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {}, dealComps: {} };
```

- In `loadOverlay`, add `dealComps: raw.dealComps ?? {}` to the success return AND `dealComps: {}` to the corrupt-fallback return.
- In `applyOverlay`, update the final return to surface the field:

```typescript
  return { ...s, deals, tasks, renewalStages: o.renewalStages, tenantNotes: o.tenantNotes, dealComps: o.dealComps };
```

- [ ] **Step 5: Fix the type ripple + verify**

Run `npm run typecheck`. Add `dealComps: {}` to any non-cast `PortfolioSnapshot` literal it flags (expected: the `snap()` helper in `tests/unit/analytics.test.ts`), and `dealComps: {}` to the `Overlay` literals in `tests/unit/overlay.test.ts`'s pre-existing tests if flagged. Add ONLY `dealComps: {}` (minimal).

Run: `npx vitest run tests/unit/overlay.test.ts` → PASS.
Run: `npm run gate` → fully green (this touches a shared contract). If it fails on a pre-existing unrelated issue, report BLOCKED with details.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/index.ts server/overlay.ts tests/unit/overlay.test.ts tests/unit/analytics.test.ts
git commit -m "feat(comps): dealComps overlay key + snapshot field"
```

---

## Task B3: Web-search comp fetcher

**Files:**
- Create: `server/ai/comps.ts`
- Test: `tests/unit/comps.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/comps.test.ts`:

```typescript
import { fetchDealComps } from '../../server/ai/comps';
import type { Deal } from '../../src/contracts/index';

const deal = {
  id: 'd1', name: 'Test Industrial', location: '100 Main, Columbus OH', market: 'Columbus',
  sf: 50000, estPrice: 4_000_000,
} as unknown as Deal;

// A fake `fetch` returning an Anthropic-shaped JSON body with a record_comps tool_use block.
const fakeFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' })) as unknown as typeof fetch;

const NOW = '2026-06-05T12:00:00.000Z';

describe('fetchDealComps', () => {
  it('returns an error when no API key is configured', async () => {
    const r = await fetchDealComps(deal, { apiKey: undefined, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not configured/i);
  });

  it('parses a record_comps tool_use block into a validated CompSet, stamping sourcedAt', async () => {
    const body = {
      content: [
        { type: 'text', text: 'searched' },
        { type: 'tool_use', name: 'record_comps', input: {
          saleComps: [{ address: '200 A St', price: 3_500_000, pricePerSf: 70, capRate: 0.082, source: 'LoopNet' }],
          rentComps: [{ address: '210 B St', rentPerSf: 6.5, source: 'CREXI' }],
          submarketStats: [{ label: 'Vacancy', value: '4.1%', source: 'CBRE' }],
          summary: 'Priced below comps.',
          sources: ['https://loopnet.com/x'],
        } },
      ],
    };
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: fakeFetch(body) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comps.sourcedAt).toBe(NOW);
      expect(r.comps.saleComps[0]!.pricePerSf).toBe(70);
      expect(r.comps.rentComps[0]!.rentPerSf).toBe(6.5);
      expect(r.comps.submarketStats[0]!.label).toBe('Vacancy');
    }
  });

  it('errors when the model returned no record_comps block', async () => {
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'no comps' }] }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no comps/i);
  });

  it('errors on a non-OK HTTP response', async () => {
    const failFetch = (async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'web search disabled' })) as unknown as typeof fetch;
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: failFetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/403/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/comps.test.ts`
Expected: FAIL — cannot find module `../../server/ai/comps`.

- [ ] **Step 3: Write the implementation**

Create `server/ai/comps.ts`:

```typescript
import type { Deal } from '../../src/contracts/index';
import { CompSet, RECORD_COMPS_TOOL } from '../../src/contracts/index';

export type FetchCompsResult = { ok: true; comps: CompSet } | { ok: false; error: string };

export interface FetchCompsOptions {
  apiKey?: string;
  model?: string;
  now: string; // ISO — injected for deterministic sourcedAt
  fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

/**
 * Research market comps for a deal via Anthropic's native web_search server tool, then read the
 * model's structured record_comps call. Single non-streaming request: Anthropic runs the searches
 * inside the request and the model ends by calling record_comps (a client tool we don't execute —
 * we just read its input). Degrades to { ok:false, error } on missing key / HTTP error / no comps.
 */
export async function fetchDealComps(deal: Deal, opts: FetchCompsOptions): Promise<FetchCompsResult> {
  if (!opts.apiKey) return { ok: false, error: 'Market comps need AI access — ANTHROPIC_API_KEY is not configured.' };
  const f = opts.fetchImpl ?? fetch;
  const where = [deal.location, deal.market].filter(Boolean).join(', ') || deal.name;

  const prompt =
    `Research current market comparables for this small-bay / flex INDUSTRIAL acquisition, then call ` +
    `record_comps exactly once with your findings.\n\n` +
    `Property: ${deal.name}\nLocation: ${where}\n` +
    `${deal.sf ? `Size: ~${deal.sf.toLocaleString()} SF\n` : ''}` +
    `${deal.estPrice ? `Asking / est. price: $${deal.estPrice.toLocaleString()}\n` : ''}` +
    `\nFind, using web search across CoStar, LoopNet, CREXI, broker market reports, and local sources:\n` +
    `1. SALE comps — comparable industrial sales nearby (address, price, $/SF, cap rate, date).\n` +
    `2. RENT comps — asking/closed NNN $/SF for comparable space (address, $/SF, SF, date).\n` +
    `3. SUBMARKET stats — vacancy, asking-rent trend, net absorption, new supply.\n` +
    `Prefer the last 18 months and the same submarket. Include a source URL/publication for every item. ` +
    `If solid data is thin, record what you can and note the gaps in summary. End by calling record_comps.`;

  const body = {
    model: opts.model || 'claude-opus-4-8',
    max_tokens: 4096,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }, RECORD_COMPS_TOOL],
    messages: [{ role: 'user', content: prompt }],
  };

  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Anthropic: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `Anthropic ${res.status}: ${detail.slice(0, 200)}` };
  }

  const json = (await res.json()) as { content?: AnthropicContentBlock[] };
  const block = (json.content ?? []).find((b) => b.type === 'tool_use' && b.name === 'record_comps');
  if (!block || block.input === undefined) return { ok: false, error: 'The model returned no comps for this deal.' };

  const parsed = CompSet.safeParse({ ...(block.input as Record<string, unknown>), sourcedAt: opts.now });
  if (!parsed.success) return { ok: false, error: 'Comp data failed validation.' };
  return { ok: true, comps: parsed.data };
}
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npx vitest run tests/unit/comps.test.ts`
Expected: PASS (all comps tests).

Run: `npm run typecheck`
Expected: exit 0 (covers the server tsconfig — `server/ai/comps.ts` imports from `src/contracts`, an established cross-import).

- [ ] **Step 5: Commit**

```bash
git add server/ai/comps.ts tests/unit/comps.test.ts
git commit -m "feat(comps): web-search-backed fetchDealComps (record_comps structured output)"
```

---

## Task B4: Brain mutator + endpoint + client action

**Files:**
- Modify: `server/brain.ts`
- Modify: `server/index.ts`
- Modify: `src/data/actions.ts`

- [ ] **Step 1: Add the brain mutator**

In `server/brain.ts`, update the contract import to add `CompSet`:

```typescript
import { PortfolioSnapshot, type BrainState, type DataQualityFlag, type Task, type DealStage, type RenewalStage, type CompSet } from '../src/contracts/index';
```

Add this method after `setTenantNote`:

```typescript
  /** Write-back: cache AI-sourced comps for a deal. Returns false if the deal is unknown. */
  setDealComps(dealId: string, comps: CompSet): boolean {
    if (!this.base?.deals.some((d) => d.id === dealId)) return false;
    this.overlay = { ...this.overlay, dealComps: { ...this.overlay.dealComps, [dealId]: comps } };
    this.rederive('action:deal-comps');
    return true;
  }
```

- [ ] **Step 2: Add the endpoint**

In `server/index.ts`, add imports:

```typescript
import { DealCompsActionInput } from '../src/contracts/index';
import { fetchDealComps } from './ai/comps';
```

Add this route after the `/api/actions/tenant-note` handler. It does the (slow) web search server-side, then caches:

```typescript
app.post('/api/actions/deal-comps', async (c) => {
  const parsed = DealCompsActionInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'Invalid dealId' }, 400);
  const snapshot = brain.getSnapshot();
  const deal = snapshot?.deals.find((d) => d.id === parsed.data.dealId);
  if (!deal) return c.json({ ok: false, error: 'Unknown deal' }, 404);
  const result = await fetchDealComps(deal, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    now: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
  brain.setDealComps(deal.id, result.comps);
  return c.json({ ok: true, comps: result.comps });
});
```

- [ ] **Step 3: Add the client wrapper**

In `src/data/actions.ts`, add the import and wrapper (this one returns the `CompSet`, so it doesn't use the void `postAction` helper):

```typescript
import type { CompSet } from '@contracts/index';
```
```typescript
export const refreshDealComps = async (dealId: string): Promise<CompSet> => {
  const res = await fetch('/api/actions/deal-comps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dealId }),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; comps?: CompSet; error?: string };
  if (!res.ok || !json.ok || !json.comps) throw new Error(json.error ?? `Comps request failed (${res.status})`);
  return json.comps;
};
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Verify the endpoint shape live (fresh server) — NO real web search needed**

Restart the Brain Server fresh (`node_modules\.bin\tsx server/index.ts`). Validation paths don't spend a web search:

```bash
curl -s -o NUL -w "%{http_code}\n" -X POST http://localhost:8911/api/actions/deal-comps -H "content-type: application/json" -d "{\"dealId\":\"\"}"
# Expected: 400 (invalid)
curl -s -o NUL -w "%{http_code}\n" -X POST http://localhost:8911/api/actions/deal-comps -H "content-type: application/json" -d "{\"dealId\":\"does-not-exist\"}"
# Expected: 404 (unknown deal)
```

A real refresh against a valid deal id spends Anthropic web searches (billed, ~15–30s) — defer that single live check to Track C verification.

- [ ] **Step 6: Commit**

```bash
git add server/brain.ts server/index.ts src/data/actions.ts
git commit -m "feat(comps): deal-comps mutator + endpoint + client action"
```

---

# TRACK C — Deal drawer v2

## Task C1: DealDrawer component

**Files:**
- Create: `src/brain/DealDrawer.tsx`

- [ ] **Step 1: Write the implementation**

Create `src/brain/DealDrawer.tsx`. A wide (max 1180px) deal-specific drawer: six cards in a responsive grid, a stage-progression track, and a right-side comps panel with a live-only Refresh. Reuses the existing handlers passed down from `EntityDrawer`.

```tsx
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Mail, ChevronRight, RefreshCw, ExternalLink, Lock } from 'lucide-react';
import type { PortfolioSnapshot, Deal, DealStage, CompSet } from '@contracts/index';
import type { DraftRequest } from './draft';
import type { EntityRef } from './ui-context';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtSf, fmtNum, fmtMultiple, fmtDate } from '@analytics/index';
import { SNAPSHOT_KEY } from '@/data/queries';
import { refreshDealComps } from '@/data/actions';
import { replacementCostAnalysis } from './replacement-cost';
import { Badge } from '@/primitives/Badge';

const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];
const nextStage = (s: DealStage): DealStage | null => {
  const i = STAGE_FLOW.indexOf(s);
  return i >= 0 && i < STAGE_FLOW.length - 1 ? STAGE_FLOW[i + 1]! : null;
};

export function DealDrawer({
  dealId, snapshot, canWrite, onClose, onOpen, onDraft, onAdvanceStage,
}: {
  dealId: string;
  snapshot: PortfolioSnapshot;
  canWrite: boolean;
  onClose: () => void;
  onOpen: (ref: EntityRef) => void;
  onDraft: (req: DraftRequest) => void;
  onAdvanceStage: (dealId: string, stage: DealStage, label: string) => void;
}) {
  const qc = useQueryClient();
  const deal = snapshot.deals.find((d) => d.id === dealId) ?? null;
  const comps: CompSet | undefined = snapshot.dealComps[dealId];
  const refresh = useMutation({
    mutationFn: () => refreshDealComps(dealId),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ns = deal ? nextStage(deal.stage) : null;
  const rc = deal ? replacementCostAnalysis(deal) : null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Deal detail">
      <motion.div className="absolute inset-0" style={{ background: 'rgba(2,4,8,0.5)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        className="absolute right-0 top-0 flex h-full w-[1180px] max-w-[96vw] flex-col"
        style={{ background: 'var(--surface-raised)', borderLeft: '1px solid var(--border-strong)' }}
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        {!deal ? (
          <div className="grid flex-1 place-items-center text-sm" style={{ color: 'var(--text-tertiary)' }}>Deal not found.</div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-3 px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge tone={deal.confidential ? 'purple' : 'gold'}>Deal</Badge>
                  <Badge tone="neutral">{deal.stage}</Badge>
                  {deal.confidential && <span className="flex items-center gap-1 text-2xs" style={{ color: 'var(--color-accent2)' }}><Lock size={11} /> Confidential</span>}
                </div>
                <h2 className="display text-xl leading-tight" style={{ color: 'var(--text-primary)' }}>{deal.name}</h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{deal.location ?? deal.market ?? '—'}</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                <X size={15} />
              </button>
            </header>

            <div className="flex min-h-0 flex-1">
              {/* LEFT — cards + stage track */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button onClick={() => onDraft({ kind: 'loi', entity: { type: 'deal', id: deal.id } })} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}>
                    <Mail size={13} /> Draft LOI handoff
                  </button>
                  {ns && canWrite && (
                    <button onClick={() => onAdvanceStage(deal.id, ns, `Advance to ${ns}`)} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>
                      Advance to {ns} <ChevronRight size={13} />
                    </button>
                  )}
                </div>

                <StageTrack stage={deal.stage} />

                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <CardBox title="Deal Detail">
                    <Row label="Market" value={deal.market ?? '—'} />
                    <Row label="Location" value={deal.location ?? '—'} />
                    <Row label="Square Feet" value={deal.sf !== null ? fmtSf(deal.sf) : '—'} />
                    <Row label="Buildings" value={deal.buildings ?? '—'} />
                    <Row label="Owner" value={deal.owner ?? '—'} />
                    <Row label="Target Close" value={fmtDate(deal.targetCloseDate)} />
                    <Row label="Next Action" value={deal.nextAction ?? '—'} />
                    <Row label="Status" value={deal.status ?? '—'} />
                  </CardBox>

                  <CardBox title="Returns">
                    <ReturnsBar label="Cap Rate" pct={deal.capRate} display={fmtPct(deal.capRate, 2)} scaleMaxPct={0.12} />
                    <ReturnsBar label="Levered IRR" pct={deal.irr} display={fmtPct(deal.irr)} scaleMaxPct={0.30} />
                    <ReturnsBar label="Equity Multiple" pct={deal.equityMultiple !== null ? deal.equityMultiple / 3 : null} display={deal.equityMultiple !== null ? fmtMultiple(deal.equityMultiple) : '—'} scaleMaxPct={1} />
                    <Row label="Hold" value={deal.holdYrs !== null ? `${deal.holdYrs} yr` : '—'} />
                  </CardBox>

                  <CardBox title="Underwriting Assumptions">
                    <Row label="Est. Price" value={fmtUsdCompact(deal.estPrice)} />
                    <Row label="Price / SF" value={deal.estPrice !== null && deal.sf ? `$${(deal.estPrice / deal.sf).toFixed(0)}` : '—'} />
                    <Row label="Cap Rate" value={fmtPct(deal.capRate, 2)} />
                    <Row label="Hold Period" value={deal.holdYrs !== null ? `${deal.holdYrs} yr` : '—'} />
                    {deal.estimatedFields.length > 0 && (
                      <div className="pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Estimated: {deal.estimatedFields.join(', ')}</div>
                    )}
                  </CardBox>

                  <CardBox title="Financing">
                    <Row label="Lender" value={deal.lender ?? '—'} />
                    <Row label="Est. Price" value={fmtUsdCompact(deal.estPrice)} />
                    <div className="pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Debt terms set at LOI/PSA — see Debt module once financed.</div>
                  </CardBox>

                  <CardBox title="Replacement Cost">
                    {rc ? (
                      <>
                        <Row label="Basis" value={rc.basis} />
                        <Row label="Replacement (range)" value={`${fmtUsdCompact(rc.low)} – ${fmtUsdCompact(rc.high)}`} />
                        <Row label="Replacement (mid)" value={fmtUsd(rc.mid)} />
                        <Row label="Price vs. Replacement" value={rc.priceToReplacementMid !== null ? `${(rc.priceToReplacementMid * 100).toFixed(0)}% of mid` : '—'} />
                        {rc.verdict && (
                          <div className="pt-1">
                            <Badge tone={rc.verdict === 'Discount to replacement' ? 'green' : rc.verdict === 'Premium to replacement' ? 'red' : 'amber'}>{rc.verdict}</Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>SF unknown — cannot compute replacement cost.</div>
                    )}
                  </CardBox>

                  <CardBox title="Risk Flags">
                    <RiskFlags deal={deal} />
                  </CardBox>
                </div>
              </div>

              {/* RIGHT — comps panel */}
              <aside className="flex w-[360px] max-w-[42vw] shrink-0 flex-col overflow-y-auto" style={{ borderLeft: '1px solid var(--border-subtle)', background: 'color-mix(in oklab, var(--surface-overlay) 40%, transparent)' }}>
                <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Market Comps</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {comps ? `AI-sourced · cached ${fmtDate(comps.sourcedAt.slice(0, 10))}` : 'Not yet researched'}
                    </div>
                  </div>
                  {canWrite && (
                    <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-2xs font-semibold" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', opacity: refresh.isPending ? 0.6 : 1 }} aria-label="Refresh market comps">
                      <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : ''} /> {comps ? 'Refresh' : 'Research'}
                    </button>
                  )}
                </div>

                <div className="flex flex-col gap-4 px-4 py-3">
                  {refresh.isPending && <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Researching comps via web search… this can take ~20s.</div>}
                  {refresh.isError && <div className="text-2xs" style={{ color: 'var(--color-neg)' }}>{(refresh.error as Error)?.message ?? 'Comp research failed.'}</div>}

                  {!comps && !refresh.isPending ? (
                    <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                      {canWrite ? 'No comps yet — click Research to web-search sale, rent, and submarket comparables.' : 'No comps cached. Refresh requires the live Brain Server.'}
                    </div>
                  ) : comps ? (
                    <>
                      {comps.summary && <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{comps.summary}</p>}

                      <CompSection title={`Sale Comps (${comps.saleComps.length})`}>
                        {comps.saleComps.map((sc, i) => (
                          <div key={i} className="rounded-[var(--radius-sm)] p-2" style={{ background: 'var(--surface-overlay)' }}>
                            <div className="text-2xs font-semibold" style={{ color: 'var(--text-primary)' }}>{sc.address}</div>
                            <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                              {[sc.price !== null ? fmtUsdCompact(sc.price) : null, sc.pricePerSf !== null ? `$${fmtNum(sc.pricePerSf)}/SF` : null, sc.capRate !== null ? `${(sc.capRate * 100).toFixed(2)}% cap` : null, sc.date].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <SourceLink source={sc.source} />
                          </div>
                        ))}
                      </CompSection>

                      <CompSection title={`Rent Comps (${comps.rentComps.length})`}>
                        {comps.rentComps.map((rcp, i) => (
                          <div key={i} className="rounded-[var(--radius-sm)] p-2" style={{ background: 'var(--surface-overlay)' }}>
                            <div className="text-2xs font-semibold" style={{ color: 'var(--text-primary)' }}>{rcp.address}</div>
                            <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                              {[rcp.rentPerSf !== null ? `$${fmtNum(rcp.rentPerSf)}/SF` : null, rcp.sf !== null ? fmtSf(rcp.sf) : null, rcp.leaseType, rcp.date].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <SourceLink source={rcp.source} />
                          </div>
                        ))}
                      </CompSection>

                      <CompSection title={`Submarket (${comps.submarketStats.length})`}>
                        {comps.submarketStats.map((st, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 text-2xs">
                            <span style={{ color: 'var(--text-tertiary)' }}>{st.label}</span>
                            <span className="num" style={{ color: 'var(--text-primary)' }}>{st.value}</span>
                          </div>
                        ))}
                      </CompSection>

                      {comps.sources.length > 0 && (
                        <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                          Sources: {comps.sources.length} · AI-sourced, verify before relying on figures.
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              </aside>
            </div>
          </>
        )}
      </motion.aside>
    </div>
  );
}

function StageTrack({ stage }: { stage: DealStage }) {
  const idx = STAGE_FLOW.indexOf(stage);
  return (
    <div className="flex items-center gap-1">
      {STAGE_FLOW.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        return (
          <div key={s} className="flex flex-1 flex-col items-center gap-1">
            <div className="h-1 w-full rounded-full" style={{ background: done ? 'var(--accent)' : 'var(--border-subtle)' }} />
            <span className="text-[9px] uppercase" style={{ letterSpacing: '0.06em', color: i === idx ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: i === idx ? 700 : 400 }}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}

function CardBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] p-3" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{title}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1" style={{ borderTop: '1px solid color-mix(in oklab, var(--border-subtle) 60%, transparent)' }}>
      <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-right text-xs" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function ReturnsBar({ label, pct, display, scaleMaxPct }: { label: string; pct: number | null; display: string; scaleMaxPct: number }) {
  const w = pct !== null && scaleMaxPct > 0 ? Math.max(0, Math.min(100, (pct / scaleMaxPct) * 100)) : 0;
  return (
    <div className="py-1">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
        <span className="num text-xs" style={{ color: 'var(--text-primary)' }}>{display}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-raised)' }}>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: 'var(--accent)' }} />
      </div>
    </div>
  );
}

function RiskFlags({ deal }: { deal: Deal }) {
  const flags: string[] = [];
  if (deal.confidential) flags.push('Confidential — internal only, no external surface');
  if (deal.stage === 'Dead') flags.push('Deal is marked Dead');
  if (deal.capRate === null) flags.push('Cap rate not set');
  if (deal.estPrice === null) flags.push('Estimated price not set');
  if (deal.sf === null) flags.push('Square footage unknown');
  if (deal.estimatedFields.length > 0) flags.push(`Estimated figures: ${deal.estimatedFields.join(', ')}`);
  if (flags.length === 0) return <div className="text-2xs" style={{ color: 'var(--color-pos)' }}>No flags.</div>;
  return (
    <ul className="flex flex-col gap-1">
      {flags.map((f, i) => (
        <li key={i} className="flex items-start gap-1.5 text-2xs" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--color-warn)' }}>•</span> {f}
        </li>
      ))}
    </ul>
  );
}

function CompSection({ title, children }: { title: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <div>
      <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{title}</div>
      {arr.length === 0 ? <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>None found.</div> : <div className="flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}

function SourceLink({ source }: { source: string }) {
  const isUrl = /^https?:\/\//.test(source);
  if (!isUrl) return <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{source}</div>;
  return (
    <a href={source} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--accent)' }}>
      <ExternalLink size={9} /> source
    </a>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (`fmtDate` accepts `string | null`; `snapshot.dealComps[dealId]` is `CompSet | undefined` under `noUncheckedIndexedAccess` — it's typed as `CompSet | undefined` and guarded with `comps ?` throughout.) If a `--color-accent2`/`--accent-quiet` var is reported, it's CSS only (those vars are used elsewhere in this file's siblings) — not a type error.

- [ ] **Step 3: Commit**

```bash
git add src/brain/DealDrawer.tsx
git commit -m "feat(comps): wide deal drawer (6 cards + stage track + comps panel)"
```

---

## Task C2: Route deals to the DealDrawer

**Files:**
- Modify: `src/brain/EntityDrawer.tsx`

- [ ] **Step 1: Import the DealDrawer**

At the top of `src/brain/EntityDrawer.tsx`, add:

```typescript
import { DealDrawer } from './DealDrawer';
```

- [ ] **Step 2: Branch the render to DealDrawer for deals**

Replace the `EntityDrawer` component's returned JSX (the `<AnimatePresence>{open && data && ui.selected && (<Panel ... />)}</AnimatePresence>`) so deals route to `DealDrawer` while everything else keeps `Panel`:

```tsx
  return (
    <AnimatePresence>
      {open && data && ui.selected &&
        (ui.selected.type === 'deal' ? (
          <DealDrawer
            dealId={ui.selected.id}
            snapshot={data.snapshot}
            canWrite={canWrite}
            onClose={ui.closeEntity}
            onOpen={ui.openEntity}
            onDraft={ui.openDraft}
            onAdvanceStage={onAdvanceStage}
          />
        ) : (
          <Panel
            content={resolve(ui.selected, data.snapshot)}
            onClose={ui.closeEntity}
            onOpen={ui.openEntity}
            onDraft={ui.openDraft}
            canWrite={canWrite}
            onAdvanceStage={onAdvanceStage}
          />
        ))}
    </AnimatePresence>
  );
```

(The `deal` case in `resolve()` is now unreachable but harmless — leave it as a typed fallback; do not delete it, to keep the diff minimal and the resolver total.)

- [ ] **Step 3: Typecheck + gate**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run gate`
Expected: typecheck + lint (`--max-warnings 0`) + tests + reconcile all green.

- [ ] **Step 4: Commit**

```bash
git add src/brain/EntityDrawer.tsx
git commit -m "feat(comps): route deal entities to the wide DealDrawer"
```

---

## Task C3: Verify end-to-end (fresh server)

- [ ] **Step 1: Start FRESH servers** (kill any stale dev server first — stale HMR is a known footgun). Brain Server `node_modules\.bin\tsx server/index.ts` (:8911) + Vite `npx vite --port 5273`.

- [ ] **Step 2: Verify the drawer in a clean browser session** (preview tools)

Open the app → **Acquisitions** → click a non-confidential deal row.
- Confirm a **wide** drawer opens (not the 440px panel) with: a stage-progression track; six cards — Deal Detail, Returns (bars), Underwriting Assumptions, Financing, Replacement Cost (showing the $85–$120/SF range + price-vs-replacement verdict), Risk Flags; and a right-side **Market Comps** panel reading "Not yet researched".
- Confirm the **Draft LOI handoff** button opens the draft composer and **Advance to …** advances the stage (live).
- Confirm a non-deal entity (e.g. a property from Portfolio) still opens the **narrow** 440px panel (no regression).
- Console: no errors.

- [ ] **Step 3: One real comps refresh (spends a billed web search)**

Click **Research** in the comps panel. Within ~30s the panel should populate with sale/rent/submarket comps (or a clear error if web search is disabled on the org). Confirm:
- On success: comps render with sources, the header shows "AI-sourced · cached <today>", and a reload keeps them (cached to `dealComps` in the overlay).
- On "web search disabled"/error: the panel shows the error message cleanly (no crash). If so, note it for Gabriel — enabling web search is an Anthropic org setting; the feature is otherwise complete.

Screenshot the populated (or gracefully-errored) drawer.

- [ ] **Step 4: Clean up** — if the real refresh wrote comps to `data/overlay.json` for a deal you don't want cached, remove that `dealComps` entry (reset `data/overlay.json` or delete the key) and restart the server. Confirm `git status` is clean (overlay is gitignored).

---

# Final verification

- [ ] **Step 1:** `npm run gate` green.
- [ ] **Step 2:** `npm run build` succeeds (the DealDrawer rides in an existing chunk; no new lazy module).
- [ ] **Step 3:** `git status --porcelain` clean; `git check-ignore data/overlay.json` still ignored.
- [ ] **Step 4: Confidentiality** — no confidential codename (case-insensitive) in any new file. Confirm the comps prompt never special-cases or exposes a confidential deal; the drawer shows the existing `confidential` badge + a Risk-Flags note, and confidential deals are redacted on the public mirror by the existing bake.
- [ ] **Step 5: Final review** (per subagent-driven-development) across the branch vs. the Phase 3 ⑦ design: on-demand Refresh ✓, comps cached to overlay + survive restart ✓, AI-sourced + cached-date provenance ✓, six-card rebalanced drawer (capped 1180px) incl. Replacement Cost ✓, stage track ✓, right-side comps panel ✓.
- [ ] **Step 6: Push + PR** — **pause for Gabriel's confirmation before pushing.** Then `git push -u origin feat/cc-phase3-deal-comps` and open the PR.

## Self-review notes (author checklist — completed during planning)

- **Spec coverage:** Trigger = on-demand Refresh button ✓; web-search across CoStar/LoopNet/CREXI (Anthropic web_search tool, prompt names them) ✓; persistence to deal overlay surviving restart (`dealComps` overlay key) ✓; provenance AI-sourced + cached[date] ✓; drawer rebalanced ≤1180px with six cards incl. Replacement Cost + full-width stage track + right-side comps panel ✓; `get_market_comps` reused by the Ask agent is **deferred** (the dedicated endpoint/routine ships the panel; exposing the same routine as an Ask-agent tool is a small follow-up, noted here, not built).
- **Type consistency:** `CompSet`/`SaleComp`/`RentComp`/`SubmarketStat` identical across contract, server routine, overlay, and drawer. `fetchDealComps` result union (`{ok:true,comps}|{ok:false,error}`) handled at the endpoint and the client wrapper. `replacementCostAnalysis` shape matches the drawer's Replacement Cost card.
- **`noUncheckedIndexedAccess`:** `snapshot.dealComps[dealId]` typed `CompSet | undefined`, guarded by `comps ?`; comp arrays indexed via `.map`; test array access uses `!`.
- **Overlay discipline:** `dealComps` is an additive overlay key merged in `applyOverlay` (no base mutation), surfaced as a `.default({})` snapshot field, written only via the validated endpoint + `brain.setDealComps`; workbook untouched; `data/overlay.json` gitignored.
- **Graceful degrade:** missing key / HTTP error / no record_comps block all return `{ok:false,error}`; the UI renders the message without crashing — the feature ships even if web search isn't enabled on the org.
- **No placeholders:** every code step shows complete code; every run step states the exact command + expected result.
