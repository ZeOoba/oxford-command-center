import { createContext, useContext } from 'react';
import type { ScenarioName } from '@contracts/index';
import type { DraftRequest } from './draft';

export type EntityType = 'property' | 'lease' | 'loan' | 'insurance' | 'deal' | 'cashEntity' | 'counterparty';

export interface EntityRef {
  type: EntityType;
  id: string;
}

export interface UiState {
  activeModuleId: string;
  setActiveModule: (id: string) => void;
  /** Navigate to a destination's tab (`/<moduleId>?tab=<tabId>`) — used by the palette's
   *  "Destination > Tab" entries. */
  openTab: (moduleId: string, tabId: string) => void;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  selected: EntityRef | null;
  openEntity: (ref: EntityRef) => void;
  closeEntity: () => void;
  /** The intel module's deep-linked property (PFI Phase B.3 item 5), from `/intel/:propertyId`.
   *  Distinct from `selected`/the global drawer — it focuses the intel Property tab only. */
  intelPropertyId: string | null;
  openIntelProperty: (propertyId: string) => void;
  aiOpen: boolean;
  openAi: () => void;
  closeAi: () => void;
  toggleAi: () => void;
  scenario: ScenarioName;
  setScenario: (s: ScenarioName) => void;
  /** Draft-only email composer (Phase 5). Ephemeral — never in the URL. */
  draft: DraftRequest | null;
  openDraft: (req: DraftRequest) => void;
  closeDraft: () => void;
}

export const UiContext = createContext<UiState>({
  activeModuleId: 'overview',
  setActiveModule: () => {},
  openTab: () => {},
  paletteOpen: false,
  openPalette: () => {},
  closePalette: () => {},
  togglePalette: () => {},
  selected: null,
  openEntity: () => {},
  closeEntity: () => {},
  intelPropertyId: null,
  openIntelProperty: () => {},
  aiOpen: false,
  openAi: () => {},
  closeAi: () => {},
  toggleAi: () => {},
  scenario: 'Base',
  setScenario: () => {},
  draft: null,
  openDraft: () => {},
  closeDraft: () => {},
});

export function useUi(): UiState {
  return useContext(UiContext);
}
