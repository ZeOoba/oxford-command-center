import { Suspense, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { MODULES } from './modules';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useSnapshot } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { CommandPalette } from '@/brain/CommandPalette';
import { EntityDrawer } from '@/brain/EntityDrawer';
import { DraftPanel } from '@/brain/DraftPanel';
import { AiPanel } from '@/brain/AiPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { ModuleLoading, ModuleError } from './ModuleFallback';
import { StaleBanner } from './StaleBanner';
import { PortfolioFilterProvider, filterProperties, usePortfolioFilter } from './PortfolioFilterContext';
import { PortfolioFilterBar } from './PortfolioFilterBar';
import type { Property } from '@contracts/index';

const TITLES: Record<string, string> = {
  overview: 'Command Overview',
  pipeline: 'Acquisitions Pipeline',
  portfolio: 'Portfolio Health',
  intel: 'Property Financial Intelligence',
  leases: 'Leases & Renewals',
  debt: 'Debt & Maturities',
  cash: 'Cash & Treasury',
  insurance: 'Insurance Renewals',
  market: 'Market & Macro',
  tasks: 'Tasks & Checklist',
  documents: 'Documents',
  health: 'System Health',
  principal: 'Principal Home',
};

// `Property` (Spine A / `PortfolioSnapshot.properties`) carries no per-property manager
// attribution today — that lives only in the Spine B warehouse (see
// src/shell/PortfolioFilterContext.tsx for the full note). Empty until a future module
// supplies manager-enriched rows; the filter dimension is wired end-to-end regardless.
const NO_MANAGERS: string[] = [];

/**
 * Reads the active portfolio filter from context and derives the display-only slice
 * readout ("N of M assets · $X.XM NOI") from already-fetched snapshot rows — no new fetch.
 * Lives INSIDE PortfolioFilterProvider so it can consume the filter; AppShell renders the
 * provider itself and therefore cannot read the filter directly. Filtering reuses the
 * context's own `filterProperties` helper (`Property` satisfies `PortfolioRow`), so no
 * predicate logic is duplicated. NOI-per-property is already present on each row (`noi`,
 * Oxford share), so the summed figure needs no new analytics computation.
 */
function FilterBarWithSlice({ properties }: { properties: Property[] }) {
  const { filter } = usePortfolioFilter();
  const total = properties.length;
  const matched = filterProperties(properties, filter);
  const slice =
    total > 0
      ? { shown: matched.length, total, noiUsd: matched.reduce((sum, p) => sum + p.noi, 0) }
      : undefined;
  return <PortfolioFilterBar managers={NO_MANAGERS} slice={slice} />;
}

export function AppShell() {
  const ui = useUi();
  const { moduleId } = useParams();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const snap = useSnapshot();
  const data = snap.data;
  const active = MODULES.find((m) => m.id === ui.activeModuleId) ?? MODULES[0]!;
  const Active = active.Component;

  // Unknown module path → normalize the URL to the default view.
  if (moduleId && !MODULES.some((m) => m.id === moduleId)) {
    return <Navigate to="/overview" replace />;
  }

  return (
    <PortfolioFilterProvider>
      <div className="flex h-dvh overflow-hidden" style={{ background: 'var(--surface-base)' }}>
        <Sidebar
          activeId={ui.activeModuleId}
          onSelect={ui.setActiveModule}
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            title={TITLES[active.id] ?? active.label}
            asOf={data?.snapshot.meta.asOf ?? ''}
            onOpenSearch={ui.openPalette}
            onOpenNav={() => setMobileNavOpen(true)}
            navOpen={mobileNavOpen}
          />
          <FilterBarWithSlice properties={data?.snapshot.properties ?? []} />
          <StaleBanner />
          <main className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 lg:px-5 lg:py-5">
            <div className="mx-auto max-w-[1500px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={ui.activeModuleId}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  <ErrorBoundary key={ui.activeModuleId}>
                    {snap.isError ? (
                      <ModuleError onRetry={() => void snap.refetch()} message={(snap.error as Error | null)?.message} />
                    ) : snap.isLoading && !data ? (
                      <ModuleLoading />
                    ) : (
                      <Suspense fallback={<ModuleLoading />}>
                        <Active />
                      </Suspense>
                    )}
                  </ErrorBoundary>
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>

        <CommandPalette />
        <EntityDrawer />
        <DraftPanel />
        <AiPanel />
      </div>
    </PortfolioFilterProvider>
  );
}
