import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { rosterClaimsDeal } from '../../server/sources/deal-declassification';

// Commit-time guard for Hard Invariant 3. A seed with `confidential:false` publishes verbatim (the
// seed flag is the source of truth for seed-matched deals), and applyRosterOverride only flips such a
// seed at RUNTIME. This test makes a seed that an ACTIVE roster group claims fail `npm test` before it
// can be committed. The roster (hooks/confidential-terms.json) is machine-local and gitignored, so:
//   - the real-roster check runs only where a real roster resolves, and SKIPS LOUDLY (stderr) otherwise;
//   - the synthetic-roster checks always run and prove the detector can actually fail.
// Failure output names seed ids only — never a roster term or a roster label.

const SYNTHETIC_FIXTURE = 'confidential-terms.synthetic.json';

/** Ids of seeds that publish as non-confidential but that the roster currently claims. */
function claimedPublicSeedIds(seeds: readonly Deal[]): string[] {
  return seeds.filter((s) => !s.confidential && rosterClaimsDeal(s)).map((s) => s.id);
}

interface RealRoster {
  path: string | null;
  activeGroups: number;
  reason: string | null; // why unusable; null when usable
}

/** Resolve the real roster, ignoring the suite-wide synthetic default wired in tests/setup.ts. */
function resolveRealRoster(): RealRoster {
  const envPath = process.env.CONFIDENTIAL_TERMS_PATH;
  const candidates = [
    process.env.ORA_REAL_CONFIDENTIAL_TERMS_PATH,
    envPath && basename(envPath) !== SYNTHETIC_FIXTURE ? envPath : undefined,
    join(homedir(), '.claude', 'hooks', 'confidential-terms.json'),
  ].filter((p): p is string => !!p);
  const path = candidates.find((p) => existsSync(p)) ?? null;
  if (!path) return { path: null, activeGroups: 0, reason: 'no roster file found at any candidate path' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { path, activeGroups: 0, reason: 'roster file unreadable or invalid JSON' };
  }
  const groups = Object.entries(raw).filter(([k, v]) => !k.startsWith('_') && typeof v === 'object' && v !== null);
  if (groups.length === 0) return { path, activeGroups: 0, reason: 'roster has no groups (placeholder-equivalent)' };
  if (JSON.stringify(raw).includes('__ora_confidential_placeholder__')) {
    return { path, activeGroups: 0, reason: 'roster is the placeholder stand-in' };
  }
  const active = groups.filter(([, v]) => (v as { active?: boolean }).active !== false).length;
  return { path, activeGroups: active, reason: null };
}

const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
let dir: string;

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-seed-roster-guard-'));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function useRoster(roster: unknown): void {
  const p = join(dir, 'terms.json');
  writeFileSync(p, JSON.stringify(roster), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
}

describe('seed roster-claim guard (synthetic roster — always runs)', () => {
  const publicSeed = SEED_DEALS.find((s) => !s.confidential);

  it('has at least one non-confidential seed to exercise (else the guard is vacuous)', () => {
    expect(publicSeed).toBeDefined();
  });

  it('flags a seed that an active roster group claims', () => {
    // Claim the seed by its own (git-tracked) name — no hardcoded deal strings.
    useRoster({ g: { label: 'Synthetic Group', active: true, always: [publicSeed!.name.toLowerCase()] } });
    expect(claimedPublicSeedIds(SEED_DEALS)).toContain(publicSeed!.id);
  });

  it('flags a claim carried by a long free-text field (nextAction), not just the name', () => {
    useRoster({ g: { label: 'Synthetic Group', active: true, always: ['zzz-synthetic-claim-7c1e'] } });
    const poisoned = { ...publicSeed!, id: 'poisoned-seed', nextAction: 'call re zzz-synthetic-claim-7c1e' };
    expect(claimedPublicSeedIds([poisoned])).toEqual(['poisoned-seed']);
  });

  it('does not flag seeds when only an inactive group matches', () => {
    useRoster({ g: { label: 'Retired', active: false, always: [publicSeed!.name.toLowerCase()] } });
    expect(claimedPublicSeedIds(SEED_DEALS)).toEqual([]);
  });

  it('does not flag seeds when the roster matches none of them', () => {
    useRoster({ g: { label: 'Other', active: true, always: ['zzz-no-seed-contains-this-3d9a'] } });
    expect(claimedPublicSeedIds(SEED_DEALS)).toEqual([]);
  });

  it('ignores an already-confidential seed even when the roster claims it', () => {
    useRoster({ g: { label: 'Synthetic Group', active: true, always: ['zzz-synthetic-claim-7c1e'] } });
    const alreadyFlagged = { ...publicSeed!, id: 'flagged-seed', confidential: true, name: 'zzz-synthetic-claim-7c1e' };
    expect(claimedPublicSeedIds([alreadyFlagged])).toEqual([]);
  });

  it('fails closed (every public seed "claimed") on an unreadable roster', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    const publicIds = SEED_DEALS.filter((s) => !s.confidential).map((s) => s.id);
    expect(claimedPublicSeedIds(SEED_DEALS)).toEqual(publicIds);
  });
});

describe('seed roster-claim guard (real roster — skips loudly when unavailable)', () => {
  it('no confidential:false seed is claimed by the live roster', (ctx) => {
    const real = resolveRealRoster();
    if (real.reason !== null) {
      process.stderr.write(
        `\n[seed-roster-claim-guard] SKIPPED — real-roster check NOT performed: ${real.reason}. ` +
          'The synthetic-roster tests prove the detector, but this machine has NOT verified that ' +
          'src/data/seed-deals.ts is clear of the live roster. Run this suite on a box with ' +
          'hooks/confidential-terms.json (or set ORA_REAL_CONFIDENTIAL_TERMS_PATH) before merging seed changes.\n',
      );
      ctx.skip();
      return;
    }
    if (real.activeGroups === 0) {
      process.stderr.write(
        '\n[seed-roster-claim-guard] real roster loaded but has 0 ACTIVE groups — check is trivially clear ' +
          '(no active confidential deals).\n',
      );
    }
    process.env.CONFIDENTIAL_TERMS_PATH = real.path!;
    const claimed = claimedPublicSeedIds(SEED_DEALS);
    // Ids only: never print roster terms or labels.
    expect(
      claimed,
      `seed(s) with confidential:false are claimed by the live confidential roster — set confidential:true or remove: ${claimed.join(', ')}`,
    ).toEqual([]);
  });
});
