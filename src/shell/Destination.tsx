// src/shell/Destination.tsx
//
// Generic two-level destination: a rail item whose body is a tab strip over existing modules
// (IA decongestion Phase 4a). The registry declares the tabs (`ModuleDef.tabs`); this renders
// them. `?tab=` is the URL mechanism (R10); inactive panels unmount (RAC default); the strip uses
// manual keyboard activation because every panel fires its own queries on mount (R9).
import { Suspense, type ReactNode } from 'react';
import { Tabs, TabPanel, type TabSpec } from '@/primitives/Tabs';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { ModuleLoading } from './ModuleFallback';
import { useTabBadges } from './tab-badges';
import { warnIfTooManyTabs, type ModuleTabDef } from './tab-types';

export function Destination({
  id,
  label,
  tabs,
  header,
}: {
  id: string;
  label: string;
  tabs: readonly ModuleTabDef[];
  /** Optional strip rendered above the tab bar (e.g. a destination-level KPI row). */
  header?: ReactNode;
}) {
  warnIfTooManyTabs(id, tabs);
  const keys = tabs.map((t) => t.id);
  const [tab, setTab] = useTabParam<string>(keys, keys[0]!, 'tab', CLEAR_VIEW);
  const badges = useTabBadges(tabs);
  const specs: TabSpec[] = tabs.map((t, i) => {
    const badge = badges[i];
    return badge ? { id: t.id, label: t.label, badge } : { id: t.id, label: t.label };
  });
  return (
    <div className="flex flex-col gap-4">
      {header}
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
    </div>
  );
}
