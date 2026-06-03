import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ScenarioName } from '@contracts/index';
import { UiContext, type EntityRef } from './ui-context';

export function UiProvider({ children }: { children: ReactNode }) {
  const [activeModuleId, setActiveModuleId] = useState('overview');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selected, setSelected] = useState<EntityRef | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioName>('Base');

  const setActiveModule = useCallback((id: string) => {
    setActiveModuleId(id);
    setSelected(null);
  }, []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const togglePalette = useCallback(() => setPaletteOpen((o) => !o), []);
  const openEntity = useCallback((ref: EntityRef) => setSelected(ref), []);
  const closeEntity = useCallback(() => setSelected(null), []);
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
    [activeModuleId, setActiveModule, paletteOpen, openPalette, closePalette, togglePalette, selected, openEntity, closeEntity, aiOpen, openAi, closeAi, toggleAi, scenario],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
