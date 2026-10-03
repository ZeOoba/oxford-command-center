// server/edge/config.ts
//
// Oxford Edge (spec §3). The ONE home of the dataset directory default. Resolved at CALL time
// (same rationale as workbookPath() in server/config.ts): a top-level const would freeze whatever
// process.env held when this module was first imported, before .env loading.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Firm rule: a mirror more than 7 days behind is never presented as current (spec §12 Q4). */
export const EDGE_STALE_DAYS = 7;

/** Directory holding markets.json. OXFORD_EDGE_DIR overrides; blank counts as unset. */
export function edgeDir(): string {
  const fromEnv = process.env.OXFORD_EDGE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output');
}
