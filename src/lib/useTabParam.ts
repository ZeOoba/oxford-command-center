// src/lib/useTabParam.ts
//
// Puts a module's selected tab in the URL (IA decongestion Phase 0, R10) so a tab is
// deep-linkable, survives refresh, and restores on back/forward — without disturbing any other
// query param. Mirrors UiProvider.tsx's `setScenario` pattern (functional `setSearchParams`
// update copying `prev`, `{ replace: true }`) so `?tab=` and `?scenario=` compose cleanly.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Params owned by an inner SegmentedControl — a destination clears them when its tab changes. */
export const CLEAR_VIEW: readonly string[] = ['view'];
const NONE: readonly string[] = [];

/**
 * `useTabParam(['positions', 'scorecard'], 'positions')` reads/writes `?tab=` (or a custom
 * `paramName`). An unknown or missing value falls back to `defaultKey` WITHOUT writing the URL
 * on mount (read-only fallback — the param is only ever set by calling the returned setter).
 * Setting the default key REMOVES the param, keeping default-tab URLs clean; setting any other
 * key writes it with `replace: true` (a tab switch shouldn't grow browser history) while
 * preserving every other param (`scenario`, `still`, ...) already on the URL.
 *
 * `clearOnChange` names sibling params to delete whenever the tab changes (Rule H: a `?view=`
 * owned by an inner SegmentedControl must not leak into the next tab). Default: none.
 */
export function useTabParam<K extends string>(
  keys: readonly K[],
  defaultKey: K,
  paramName = 'tab',
  clearOnChange: readonly string[] = NONE,
): [K, (key: K) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get(paramName);
  const current = useMemo<K>(
    () => (raw !== null && (keys as readonly string[]).includes(raw) ? (raw as K) : defaultKey),
    [raw, keys, defaultKey],
  );

  const setKey = useCallback(
    (key: K) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key === defaultKey) next.delete(paramName);
          else next.set(paramName, key);
          // Never clear the param we just wrote: a list that happens to name `paramName` (a shared
          // CLEAR_* constant reused on an inner `view` strip) would otherwise silently drop the
          // selection and snap back to `defaultKey`.
          for (const p of clearOnChange) if (p !== paramName) next.delete(p);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, defaultKey, paramName, clearOnChange],
  );

  return [current, setKey];
}
