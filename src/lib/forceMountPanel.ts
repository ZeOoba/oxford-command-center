// src/lib/forceMountPanel.ts
//
// Props for a `<TabPanel>` whose contents must keep their local state (form drafts, filters, table
// sort) across a tab round-trip (IA decongestion Phase 3, plan R10). react-aria-components unmounts
// an inactive TabPanel by default; `shouldForceMount` keeps it mounted, and RAC then renders the
// inactive panel with the `inert` attribute + `data-inert` but NO `hidden`/`display:none` — so it
// would still paint. `data-[inert]:hidden` (Tailwind) hides it, and `inert` keeps it out of the tab
// order / accessibility tree. Use only for panels that were ALREADY mounted together in the
// pre-split single scroll, so no new eager queries are introduced.
export const FORCE_MOUNT_PANEL = {
  shouldForceMount: true,
  className: 'data-[inert]:hidden',
} as const;
