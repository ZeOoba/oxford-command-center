import type { BrainState } from '@contracts/index';

export interface SSEHandlers {
  onState?: (state: BrainState) => void;
  onSnapshot?: () => void;
}

/** Subscribe to the Brain Server's live event stream. Returns an unsubscribe fn. */
export function connectBrainSSE(handlers: SSEHandlers): () => void {
  const es = new EventSource('/sse');
  const onState = (e: MessageEvent) => {
    try {
      handlers.onState?.(JSON.parse(e.data) as BrainState);
    } catch {
      /* ignore malformed frame */
    }
  };
  const onSnapshot = () => handlers.onSnapshot?.();
  es.addEventListener('state', onState as EventListener);
  es.addEventListener('snapshot', onSnapshot);
  return () => {
    es.removeEventListener('state', onState as EventListener);
    es.removeEventListener('snapshot', onSnapshot);
    es.close();
  };
}
