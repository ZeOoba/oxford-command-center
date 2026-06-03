/** Live-brain runtime state — shared by the server and the client. */
export type BrainStatus = 'idle' | 'refreshing' | 'fresh' | 'error';
export type BrainSource = 'workbook' | 'snapshot-fallback' | 'none';

export interface BrainState {
  status: BrainStatus;
  source: BrainSource;
  lastUpdated: string | null;
  lastError: string | null;
  workbookPath: string;
  flagCount: number;
}
