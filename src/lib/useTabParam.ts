// src/lib/useTabParam.ts
//
// Puts a module's selected tab in the URL (IA decongestion Phase 0, R10) so a tab is
// deep-linkable, survives refresh, and restores on back/forward — without disturbing any other
// query param. Mirrors UiProvider.tsx's `setScenario` pattern (functional `setSearchParams`
// update copying `prev`, `{ replace: true }`) so `?tab=` and `?scenario=` compose cleanly.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * `useTabParam(['positions', 'scorecard'], 'positions')` reads/writes `?tab=` (or a custom
 * `paramName`). An unknown or missing value falls back to `defaultKey` WITHOUT writing the URL
 * on mount (read-only fallback — the param is only ever set by calling the returned setter).
 * Setting the default key REMOVES the param, keeping default-tab URLs clean; setting any other
 * key writes it with `replace: true` (a tab switch shouldn't grow browser history) while
 * preserving every other param (`scenario`, `still`, ...) already on the URL.
 */
export function useTabParam<K extends string>(
  keys: readonly K[],
  defaultKey: K,
  paramName = 'tab',
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
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams, defaultKey, paramName],
  );

  return [current, setKey];
}
