import type { StreamHandlers } from './types';

/**
 * Client adapter for the assistant. POSTs to `/api/ai` and consumes the agent's SSE stream
 * (the Brain Server locally, the Pages Function on the mirror). The server holds the model
 * credentials — none ever reach the browser. Returns when the stream ends.
 */
export async function askBrainStream(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, history }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Assistant request failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const dispatch = (dataStr: string) => {
    if (!dataStr) return;
    try {
      const d = JSON.parse(dataStr) as { type: string; delta?: string; label?: string; model?: string; message?: string };
      if (d.type === 'text') handlers.onText?.(d.delta ?? '');
      else if (d.type === 'tool') handlers.onTool?.(d.label ?? '');
      else if (d.type === 'done') handlers.onDone?.(d.model ?? '');
      else if (d.type === 'error') handlers.onError?.(d.message ?? 'Unknown error');
    } catch {
      /* ignore malformed frame */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) dispatch(line.slice(5).trim());
    }
  }
}
