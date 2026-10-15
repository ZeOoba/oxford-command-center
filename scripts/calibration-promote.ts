// scripts/calibration-promote.ts
//
// The explicit human step that turns a reviewed proposal into a ledger observation:
//   npm run calibration:promote -- <obs_id>
// Append-only: the observation is added to data/calibration/observations.json and removed from
// data/calibration/calibration_pending.json. Existing observations are never edited; a duplicate obs_id is refused.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renameSyncWithRetry } from '../server/lib/rename-retry';
import { parseLedger, parsePending, promoteProposal } from '../src/analytics/calibration-ledger';

const LEDGER_PATH = join(process.cwd(), 'data', 'calibration', 'observations.json');
const PENDING_PATH = join(process.cwd(), 'data', 'calibration', 'calibration_pending.json');

const read = <T>(path: string, parse: (raw: unknown) => T): T => parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : []);
const write = (path: string, data: unknown): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSyncWithRetry(tmp, path);
};

/** `<obs_id> [--supersedes <id>]...` (also `--supersedes=<id>`). A missing value or an unknown flag is an error, never silently ignored. */
export function parseArgs(argv: string[]): { obsId: string | undefined; supersedes: string[] | undefined } | string {
  const supersedes: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--supersedes') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return '--supersedes needs an obs_id';
      supersedes.push(v);
    } else if (a.startsWith('--supersedes=')) {
      const v = a.slice('--supersedes='.length);
      if (v === '') return '--supersedes needs an obs_id';
      supersedes.push(v);
    } else if (a.startsWith('--')) return `unknown option ${a}`;
    else positional.push(a);
  }
  if (positional.length > 1) return `unexpected extra argument "${positional[1]}"`;
  return { obsId: positional[0], supersedes: supersedes.length > 0 ? supersedes : undefined };
}

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    console.error(`calibration-promote: ${parsed}`);
    return 1;
  }
  const { obsId, supersedes } = parsed;
  if (!obsId) {
    console.error('usage: npm run calibration:promote -- <obs_id> [--supersedes <earlier_obs_id>]   (see data/calibration/calibration_pending.json)');
    return 1;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = promoteProposal(read(LEDGER_PATH, parseLedger), read(PENDING_PATH, parsePending), obsId, today, supersedes);
    write(LEDGER_PATH, result.ledger);
    write(PENDING_PATH, result.pending);
    console.log(`calibration-promote: ${obsId} appended to the ledger (${result.ledger.length} observations, ${result.pending.length} still pending).`);
    return 0;
  } catch (e) {
    console.error(`calibration-promote: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/calibration-promote.ts')) {
  process.exit(main(process.argv.slice(2)));
}
