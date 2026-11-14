// tests/unit/rct-public-leak.test.ts
//
// The ratified Replacement-Cost Table is governor-level data (Hard Invariant 4) and this repo is PUBLIC, so it is
// local-only: the gitignored config/replacement-cost.v3.json, pinned by keyed HMAC (server/warehouse/rct-pin.ts;
// docs/ops/rct-runtime-config.md). This file guards the public surface.
//
//   - Always on: the table path is untracked, gitignored and a real-data manifest path; the committed stand-in is marked
//     synthetic; the pin is a 64-hex HMAC; the production loader refuses the stand-in.
//   - With the LOCAL ratified table present (it is absent in CI and on fresh clones, where these cases skip): no tracked
//     file carries a $/SF figure from the table, the construction-multiplier schedule or the
//     adder schedule; the local table matches the pin when RCT_PIN_KEY is available; and the key itself is in no tracked
//     file. Failures name the file and a count, never a figure.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RCT_VERSION, ReplacementCostTable } from '@contracts/acquisition';
import { loadRatifiedRct, REPLACEMENT_COST_TABLE_PATH } from '../../server/warehouse/acquisition';
import { isSyntheticRct, PIN_KEY_MIN_LENGTH, RATIFIED_RCT_HMAC, RCT_PIN_KEY_ENV } from '../../server/warehouse/rct-pin';
import { SYNTHETIC_RCT_PATH } from '../support/rct';

const ROOT = process.cwd();
const LOCAL = resolve(ROOT, REPLACEMENT_COST_TABLE_PATH);
const localRaw: unknown = existsSync(LOCAL) ? (JSON.parse(readFileSync(LOCAL, 'utf8')) as unknown) : null;
const HAVE_REAL = localRaw !== null && !isSyntheticRct(localRaw);

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);

/** The pin key from the environment, else from the repo .env (read-only). */
function pinKey(): string | null {
  const fromEnv = process.env[RCT_PIN_KEY_ENV];
  if (fromEnv && fromEnv.trim().length >= PIN_KEY_MIN_LENGTH) return fromEnv.trim();
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${RCT_PIN_KEY_ENV}=`));
  const v = line?.slice(RCT_PIN_KEY_ENV.length + 1).trim().replace(/^["']|["']$/g, '');
  return v && v.length >= PIN_KEY_MIN_LENGTH ? v : null;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A number as it might be written: 2-decimal form and its trailing-zero-trimmed form, bounded by non-digits. */
function numberRx(values: number[]): RegExp {
  const forms = new Set<string>();
  for (const v of values) {
    const two = v.toFixed(2);
    forms.add(two);
    forms.add(two.replace(/0+$/, '').replace(/\.$/, ''));
  }
  const alts = [...forms].sort((a, b) => b.length - a.length).map(esc).join('|');
  return new RegExp(`(?<![\\d.])(?:${alts})(?![\\d])`, 'g');
}

function textFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const skip = (rel: string): boolean => rel.startsWith('fixtures/synthetic/') || rel.endsWith('package-lock.json');
  const read = (rel: string, abs: string): void => {
    if (skip(rel)) return;
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { return; }
    if (buf.includes(0)) return; // binary
    out.push({ rel, text: buf.toString('utf8') });
  };
  for (const rel of tracked()) read(rel, join(ROOT, rel));
  // dist/ is NOT scanned: a local build bundles the real table by design (the drawer and the edge Function need it),
  // dist/ is gitignored, and the only deployed bundle is the Access-gated mirror (refute wf_766c618b-288).
  return out;
}

describe('RCT public surface: structural (always on)', () => {
  it('the ratified table path is untracked, gitignored and listed in the real-data manifest', () => {
    expect(tracked()).not.toContain(REPLACEMENT_COST_TABLE_PATH);
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '-q', REPLACEMENT_COST_TABLE_PATH], { cwd: ROOT, stdio: 'pipe' });
    expect(ignored).toBeDefined(); // throws (exit 1) when not ignored
    const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/fixtures/real-data-manifest.json'), 'utf8')) as { files: string[]; optional?: string[] };
    expect(manifest.files).toContain(REPLACEMENT_COST_TABLE_PATH);
    expect(manifest.optional ?? []).not.toContain(REPLACEMENT_COST_TABLE_PATH); // required: production fails closed without it
  });

  it('the committed stand-in is marked synthetic, and the production loader refuses it', () => {
    const raw = JSON.parse(readFileSync(SYNTHETIC_RCT_PATH, 'utf8')) as unknown;
    expect(isSyntheticRct(raw)).toBe(true);
    expect(() => loadRatifiedRct(SYNTHETIC_RCT_PATH)).toThrow(/synthetic/);
  });

  it('the pin is a keyed HMAC-SHA256 (64 hex), not a placeholder', () => {
    expect(RATIFIED_RCT_HMAC).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!HAVE_REAL)('RCT public surface: value scan against the local ratified table', () => {
  const real = HAVE_REAL ? ReplacementCostTable.parse(localRaw) : null;

  it('the local table is the current version', () => {
    expect(real!.rctVersion).toBe(RCT_VERSION);
  });

  it('no tracked file carries a $/SF figure from the table', () => {
    const t = real!;
    const figures = [t.psf.low, t.psf.mid, t.psf.high, ...Object.values(t.markets).flatMap((m) => [m.low, m.point, m.high, m.cwHardPsf])]
      .filter((v) => !Number.isInteger(v)); // whole numbers are too common to attribute
    const rx = numberRx(figures);
    const hits = textFiles().map(({ rel, text }) => ({ rel, n: (text.match(rx) ?? []).length })).filter((h) => h.n > 0);
    expect(hits, 'tracked file(s) carry ratified RCT $/SF figures (counts only)').toEqual([]);
  });

  it('no tracked file carries the construction-multiplier schedule or the adder schedule', () => {
    const cm = real!.constructionMultipliers;
    const mults = [...new Set([cm.cmu, cm.brick, cm.hybrid, cm.pemb.under20k, cm.pemb.under40k, cm.pemb.upTo50k, cm.pemb.above50k, cm.unknownCap])]
      .filter((v) => v !== 1);
    // A multiplier counts only next to a construction word or a × sign; three or more distinct ones in a file is the schedule.
    const ctx = '(?:CMU|PEMB|brick|hybrid|tilt|unknown|×)';
    const multRx = mults.map((v) => {
      const n = numberRx([v]).source;
      return new RegExp(`${ctx}[^\\n]{0,25}${n}|${n}[^\\n]{0,12}${ctx}`, 'i');
    });
    const adderRx = Object.values(real!.adders).map((v) => new RegExp(`\\+\\s?\\$${esc(String(v))}(?![\\d.])`));
    const hits = textFiles()
      .map(({ rel, text }) => ({
        rel,
        multipliers: multRx.filter((r) => r.test(text)).length,
        adders: /adder|ESFR|crane|site work|climate/i.test(text) ? adderRx.filter((r) => r.test(text)).length : 0,
      }))
      .filter((h) => h.multipliers >= 3 || h.adders >= 3);
    expect(hits, 'tracked file(s) carry the ratified construction/adder schedule (counts only)').toEqual([]);
  });

  const key = HAVE_REAL ? pinKey() : null;
  it.skipIf(key === null)('the local table matches the pin, and the pin key is in no tracked file', () => {
    expect(() => loadRatifiedRct(LOCAL, { env: { [RCT_PIN_KEY_ENV]: key! } })).not.toThrow();
    const leaked = textFiles().filter(({ text }) => text.includes(key!)).map(({ rel }) => rel);
    expect(leaked).toEqual([]);
  });
});
