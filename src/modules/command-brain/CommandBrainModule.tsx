// src/modules/command-brain/CommandBrainModule.tsx
//
// The Brain destination (IA decongestion Phase 4e) — Digest · Insights · Track record · Feedback · Memory,
// in the URL via useTabParam (`?tab=`, default Digest). See ./tabs.ts for the declaration.
//   Digest / Insights — the absorbed Principal Home / Insights modules, lazy-mounted per tab. They read
//                       the snapshot and work on the static mirror.
//   Track record / Feedback / Memory — the honesty-doctrine view over server/warehouse/brain-report.ts's
//                       composed BrainReport: what the firm's scoring/verdict layer has actually gotten
//                       right, how sparse/deep its coverage is per cohort, and where it knows it doesn't
//                       know. No invented accuracy, memory, or confidence figure — every number traces to a
//                       resolved calibration_outcome row or a confidence-by-cohort computation, or renders
//                       as an explicit "—" gap. (Versions is a `?view=versions` switch inside Memory.)
//
// Named 'command-brain' specifically to avoid colliding with src/brain/ — that is a DIFFERENT,
// pre-existing system (client chrome / command-palette). Unrelated code; do not conflate.
//
// Rule G: the /brain/report loading / offline gate — plus the disclaimer and KPI strip — lives in
// <ReportGate>, wrapped ONLY around the three report-backed panels. There is no whole-module early return
// here, so a 503 from the report route (the static mirror) never blanks Digest or Insights. The strip's
// only report dependency is the Feedback count badge (R4), read from the SAME query (react-query dedupes),
// so it is simply absent while the report is loading/unavailable.
// keyboardActivation "manual": Digest and Insights mount their own queries, so arrowing across the strip
// must not fire them. Rule H: a tab switch clears `?view=` (owned by Memory's inner SegmentedControl).
import { lazy, Suspense } from 'react';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { useTabSpecs } from '@/shell/tab-badges';
import { ReportGate } from './ReportGate';
import { TrackRecordPanel, FeedbackPanel, MemoryPanel } from './BrainPanels';
import { BRAIN_TABS, BRAIN_TAB_KEYS, type BrainTab } from './tabs';

const PrincipalModule = lazy(() => import('../principal/PrincipalModule').then((m) => ({ default: m.PrincipalModule })));
const InsightsModule = lazy(() => import('../insights/InsightsModule').then((m) => ({ default: m.InsightsModule })));

export function CommandBrainModule() {
  const [tab, setTab] = useTabParam<BrainTab>(BRAIN_TAB_KEYS, 'digest', 'tab', CLEAR_VIEW);
  // R4: the Feedback open-question badge is DECLARED on BRAIN_TABS (`useBadge`) like every other
  // destination's, so `useTabSpecs` resolves it — no hand-rolled spec map here. Its hook shares
  // <ReportGate>'s error-first predicate and the same (deduped) query; see ./tabs.ts.
  const specs = useTabSpecs(BRAIN_TABS);

  return (
    <Tabs tabs={specs} selectedKey={tab} onSelectionChange={(k) => setTab(k as BrainTab)} keyboardActivation="manual" aria-label="Brain views">
      <TabPanel id="digest">
        <Suspense fallback={<ModuleLoading />}><PrincipalModule /></Suspense>
      </TabPanel>
      <TabPanel id="insights">
        <Suspense fallback={<ModuleLoading />}><InsightsModule /></Suspense>
      </TabPanel>
      <TabPanel id="track-record">
        <ReportGate>{(r) => <TrackRecordPanel r={r} />}</ReportGate>
      </TabPanel>
      <TabPanel id="feedback">
        <ReportGate>{(r) => <FeedbackPanel r={r} />}</ReportGate>
      </TabPanel>
      <TabPanel id="memory">
        <ReportGate>{(r) => <MemoryPanel r={r} />}</ReportGate>
      </TabPanel>
    </Tabs>
  );
}
