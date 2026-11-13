// scripts/scan-mirror-dist.ts
//
// Post-build egress gate for the REDACTED (public-safe) mirror. Audit wf_9bf74429-aaf finding 30:
// bake-mirror.ts roster-scrubs only the snapshot it writes. Everything else in the artifact -- the
// data/building-specs and data/calibration JSON that src/ imports and vite compiles into /assets,
// any seed module, a stale file vite copied out of public/ -- reached dist/ without ever being
// checked against the confidential roster. This scans the BUILT artifact itself, every text file
// under dist/, so whatever is bundled is covered without keeping a list of what gets bundled.
//
// REDACTED mode: any roster hit refuses (exit 1); so does an unreadable or placeholder roster
// (egressRosterScanner throws). Messages name the file only, never the term or the deal label.
// FULL mode (resolveMirrorMode: the deploy script's attested Access-gated bake) carries confidential
// data by design, so the scan is skipped -- that artifact is protected by the Access probe instead.
//
// --precheck-redacted-only (used by `npm run deploy:mirror`, the MANUAL path): refuse outright when
// either FULL-mode variable is present in the environment. The manual path never ships FULL.
//
// Usage: tsx scripts/scan-mirror-dist.ts [--dist=<dir>] [--precheck-redacted-only]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { egressRosterScanner } from '../server/briefing/roster-match';
import { loadEnvFile } from '../server/load-env';
import { resolveMirrorMode } from './lib/mirror-mode';

/** File types that can carry text: what the bundle, the baked JSON and source maps are made of. */
const TEXT_EXT = /\.(js|mjs|cjs|json|html|htm|css|map|txt|svg|xml|webmanifest|csv|md)$/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Every text file under `distDir` (relative, '/'-separated) whose content matches the roster.
 * `makeScanner` loads the roster once and throws on an unreadable or placeholder roster.
 */
export function scanDistForRoster(
  distDir: string,
  makeScanner: () => (value: unknown) => unknown = egressRosterScanner,
): string[] {
  const scan = makeScanner();
  const hits: string[] = [];
  for (const file of walk(distDir)) {
    if (!TEXT_EXT.test(file)) continue;
    if (scan(readFileSync(file, 'utf8'))) hits.push(relative(distDir, file).split(sep).join('/'));
  }
  return hits.sort();
}

/** --precheck-redacted-only: the refusal message when a FULL-mode variable is present, else null. */
export function precheckRedactedOnly(env: Record<string, string | undefined>): string | null {
  // '0' means REDACTED to resolveMirrorMode, so it is not "set" here either (refute wf_6bae3d4e-aec).
  const present = ['MIRROR_INCLUDE_CONFIDENTIAL', 'MIRROR_ACCESS_PREPROBE'].filter((k) => !!env[k] && env[k] !== '0');
  if (present.length === 0) return null;
  return (
    `✗ deploy:mirror: refusing — ${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'} set. ` +
    `The manual deploy:mirror path ships the REDACTED bake only; the FULL (confidential) bake is ` +
    `deployed solely by scripts/deploy-mirror.ps1, which probes Cloudflare Access first.`
  );
}

export function main(argv: readonly string[], env: Record<string, string | undefined>): number {
  if (argv.includes('--precheck-redacted-only')) {
    const refusal = precheckRedactedOnly(env);
    if (refusal) {
      console.error(refusal);
      return 1;
    }
    console.log('✓ deploy:mirror precheck: no FULL-mode variable set — REDACTED bake only.');
    return 0;
  }
  const { includeConfidential, refusal } = resolveMirrorMode(env);
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  if (includeConfidential) {
    console.log('  dist roster scan: skipped — FULL (Access-gated) bake; deploy-mirror.ps1 probes every target.');
    return 0;
  }
  const distArg = argv.find((a) => a.startsWith('--dist='));
  const dist = distArg ? distArg.slice('--dist='.length) : join(process.cwd(), 'dist');
  let hits: string[];
  try {
    hits = scanDistForRoster(dist);
  } catch (err) {
    console.error(
      `✗ dist roster scan: refusing — could not scan ${dist} against the confidential roster ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
    return 1;
  }
  if (hits.length) {
    console.error(
      `✗ dist roster scan: refusing — ${hits.length} file(s) in the REDACTED (public-safe) artifact match ` +
        `the confidential roster: ${hits.join(', ')}. Nothing may be deployed from this dist/.`,
    );
    return 1;
  }
  console.log('✓ dist roster scan: no confidential roster term in the REDACTED artifact.');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/scan-mirror-dist.ts')) {
  // CONFIDENTIAL_TERMS_PATH may live in .env; the FULL-mode keys never come from it (load-env.ts).
  loadEnvFile();
  process.exit(main(process.argv.slice(2), process.env));
}
