// src/shell/Destination.tsx
//
// Generic two-level destination: a rail item whose body is a tab strip over existing modules
// (IA decongestion Phase 4a). The registry declares the tabs (`ModuleDef.tabs`); this renders
// them. `?tab=` is the URL mechanism (R10); inactive panels unmount (RAC default); the strip uses
// manual keyboard activation because every panel fires its own queries on mount (R9).
import { Suspense } from 'react';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { ModuleLoading } from './ModuleFallback';
import { useTabSpecs } from './tab-badges';
import { warnIfTooManyTabs, type ModuleTabDef } from './tab-types';

export function Destination({ id, label, tabs }: { id: string; label: string; tabs: readonly ModuleTabDef[] }) {
  warnIfTooManyTabs(id, tabs);
  const keys = tabs.map((t) => t.id);
  const [tab, setTab] = useTabParam<string>(keys, keys[0]!, 'tab', CLEAR_VIEW);
  const specs = useTabSpecs(tabs);
  return (
    <Tabs tabs={specs} selectedKey={tab} onSelectionChange={setTab} keyboardActivation="manual" aria-label={`${label} views`}>
      {tabs.map((t) => {
        const Panel = t.Component;
        return (
          <TabPanel key={t.id} id={t.id}>
            <Suspense fallback={<ModuleLoading />}>{Panel ? <Panel /> : null}</Suspense>
          </TabPanel>
        );
      })}
    </Tabs>
  );
}
