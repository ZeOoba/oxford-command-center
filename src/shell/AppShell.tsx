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

const TITLES: Record<string, string> = {
  overview: 'Command Overview',
  pipeline: 'Acquisitions Pipeline',
  portfolio: 'Portfolio Health',
  leases: 'Leases & Renewals',
  debt: 'Debt & Maturities',
  cash: 'Cash & Treasury',
  insurance: 'Insurance Renewals',
  market: 'Market & Macro',
  tasks: 'Tasks & Checklist',
  health: 'System Health',
};

export function AppShell() {
  const ui = useUi();
  const { moduleId } = useParams();
  const [collapsed, setCollapsed] = useState(false);
  const snap = useSnapshot();
  const data = snap.data;
  const active = MODULES.find((m) => m.id === ui.activeModuleId) ?? MODULES[0]!;
  const Active = active.Component;

  // Unknown module path → normalize the URL to the default view.
  if (moduleId && !MODULES.some((m) => m.id === moduleId)) {
    return <Navigate to="/overview" replace />;
  }

  return (
    <div className="flex h-dvh overflow-hidden" style={{ background: 'var(--surface-base)' }}>
      <Sidebar
        activeId={ui.activeModuleId}
        onSelect={ui.setActiveModule}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={TITLES[active.id] ?? active.label}
          asOf={data?.snapshot.meta.asOf ?? ''}
          onOpenSearch={ui.openPalette}
        />
        <StaleBanner />
        <main className="flex-1 overflow-y-auto px-5 py-5">
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
  );
}
