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

function load(allIds: string[]): Persisted {
  const fallback: Persisted = { workspaces: { Default: { order: allIds, hidden: [] } }, active: 'Default' };
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

/** Reconcile a saved config against the current widget set (handles added/removed widgets). */
function normalize(cfg: WorkspaceConfig | undefined, allIds: string[]): WorkspaceConfig {
  const order = (cfg?.order ?? []).filter((id) => allIds.includes(id));
  for (const id of allIds) if (!order.includes(id)) order.push(id);
  const hidden = (cfg?.hidden ?? []).filter((id) => allIds.includes(id));
  return { order, hidden };
}

export function useWorkspaces(allIds: string[]) {
  const [state, setState] = useState<Persisted>(() => load(allIds));
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable */
    }
  }, [state]);

  const activeCfg = useMemo(() => normalize(state.workspaces[state.active], allIds), [state, allIds]);
  const visibleOrder = useMemo(() => activeCfg.order.filter((id) => !activeCfg.hidden.includes(id)), [activeCfg]);

  const mutate = useCallback(
    (fn: (cfg: WorkspaceConfig) => WorkspaceConfig) => {
      setState((s) => {
        const cfg = normalize(s.workspaces[s.active], allIds);
        return { ...s, workspaces: { ...s.workspaces, [s.active]: fn(cfg) } };
      });
    },
    [allIds],
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
        const cfg = normalize(s.workspaces[s.active], allIds);
        return { workspaces: { ...s.workspaces, [name]: { order: [...cfg.order], hidden: [...cfg.hidden] } }, active: name };
      }),
    [allIds],
  );
  const resetActive = useCallback(() => mutate(() => ({ order: [...allIds], hidden: [] })), [mutate, allIds]);

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
