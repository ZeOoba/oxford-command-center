import type { EntityType } from '../ui-context';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  /** Transient status while a tool runs (e.g. "querying the rent roll"). */
  toolStep?: string;
  model?: string;
}

/** SSE frames emitted by the agent (server/ai/agent.ts), shared by server + Pages Function. */
export type AgentStreamEvent =
  | { type: 'tool'; name: string; label: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; model: string; refs: Array<{ type: EntityType; id: string; label: string }> }
  | { type: 'error'; message: string };

export interface StreamHandlers {
  onText?: (delta: string) => void;
  onTool?: (label: string) => void;
  onDone?: (model: string) => void;
  onError?: (message: string) => void;
}

/** Non-streaming shape returned by the deterministic responder (server/ai/respond.ts). */
export interface AiAskResponse {
  answer: string;
  sources: string[];
  model: 'stub' | 'claude';
}
