import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { ScenarioName } from '@contracts/index';
import { MODULES } from '@/shell/modules';
import { UiContext, type EntityRef } from './ui-context';
import { parseRoute, entityPath } from './routing';

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

  // Module + open drawer are derived from the path (stable identity per pathname).
  const { moduleId: activeModuleId, selected } = useMemo(
    () => parseRoute(location.pathname, MODULE_IDS),
    [location.pathname],
  );

  // Scenario is a query param so it survives refresh and rides along on navigations.
  const scenarioParam = searchParams.get('scenario');
  const scenario: ScenarioName = SCENARIOS.includes(scenarioParam as ScenarioName)
    ? (scenarioParam as ScenarioName)
    : 'Base';
  const search = location.search; // preserve ?scenario across module/drawer navigations

  const setActiveModule = useCallback((id: string) => navigate(`/${id}${search}`), [navigate, search]);
  const openEntity = useCallback((ref: EntityRef) => navigate(`${entityPath(ref)}${search}`), [navigate, search]);
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
      paletteOpen,
      openPalette,
      closePalette,
      togglePalette,
      selected,
      openEntity,
      closeEntity,
      aiOpen,
      openAi,
      closeAi,
      toggleAi,
      scenario,
      setScenario,
    }),
    [activeModuleId, setActiveModule, paletteOpen, openPalette, closePalette, togglePalette, selected, openEntity, closeEntity, aiOpen, openAi, closeAi, toggleAi, scenario, setScenario],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
