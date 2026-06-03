export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: string[];
  pending?: boolean;
}

export interface AiAskRequest {
  question: string;
}

export interface AiAskResponse {
  answer: string;
  sources: string[];
  model: 'stub' | 'claude';
}
