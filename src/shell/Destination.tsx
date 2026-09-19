// src/shell/Destination.tsx
//
// Generic two-level destination: a rail item whose body is a tab strip over existing modules
// (IA decongestion Phase 4a). The registry declares the tabs (`ModuleDef.tabs`); this renders
// them. `?tab=` is the URL mechanism (R10); inactive panels unmount (RAC default); the strip uses
// manual keyboard activation because every panel fires its own queries on mount (R9).
import { Suspense } from 'react';
import { Tabs, TabPanel, type TabSpec } from '@/primitives/Tabs';
import { useTabParam } from '@/lib/useTabParam';
import { ModuleLoading } from './ModuleFallback';
import { useTabBadges } from './tab-badges';
import { warnIfTooManyTabs, type ModuleTabDef } from './tab-types';

export function Destination({ id, label, tabs }: { id: string; label: string; tabs: readonly ModuleTabDef[] }) {
  warnIfTooManyTabs(id, tabs);
  const keys = tabs.map((t) => t.id);
  const [tab, setTab] = useTabParam<string>(keys, keys[0]!);
  const badges = useTabBadges(tabs);
  const specs: TabSpec[] = tabs.map((t, i) => {
    const badge = badges[i];
    return badge ? { id: t.id, label: t.label, badge } : { id: t.id, label: t.label };
  });
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
