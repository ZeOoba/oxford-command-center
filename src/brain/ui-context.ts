import { createContext, useContext } from 'react';
import type { ScenarioName } from '@contracts/index';

export type EntityType = 'property' | 'lease' | 'loan' | 'insurance' | 'deal' | 'cashEntity' | 'counterparty';

export interface EntityRef {
  type: EntityType;
  id: string;
}

export interface UiState {
  activeModuleId: string;
  setActiveModule: (id: string) => void;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  selected: EntityRef | null;
  openEntity: (ref: EntityRef) => void;
  closeEntity: () => void;
  aiOpen: boolean;
  openAi: () => void;
  closeAi: () => void;
  toggleAi: () => void;
  scenario: ScenarioName;
  setScenario: (s: ScenarioName) => void;
}

export const UiContext = createContext<UiState>({
  activeModuleId: 'overview',
  setActiveModule: () => {},
  paletteOpen: false,
  openPalette: () => {},
  closePalette: () => {},
  togglePalette: () => {},
  selected: null,
  openEntity: () => {},
  closeEntity: () => {},
  aiOpen: false,
  openAi: () => {},
  closeAi: () => {},
  toggleAi: () => {},
  scenario: 'Base',
  setScenario: () => {},
});

export function useUi(): UiState {
  return useContext(UiContext);
}
