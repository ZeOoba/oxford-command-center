# Role-Based Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-device view switcher (Acquisitions ⇄ Principal) that changes the default landing + rail ordering and adds a tailored, mobile-responsive Principal home with a "Needs your attention" decision queue.

**Architecture:** A `localStorage`-backed `ViewProfile` context drives pure config (`PROFILE_HOME`, `orderedModules`) consumed by the index redirect and the sidebar, plus one new `PrincipalModule` rendering a pure `principalDigest`. Reuses existing analytics/snapshot, so it inherits live auto-refresh + freshness for free.

**Tech Stack:** React 19, react-router-dom 6, TanStack Query, TypeScript, Vitest (jsdom + @testing-library/react).

**Spec:** `docs/superpowers/specs/2026-06-04-role-based-views-design.md`

**Test commands:** single file → `npx vitest run tests/unit/<file>`; full gate → `npm run gate`.

---

### Task 1: View-profile store + context

**Files:**
- Create: `src/brain/view-profile.tsx`
- Test: `tests/unit/view-profile.test.tsx`

- [ ] **Step 1: Write the failing test** — `tests/unit/view-profile.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { loadProfile, saveProfile, ViewProfileProvider, useViewProfile } from '../../src/brain/view-profile';

beforeEach(() => localStorage.clear());

describe('view-profile store', () => {
  it('defaults to acquisitions when nothing is stored', () => {
    expect(loadProfile()).toBe('acquisitions');
  });
  it('tolerates a junk stored value', () => {
    localStorage.setItem('ora-view', 'nonsense');
    expect(loadProfile()).toBe('acquisitions');
  });
  it('round-trips a saved profile', () => {
    saveProfile('principal');
    expect(loadProfile()).toBe('principal');
  });
});

describe('useViewProfile', () => {
  it('exposes the profile and persists changes', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <ViewProfileProvider>{children}</ViewProfileProvider>;
    const { result } = renderHook(() => useViewProfile(), { wrapper });
    expect(result.current.profile).toBe('acquisitions');
    act(() => result.current.setProfile('principal'));
    expect(result.current.profile).toBe('principal');
    expect(localStorage.getItem('ora-view')).toBe('principal');
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/view-profile.test.tsx`; confirm FAIL** (module missing).

- [ ] **Step 3: Implement** `src/brain/view-profile.tsx`:

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';

export type ViewProfile = 'acquisitions' | 'principal';
const KEY = 'ora-view';
const PROFILES: ViewProfile[] = ['acquisitions', 'principal'];

export function loadProfile(): ViewProfile {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (PROFILES as string[]).includes(v)) return v as ViewProfile;
  } catch { /* localStorage unavailable */ }
  return 'acquisitions';
}

export function saveProfile(p: ViewProfile): void {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
}

interface Ctx { profile: ViewProfile; setProfile: (p: ViewProfile) => void }
const ViewProfileContext = createContext<Ctx | null>(null);

export function ViewProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfileState] = useState<ViewProfile>(() => loadProfile());
  const setProfile = (p: ViewProfile) => { setProfileState(p); saveProfile(p); };
  return <ViewProfileContext.Provider value={{ profile, setProfile }}>{children}</ViewProfileContext.Provider>;
}

export function useViewProfile(): Ctx {
  const c = useContext(ViewProfileContext);
  if (!c) throw new Error('useViewProfile must be used within ViewProfileProvider');
  return c;
}
```

- [ ] **Step 4: Run `npx vitest run tests/unit/view-profile.test.tsx`; confirm PASS. Then `npm run gate`; confirm green.**

- [ ] **Step 5: Commit:**
```bash
git add src/brain/view-profile.tsx tests/unit/view-profile.test.tsx
git commit -m "feat(views): view-profile store + context (localStorage, default acquisitions)"
```

---

### Task 2: Module-order config (pure)

**Files:**
- Create: `src/shell/module-order.ts`
- Test: `tests/unit/module-order.test.ts`

Note: `MODULES` (from `src/shell/modules.tsx`) gains a `principal` entry in Task 4. This task's config references the id `'principal'`; `orderedModules` tolerates ids missing from the registry, so tests here use an injected module list.

- [ ] **Step 1: Write the failing test** — `tests/unit/module-order.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ModuleDef } from '../../src/shell/modules';
import { MODULE_ORDER, PROFILE_HOME, orderedModules } from '../../src/shell/module-order';

