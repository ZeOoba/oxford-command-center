import type { AiAskResponse } from './types';

/**
 * Client adapter for the assistant. Posts to the Brain Server's /api/ai.
 * The server holds any model credentials — none ever reach the browser.
 */
export async function askBrain(question: string): Promise<AiAskResponse> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`Assistant request failed (${res.status})`);
  return (await res.json()) as AiAskResponse;
}
