import type { BrainState } from '@contracts/index';

export interface SSEHandlers {
  onState?: (state: BrainState) => void;
  onSnapshot?: () => void;
}

/** Subscribe to the Brain Server's live event stream. Returns an unsubscribe fn.
 *  Bounded reconnect: after MAX_ERRORS consecutive errors with no successful event we close the
 *  stream, so the static mirror (which has no /sse) stops the browser's forever-retry loop. Any
 *  delivered event resets the counter, so a real server reconnects normally. */
export function connectBrainSSE(handlers: SSEHandlers): () => void {
  const es = new EventSource('/sse');
  const MAX_ERRORS = 3;
  let errorStreak = 0;

  const onState = (e: MessageEvent) => {
    errorStreak = 0;
    try {
      handlers.onState?.(JSON.parse(e.data) as BrainState);
    } catch {
      /* ignore malformed frame */
    }
  };
  const onSnapshot = () => { errorStreak = 0; handlers.onSnapshot?.(); };
  const onOpen = () => { errorStreak = 0; };
  const onError = () => {
    errorStreak += 1;
    if (errorStreak >= MAX_ERRORS) es.close();
  };

  es.addEventListener('state', onState as EventListener);
  es.addEventListener('snapshot', onSnapshot);
  es.addEventListener('open', onOpen);
  es.addEventListener('error', onError);
  return () => {
    es.removeEventListener('state', onState as EventListener);
    es.removeEventListener('snapshot', onSnapshot);
    es.removeEventListener('open', onOpen);
    es.removeEventListener('error', onError);
    es.close();
  };
}
