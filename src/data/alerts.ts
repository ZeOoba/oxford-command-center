import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertInboxState, EMPTY_INBOX_STATE, type AlertActionInput } from '../contracts/alerts';
import { applyAlertAction, buildAlertView, type AlertView } from '../brain/alerts-view';
import { useAnalytics } from './queries';

export const ALERT_STATE_KEY = ['alert-state'] as const;
const LS_KEY = 'ora-alert-state';

function readLocal(): AlertInboxState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return AlertInboxState.parse(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { ...EMPTY_INBOX_STATE };
}

async function fetchAlertState(): Promise<AlertInboxState> {
  try {
    const res = await fetch('/api/alerts/state');
    if (res.ok) return AlertInboxState.parse(await res.json());
  } catch {
    /* server offline — fall back to localStorage (mirror) */
  }
  return readLocal();
}

export function useAlertState() {
  return useQuery({ queryKey: ALERT_STATE_KEY, queryFn: fetchAlertState, staleTime: 30_000 });
}

export function useAlertAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AlertActionInput): Promise<AlertInboxState> => {
      try {
        const res = await fetch('/api/actions/alert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (res.ok) {
          const json = (await res.json()) as { state: unknown };
          return AlertInboxState.parse(json.state);
        }
      } catch {
        /* offline — mutate locally below */
      }
      const cur = qc.getQueryData<AlertInboxState>(ALERT_STATE_KEY) ?? readLocal();
      const next = applyAlertAction(cur, input, Date.now());
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    },
    onSuccess: (state) => qc.setQueryData(ALERT_STATE_KEY, state),
  });
}

/** Joins the client-computed insights with persisted read/snooze state. */
export function useAlertView(): AlertView {
  const { analytics } = useAnalytics();
  const stateQ = useAlertState();
  const state = stateQ.data ?? EMPTY_INBOX_STATE;
  return useMemo(
    () => buildAlertView(analytics?.insights ?? [], state, Date.now()),
    [analytics, state],
  );
}
