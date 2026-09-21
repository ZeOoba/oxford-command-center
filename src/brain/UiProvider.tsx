import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { ScenarioName } from '@contracts/index';
import { MODULES } from '@/shell/modules';
import { UiContext, type EntityRef } from './ui-context';
import type { DraftRequest } from './draft';
import { parseRoute, entityHref, intelPropertyPath, resolveLegacyRoute } from './routing';

const MODULE_IDS = MODULES.map((m) => m.id);
const SCENARIOS: ScenarioName[] = ['Base', 'Upside', 'Downside'];

/**
 * App-wide UI state. The *navigable* state — active module, the open entity drawer, and the
 * scenario — lives in the URL so deep links are shareable and back/forward/refresh restore the
 * exact view (Phase 2). Only ephemeral, personal UI (command palette, AI panel) stays local.
 */
export function UiProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Module + open drawer + intel deep-link are derived from the path; `?tab=` disambiguates the
  // drawer type on multi-drawer destinations (TAB_PRIMARY_TYPE).
  const tabParam = searchParams.get('tab');
  const { moduleId: activeModuleId, selected, intelPropertyId } = useMemo(
    () => parseRoute(location.pathname, MODULE_IDS, tabParam),
    [location.pathname, tabParam],
  );

  // Scenario is a query param so it survives refresh and rides along on navigations.
  const scenarioParam = searchParams.get('scenario');
  const scenario: ScenarioName = SCENARIOS.includes(scenarioParam as ScenarioName)
    ? (scenarioParam as ScenarioName)
    : 'Base';
  const search = location.search; // preserve ?scenario across module/drawer navigations

  // A legacy (absorbed) id — e.g. the AlertBell's 'alerts' — routes to its destination + tab.
  const setActiveModule = useCallback(
    (id: string) => navigate(resolveLegacyRoute(`/${id}`, search) ?? `/${id}${search}`),
    [navigate, search],
  );
  // Palette "Destination > Tab" entries: `/<dest>?tab=<id>`, keeping ?scenario/?still and dropping
  // any stale ?view= (an inner SegmentedControl param belongs to the previous tab).
  const openTab = useCallback(
    (moduleId: string, tabId: string) => {
      const params = new URLSearchParams(search);
      params.delete('view');
      params.set('tab', tabId);
      navigate(`/${moduleId}?${params.toString()}`);
    },
    [navigate, search],
  );
  const openEntity = useCallback(
    (ref: EntityRef) => navigate(entityHref(ref, search, activeModuleId)),
    [navigate, search, activeModuleId],
  );
  // Intel deep link (PFI Phase B.3 item 5) — navigates to `/intel/:propertyId`, which focuses the
  // intel Property tab WITHOUT opening the global EntityDrawer (intel has no MODULE_PRIMARY_TYPE).
  const openIntelProperty = useCallback(
    (propertyId: string) => navigate(`${intelPropertyPath(propertyId)}${search}`),
    [navigate, search],
  );
  const closeEntity = useCallback(
    () => navigate(`/${activeModuleId}${search}`),
    [navigate, activeModuleId, search],
  );
  const setScenario = useCallback(
    (s: ScenarioName) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (s === 'Base') next.delete('scenario');
          else next.set('scenario', s);
          return next;
        },
        { replace: true }, // scenario toggles shouldn't pollute history
      );
    },
    [setSearchParams],
  );

  // Ephemeral, personal UI — never in the URL.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRequest | null>(null);
  const openDraft = useCallback((req: DraftRequest) => setDraft(req), []);
  const closeDraft = useCallback(() => setDraft(null), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  const openAi = useCallback(() => setAiOpen(true), []);
  const closeAi = useCallback(() => setAiOpen(false), []);
  const toggleAi = useCallback(() => setAiOpen((o) => !o), []);

  // Global shortcuts: ⌘K palette, ⌘J assistant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        togglePalette();
      } else if (k === 'j') {
        e.preventDefault();
        toggleAi();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette, toggleAi]);

  const value = useMemo(
    () => ({
      activeModuleId,
      setActiveModule,
      openTab,
      paletteOpen,
      openPalette,
      closePalette,
      togglePalette,
      selected,
      openEntity,
      closeEntity,
      intelPropertyId,
      openIntelProperty,
      aiOpen,
      openAi,
      closeAi,
      toggleAi,
      scenario,
      setScenario,
      draft,
      openDraft,
      closeDraft,
    }),
    [activeModuleId, setActiveModule, openTab, paletteOpen, openPalette, closePalette, togglePalette, selected, openEntity, closeEntity, intelPropertyId, openIntelProperty, aiOpen, openAi, closeAi, toggleAi, scenario, setScenario, draft, openDraft, closeDraft],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
