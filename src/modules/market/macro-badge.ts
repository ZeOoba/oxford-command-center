import type { MacroSnapshot } from '@contracts/index';

// The server emits source:'live-fred' for a real fetch; 'fred' is a legacy alias kept for older
// snapshots on disk. Both read as live. 'mock' / 'seed' are the non-live fallbacks (2026-09-23 review —
// the badge previously checked only 'fred', so a live snapshot rendered as "FRED · snapshot").
// Kept in its own module (not MarketModule.tsx) because a non-component export from a .tsx
// component module trips react-refresh/only-export-components under this repo's `--max-warnings 0`
// lint gate.
export const isLiveMacro = (source: MacroSnapshot['source']) => source === 'live-fred' || source === 'fred';
