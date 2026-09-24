import { useCallback, useEffect, useMemo, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

interface WorkspaceConfig {
  order: string[];
  hidden: string[];
}
interface Persisted {
  workspaces: Record<string, WorkspaceConfig>;
  active: string;
}

const KEY = 'ora-overview-workspaces';

/** A single stable, frozen reference for callers that pass no `defaultHidden` — an inline `[]`
 *  default creates a NEW array identity on every call, which defeats the memoization below
 *  (`activeCfg`/`mutate`/`resetActive` all depend on `defaultHidden` by reference). */
const EMPTY_HIDDEN: readonly string[] = Object.freeze([]);

function load(allIds: string[], defaultHidden: readonly string[]): Persisted {
  const fallback: Persisted = { workspaces: { Default: { order: allIds, hidden: [...defaultHidden] } }, active: 'Default' };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed.workspaces || !parsed.active) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

/** Reconcile a saved config against the current widget set (handles added/removed widgets).
 *  An id already present in the persisted order keeps the user's explicit visible/hidden choice
 *  untouched. An id the persisted layout has never seen (new widget, or one that predates this
 *  layout) is appended to the order — and, if it's in `defaultHidden`, appended to `hidden` too —
 *  so it stays reachable via Edit layout instead of silently vanishing. */
function normalize(cfg: WorkspaceConfig | undefined, allIds: string[], defaultHidden: readonly string[]): WorkspaceConfig {
  const order = (cfg?.order ?? []).filter((id) => allIds.includes(id));
  const hidden = (cfg?.hidden ?? []).filter((id) => allIds.includes(id));
  for (const id of allIds) {
    if (!order.includes(id)) {
      order.push(id);
      if (defaultHidden.includes(id) && !hidden.includes(id)) hidden.push(id);
    }
  }
  return { order, hidden };
}

export function useWorkspaces(allIds: string[], defaultHidden: readonly string[] = EMPTY_HIDDEN) {
  const [state, setState] = useState<Persisted>(() => load(allIds, defaultHidden));
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable */
    }
  }, [state]);

  const activeCfg = useMemo(
    () => normalize(state.workspaces[state.active], allIds, defaultHidden),
    [state, allIds, defaultHidden],
  );
  const visibleOrder = useMemo(() => activeCfg.order.filter((id) => !activeCfg.hidden.includes(id)), [activeCfg]);

  const mutate = useCallback(
    (fn: (cfg: WorkspaceConfig) => WorkspaceConfig) => {
      setState((s) => {
        const cfg = normalize(s.workspaces[s.active], allIds, defaultHidden);
        return { ...s, workspaces: { ...s.workspaces, [s.active]: fn(cfg) } };
      });
    },
    [allIds, defaultHidden],
  );

  const reorder = useCallback(
    (activeId: string, overId: string) => {
      mutate((cfg) => {
        const from = cfg.order.indexOf(activeId);
        const to = cfg.order.indexOf(overId);
        if (from < 0 || to < 0) return cfg;
        return { ...cfg, order: arrayMove(cfg.order, from, to) };
      });
    },
    [mutate],
  );
  const hide = useCallback((id: string) => mutate((cfg) => ({ ...cfg, hidden: [...new Set([...cfg.hidden, id])] })), [mutate]);
  const show = useCallback((id: string) => mutate((cfg) => ({ ...cfg, hidden: cfg.hidden.filter((x) => x !== id) })), [mutate]);

  const setActive = useCallback((name: string) => setState((s) => (s.workspaces[name] ? { ...s, active: name } : s)), []);
  const saveAs = useCallback(
    (name: string) =>
      setState((s) => {
        const cfg = normalize(s.workspaces[s.active], allIds, defaultHidden);
        return { workspaces: { ...s.workspaces, [name]: { order: [...cfg.order], hidden: [...cfg.hidden] } }, active: name };
      }),
    [allIds, defaultHidden],
  );
  const resetActive = useCallback(
    () => mutate(() => ({ order: [...allIds], hidden: [...defaultHidden] })),
    [mutate, allIds, defaultHidden],
  );

  return {
    workspaceNames: Object.keys(state.workspaces),
    active: state.active,
    setActive,
    saveAs,
    resetActive,
    visibleOrder,
    hiddenIds: activeCfg.hidden,
    editMode,
    setEditMode,
    reorder,
    hide,
    show,
  };
}