const mod = (id: string, group: ModuleDef['group'] = 'Command'): ModuleDef =>
  ({ id, label: id, icon: (() => null) as unknown as ModuleDef['icon'], group, Component: () => null });

describe('module-order', () => {
  it('home is pipeline for acquisitions, principal for principal', () => {
    expect(PROFILE_HOME.acquisitions).toBe('pipeline');
    expect(PROFILE_HOME.principal).toBe('principal');
  });

  it('orders modules by the profile list and appends unlisted ids at the end', () => {
    const registry = [mod('overview'), mod('pipeline'), mod('principal'), mod('extra')];
    const ids = orderedModules('acquisitions', registry).map((m) => m.id);
    // acquisitions order leads with overview, pipeline; 'extra' (unlisted) goes last
    expect(ids[0]).toBe('overview');
    expect(ids.indexOf('pipeline')).toBeLessThan(ids.indexOf('principal'));
    expect(ids.at(-1)).toBe('extra');
  });

  it('principal profile ranks the principal home first and capital ahead of assets', () => {
    const registry = [mod('portfolio', 'Assets'), mod('cash', 'Capital'), mod('principal', 'Command'), mod('overview', 'Command')];
    const ids = orderedModules('principal', registry).map((m) => m.id);
    expect(ids[0]).toBe('principal');
    expect(ids.indexOf('cash')).toBeLessThan(ids.indexOf('portfolio'));
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/module-order.test.ts`; confirm FAIL** (module missing).

- [ ] **Step 3: Implement** `src/shell/module-order.ts`:

```ts
import { MODULES, type ModuleDef } from './modules';
import type { ViewProfile } from '@/brain/view-profile';

/** Rail order per profile (flat module-id lists). Capital ahead of Assets for the principal. */
export const MODULE_ORDER: Record<ViewProfile, string[]> = {
  acquisitions: ['overview', 'pipeline', 'tasks', 'principal', 'portfolio', 'leases', 'debt', 'cash', 'insurance', 'market', 'relationships', 'documents', 'health'],
  principal: ['principal', 'overview', 'tasks', 'cash', 'debt', 'insurance', 'portfolio', 'leases', 'market', 'relationships', 'pipeline', 'documents', 'health'],
};

/** Where each profile lands from `/`. */
export const PROFILE_HOME: Record<ViewProfile, string> = {
  acquisitions: 'pipeline',
  principal: 'principal',
};

/** Registry sorted by the profile's order; unlisted ids append at the end (never disappear). */
export function orderedModules(profile: ViewProfile, modules: ModuleDef[] = MODULES): ModuleDef[] {
  const order = MODULE_ORDER[profile];
  const rank = (id: string) => { const i = order.indexOf(id); return i === -1 ? order.length : i; };
  return [...modules].sort((a, b) => rank(a.id) - rank(b.id));
}
```

- [ ] **Step 4: Run `npx vitest run tests/unit/module-order.test.ts`; confirm PASS. Then `npm run gate`; confirm green.**

- [ ] **Step 5: Commit:**
```bash
git add src/shell/module-order.ts tests/unit/module-order.test.ts
git commit -m "feat(views): per-profile module order + profile home (pure)"
```

---

### Task 3: Principal decision queue (pure `principalDigest`)

**Files:**
- Create: `src/brain/principal-digest.ts`
- Test: `tests/unit/principal-digest.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/principal-digest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AnalyticsBundle } from '../../src/analytics/index';
import type { Insight } from '../../src/analytics/types';
import { principalDigest } from '../../src/brain/principal-digest';

const insight = (o: Partial<Insight>): Insight => ({ id: 'i', severity: 'info', category: 'debt', title: 'T', detail: 'D', ...o });
const deal = (o: Record<string, unknown>) => ({ id: 'd1', name: 'Cedar', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: 'Sign PSA', owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o });

function fixture(insights: Insight[], deals: unknown[]) {
  return {
    snapshot: { deals } as unknown as PortfolioSnapshot,
    analytics: { insights } as unknown as AnalyticsBundle,
  };
}

describe('principalDigest', () => {
  it('includes critical+warning insights and excludes info', () => {
    const { snapshot, analytics } = fixture(
      [insight({ id: 'c', severity: 'critical', title: 'Balloon' }), insight({ id: 'w', severity: 'warning', title: 'DSCR' }), insight({ id: 'n', severity: 'info', title: 'Occ' })],
      [],
    );
    const ids = principalDigest(snapshot, analytics).map((x) => x.id);
    expect(ids).toContain('c'); expect(ids).toContain('w'); expect(ids).not.toContain('n');
  });

  it('includes deals in LOI/PSA or Closing and excludes other stages', () => {
    const { snapshot, analytics } = fixture([], [deal({ id: 'a', stage: 'LOI/PSA' }), deal({ id: 'b', stage: 'Closing' }), deal({ id: 'c', stage: 'Candidate' })]);
    const ids = principalDigest(snapshot, analytics).map((x) => x.id);
    expect(ids).toContain('deal-a'); expect(ids).toContain('deal-b'); expect(ids).not.toContain('deal-c');
  });

  it('sorts critical insights before warnings before deals', () => {
    const { snapshot, analytics } = fixture(
      [insight({ id: 'w', severity: 'warning' }), insight({ id: 'c', severity: 'critical' })],
      [deal({ id: 'a', stage: 'Closing' })],
    );
    expect(principalDigest(snapshot, analytics).map((x) => x.id)).toEqual(['c', 'w', 'deal-a']);
  });

  it('returns [] for an empty snapshot', () => {
    const { snapshot, analytics } = fixture([], []);
    expect(principalDigest(snapshot, analytics)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/principal-digest.test.ts`; confirm FAIL** (module missing).

- [ ] **Step 3: Implement** `src/brain/principal-digest.ts`:

```ts
import type { PortfolioSnapshot } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';

export interface DigestItem {
  id: string;
  kind: 'insight' | 'deal';
  rank: number; // 0 critical, 1 warning, 2 deal — sort key
  title: string;
  detail: string;
}

const ATTENTION_STAGES = new Set(['LOI/PSA', 'Closing']);

/** Items needing a principal's eye: critical/warning insights + deals in LOI/PSA or Closing. */
export function principalDigest(snapshot: PortfolioSnapshot, analytics: AnalyticsBundle): DigestItem[] {
  const items: DigestItem[] = [];

  for (const i of analytics.insights) {
    if (i.severity === 'critical' || i.severity === 'warning') {
      items.push({ id: i.id, kind: 'insight', rank: i.severity === 'critical' ? 0 : 1, title: i.title, detail: i.detail });
    }
  }
  for (const d of snapshot.deals) {
    if (ATTENTION_STAGES.has(d.stage)) {
      items.push({ id: `deal-${d.id}`, kind: 'deal', rank: 2, title: d.shortName ?? d.name, detail: `${d.stage}${d.nextAction ? ` · ${d.nextAction}` : ''}` });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}
```

- [ ] **Step 4: Run `npx vitest run tests/unit/principal-digest.test.ts`; confirm PASS. Then `npm run gate`; confirm green.**

- [ ] **Step 5: Commit:**
```bash
git add src/brain/principal-digest.ts tests/unit/principal-digest.test.ts
git commit -m "feat(views): principalDigest decision queue (pure)"
```

---

### Task 4: Principal home module (responsive) + register

**Files:**
- Create: `src/modules/principal/PrincipalModule.tsx`
- Modify: `src/shell/modules.tsx` (register), `src/shell/AppShell.tsx` (TITLES)
- Test: `tests/unit/principal-module.test.tsx`

- [ ] **Step 1: Write the failing test** — `tests/unit/principal-module.test.tsx`. We unit-test the pure presenter `principalSections` (extracted) so the test needs no data providers:

```tsx
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AnalyticsBundle } from '../../src/analytics/index';
import { principalKpis } from '../../src/modules/principal/PrincipalModule';

function bundle(): { snapshot: PortfolioSnapshot; analytics: AnalyticsBundle } {
  const analytics = { kpis: { noi: { value: 2_684_150, prov: 'derived' }, value: { value: 41_872_300, prov: 'derived' }, occupancy: { value: 0.94, prov: 'derived' } }, insights: [] } as unknown as AnalyticsBundle;
  const snapshot = { cash: { totalCash: 5_312_640 } } as unknown as PortfolioSnapshot;
  return { snapshot, analytics };
}

describe('principalKpis', () => {
  it('formats the headline figures', () => {
    const k = principalKpis(bundle().snapshot, bundle().analytics);
    expect(k.find((x) => x.label === 'NOI')?.display).toMatch(/\$2\.68/);
    expect(k.find((x) => x.label === 'Occupancy')?.display).toBe('94%');
    expect(k.find((x) => x.label === 'Cash')?.display).toMatch(/\$5\.3/);
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/principal-module.test.tsx`; confirm FAIL** (module missing).

- [ ] **Step 3: Implement** `src/modules/principal/PrincipalModule.tsx`. Uses the existing `useSnapshot`/`useAnalytics`, the `Card`/`KpiStat` primitives, `principalDigest`, and `fmtUsdCompact`/`fmtPct` (from `@analytics/index`). The grid is responsive (`grid-cols-1` → `sm:grid-cols-2` → `lg:grid-cols-4`).

> Spec mapping: the spec listed "debt maturities + DSCR/covenant watch" and "cash concentration" as Principal-home content. Those are exactly the critical/warning insights produced by the analytics engine (balloon-maturity, DSCR<1.25, cash-concentration), so they surface inside the prioritized **"Needs your attention"** queue rather than as duplicate standalone cards — and the rail emphasizes the dedicated Debt/Cash modules for the principal. This is intentional (single prioritized list > scattered cards), not an omission.

```tsx
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { fmtUsdCompact, fmtPct } from '@analytics/index';
import type { PortfolioSnapshot } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';
import { principalDigest } from '@/brain/principal-digest';

export interface PrincipalKpi { label: string; display: string }

/** Headline figures for the Principal home. Pure (exported for tests). */
export function principalKpis(snapshot: PortfolioSnapshot, analytics: AnalyticsBundle): PrincipalKpi[] {
  return [
    { label: 'NOI', display: fmtUsdCompact(analytics.kpis.noi.value) },
    { label: 'Portfolio value', display: fmtUsdCompact(analytics.kpis.value.value) },
    { label: 'Occupancy', display: fmtPct(analytics.kpis.occupancy.value) },
    { label: 'Cash', display: fmtUsdCompact(snapshot.cash.totalCash) },
  ];
}

export function PrincipalModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  if (!data || !analytics) return <ModuleLoading />;

  const kpis = principalKpis(data.snapshot, analytics);
  const digest = principalDigest(data.snapshot, analytics);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiStat key={k.label} label={k.label} value={null} format={() => k.display} accentColor="var(--accent)" />
        ))}
      </div>

      <Card>
        <CardHeader title="Needs your attention" trailing={<Badge tone={digest.length ? 'amber' : 'green'}>{digest.length}</Badge>} />
        {digest.length === 0 ? (
          <div className="px-4 py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>Nothing needs a decision right now.</div>
        ) : (
          <ul className="flex flex-col">
            {digest.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>{item.title}</strong> — {item.detail}</span>
                <Badge tone={item.kind === 'insight' ? (item.rank === 0 ? 'red' : 'amber') : 'neutral'}>{item.kind === 'deal' ? 'deal' : item.rank === 0 ? 'critical' : 'review'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

Then register it. In `src/shell/modules.tsx`:
- Add the lazy import (next to the others): `const PrincipalModule = lazy(() => import('@/modules/principal/PrincipalModule').then((m) => ({ default: m.PrincipalModule })));`
- Add to `MODULES` (place right after the `overview` entry), using the `LayoutDashboard`-adjacent icon `Briefcase` (add `Briefcase` to the lucide import list):
  `{ id: 'principal', label: 'Principal Home', icon: Briefcase, group: 'Command', Component: PrincipalModule },`

In `src/shell/AppShell.tsx`, add to the `TITLES` map: `principal: 'Principal Home',`.

- [ ] **Step 3a: Verify primitives.** Confirm `Card`/`CardHeader` (`@/primitives/Card`), `KpiStat` (`@/primitives/KpiStat`), and `Badge` (`@/primitives/Badge`) export the props used here (`KpiStat` is used the same way in `src/modules/documents/DocumentsModule.tsx`; `Badge` tones `red/amber/green/neutral` are used in `HealthModule.tsx`). If a prop name differs, match the existing usage. Confirm `fmtUsdCompact`/`fmtPct` are exported from `@analytics/index`.

- [ ] **Step 4: Run `npx vitest run tests/unit/principal-module.test.tsx`; confirm PASS. Then `npm run gate`; confirm green** (the component itself is covered by typecheck + the `principalKpis`/`principalDigest` unit tests).

- [ ] **Step 5: Commit:**
```bash
git add src/modules/principal/PrincipalModule.tsx src/shell/modules.tsx src/shell/AppShell.tsx tests/unit/principal-module.test.tsx
git commit -m "feat(views): responsive Principal home (KPIs + needs-your-attention queue)"
```

---

### Task 5: Wire it together — provider, home redirect, sidebar order, toggle

**Files:**
- Modify: `src/App.tsx` (wrap with `ViewProfileProvider`, profile-aware index redirect)
- Modify: `src/shell/Sidebar.tsx` (order rail by profile)
- Create: `src/shell/ViewToggle.tsx`; Modify `src/shell/TopBar.tsx` (mount it)
- Test: `tests/unit/view-toggle.test.tsx`

- [ ] **Step 1: Write the failing test** — `tests/unit/view-toggle.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewProfileProvider } from '../../src/brain/view-profile';
import { ViewToggle } from '../../src/shell/ViewToggle';

beforeEach(() => localStorage.clear());

describe('ViewToggle', () => {
  it('flips the profile and persists it', () => {
    render(<ViewProfileProvider><ViewToggle /></ViewProfileProvider>);
    fireEvent.click(screen.getByRole('button', { name: /principal/i }));
    expect(localStorage.getItem('ora-view')).toBe('principal');
    fireEvent.click(screen.getByRole('button', { name: /acquisitions/i }));
    expect(localStorage.getItem('ora-view')).toBe('acquisitions');
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/unit/view-toggle.test.tsx`; confirm FAIL** (module missing).

- [ ] **Step 3: Implement.**

Create `src/shell/ViewToggle.tsx`:

```tsx
import { useViewProfile, type ViewProfile } from '@/brain/view-profile';

const OPTIONS: { id: ViewProfile; label: string }[] = [
  { id: 'acquisitions', label: 'Acquisitions' },
  { id: 'principal', label: 'Principal' },
];

export function ViewToggle() {
  const { profile, setProfile } = useViewProfile();
  return (
    <div className="hidden items-center rounded-full p-0.5 sm:inline-flex" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      {OPTIONS.map((o) => {
        const active = o.id === profile;
        return (
          <button
            key={o.id}
            onClick={() => setProfile(o.id)}
            aria-pressed={active}
            className="num rounded-full px-2.5 py-1 text-2xs font-semibold transition-colors"
            style={active
              ? { background: 'var(--accent-quiet)', color: 'var(--accent)' }
              : { background: 'transparent', color: 'var(--text-tertiary)' }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

In `src/shell/TopBar.tsx`: add `import { ViewToggle } from './ViewToggle';` and place `<ViewToggle />` immediately before `<ScenarioSwitch />` (line ~50).

In `src/App.tsx`: import the provider + helpers, wrap `<Routes>` with `<ViewProfileProvider>`, and replace the static index redirect with a profile-aware one.

```tsx
import { ViewProfileProvider, useViewProfile } from '@/brain/view-profile';
import { PROFILE_HOME } from '@/shell/module-order';
// ...
function HomeRedirect() {
  const { profile } = useViewProfile();
  return <Navigate to={`/${PROFILE_HOME[profile]}`} replace />;
}
```
Wrap the routes (inside `<UiProvider>`):
```tsx
<UiProvider>
  <ViewProfileProvider>
    <Routes>
      <Route index element={<HomeRedirect />} />
      <Route path=":moduleId/*" element={<AppShell />} />
    </Routes>
  </ViewProfileProvider>
</UiProvider>
```

In `src/shell/Sidebar.tsx`: order the rail by profile while keeping group headers (groups appear in the order their first member appears). Replace the `MODULE_GROUPS.map(...)` block. Change the imports at the top from `import { MODULES, MODULE_GROUPS, type ModuleDef } from './modules';` to:
```tsx
import { type ModuleDef } from './modules';
import { orderedModules } from './module-order';
import { useViewProfile } from '@/brain/view-profile';
```
Inside `Sidebar`, before `return`:
```tsx
  const { profile } = useViewProfile();
  const ordered = orderedModules(profile);
  const groups = [...new Set(ordered.map((m) => m.group))];
```
Replace `{MODULE_GROUPS.map((group) => { const items = MODULES.filter((m) => m.group === group); ... })}` with:
```tsx
        {groups.map((group) => {
          const items = ordered.filter((m) => m.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="mb-3">
              {!collapsed && (
                <div className="num px-2 pb-1.5 text-[9px] font-semibold uppercase" style={{ letterSpacing: '0.16em', color: 'var(--text-tertiary)' }}>
                  {group}
                </div>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((m) => (
                  <NavItem key={m.id} module={m} active={m.id === activeId} collapsed={collapsed} onSelect={() => onSelect(m.id)} />
                ))}
              </ul>
            </div>
          );
        })}
```

- [ ] **Step 3a: Verify** there are no remaining references to the removed `MODULES`/`MODULE_GROUPS` imports in `Sidebar.tsx` (the lint gate has `no-unused-vars` at max-warnings 0).

- [ ] **Step 4: Run `npx vitest run tests/unit/view-toggle.test.tsx`; confirm PASS. Then `npm run gate`; confirm green.**

- [ ] **Step 5: Commit:**
```bash
git add src/App.tsx src/shell/Sidebar.tsx src/shell/ViewToggle.tsx src/shell/TopBar.tsx tests/unit/view-toggle.test.tsx
git commit -m "feat(views): wire profile — home redirect, profile-ordered rail, header toggle"
```

---

## Final verification

- [ ] `npm run gate` — typecheck (3 tsconfigs) clean, lint 0 warnings, all tests pass (target ~132), reconcile $0.
- [ ] `npm run build && npm run check:bundle` — within budget; the `principal` route is its own lazy chunk.
- [ ] Push (or finishing step) and confirm CI green.
- [ ] Smoke (manual): toggle to Principal → lands on the Principal home (KPIs + "Needs your attention"); rail leads with Principal/Capital; refresh persists the choice; toggle to Acquisitions → lands on the pipeline. Narrow the window to phone width → the Principal home stacks to one column.
