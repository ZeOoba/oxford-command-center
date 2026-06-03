import { createContext, useContext } from 'react';
import type { BrainState } from '@contracts/index';

export interface BrainContextValue {
  state: BrainState | null;
  refreshing: boolean;
  refresh: () => void;
}

export const BrainContext = createContext<BrainContextValue>({
  state: null,
  refreshing: false,
  refresh: () => {},
});

export function useBrain(): BrainContextValue {
  return useContext(BrainContext);
}
