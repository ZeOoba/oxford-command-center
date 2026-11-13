// server/warehouse/rct-pin.ts
//
// The ratified Replacement-Cost Table (RCT) is governor-level data (Hard Invariant 4) and this repo is PUBLIC, so the
// table is NOT tracked. It lives in the gitignored runtime file config/replacement-cost.v3.json (a real-data manifest
// path: scripts/fixtures/real-data-manifest.json); CI and tests run on the invented stand-in at
// fixtures/synthetic/config/replacement-cost.v3.json. Setup and re-ratification: docs/ops/rct-runtime-config.md.
//
// "The ratified table" is pinned by RATIFIED_RCT_HMAC, an HMAC-SHA256 of the parsed table in canonical form (sorted
// keys, every parsed field: version, provenance, basis, fallback band, market rows, construction multipliers, adders),
// keyed by a SECRET held outside the repo in the RCT_PIN_KEY environment variable (.env on the Brain Server machine,
// process env for the mirror build). Keyed on purpose: a plain hash published here would confirm the values already in
// git history and let anyone brute-force a future re-ratification by starting from them. Without the key the pin
// reveals nothing; with it, a pasted test value, a typo, a stale version or a hand edit all fail closed instead of
// silently moving scores. A missing or short key also fails closed.
//
// Re-ratifying the RCT (Gabriel's approval, Invariant 4) therefore takes BOTH a new local table and a PR that updates
// RATIFIED_RCT_HMAC (and RCT_VERSION): `npm run check:rct-pin -- --print` prints the new pin from the local table and key.
//
// No message thrown from here carries a figure from the table.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReplacementCostTable } from '../../src/contracts/acquisition';
import { stableStringify } from './stable-stringify';

export const RCT_PIN_KEY_ENV = 'RCT_PIN_KEY';
export const PIN_KEY_MIN_LENGTH = 32;
/** replacement-cost.v3.2, copied byte-for-byte from the tracked config at 1ac9b8df (PR #569 head), 2026-11-13. */
export const RATIFIED_RCT_HMAC = '9d7ad838bf4434e56bd9e3fc8c72ee43b165378981648241b5b233986f32aa7b';

// Sanity bounds that hold for ANY table, pinned or not. Not scoring thresholds: they only catch a unit slip
// ($/SF typed as $ or as thousands), a negative or absurd multiplier, or an adder typed as a total.
export const RCT_PSF_MIN = 50;
export const RCT_PSF_MAX = 1000;
export const RCT_MULTIPLIER_MIN = 0.5;
export const RCT_MULTIPLIER_MAX = 2;
export const RCT_ADDER_MAX = 100;

/** True when the raw (pre-parse) JSON is the committed synthetic stand-in. The parse strips `_synthetic`, so callers
 *  must check the RAW object. */
export function isSyntheticRct(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['_synthetic'] === true;
}

/** HMAC-SHA256 (hex) of the parsed table's canonical form under `key`. */
export function rctTableHmac(table: ReplacementCostTable, key: string): string {
  return createHmac('sha256', key).update(stableStringify(table)).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Throws (fail closed) unless the RAW file is exactly its parsed form, apart from `_`-prefixed top-level note keys. The
 * pin hashes the parsed table, but the drawer and the scoring form read the RAW bundled JSON; a field the schema would
 * default or strip (a market row with no `proxy` parses to proxy:false and keeps the same pin, while the drawer drops
 * that market) would otherwise let one pin cover two tables that price differently (refute wf_fe1b0b9e-3b2). Requiring
 * every field explicit makes the pinned form equal what every reader reads.
 */
export function assertRawIsCanonical(raw: unknown, parsed: ReplacementCostTable): void {
  const top = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const withoutNotes = Object.fromEntries(Object.entries(top).filter(([k]) => !k.startsWith('_')));
  if (stableStringify(withoutNotes) !== stableStringify(parsed)) {
    throw new Error(`replacement-cost table ${parsed.rctVersion}: the file has a field the schema drops or defaults (every field must be explicit; notes go in '_'-prefixed top-level keys) — fail-closed`);
  }
}

/** Throws (fail closed) when any value is outside the sanity bounds or a band is out of order. */
export function assertPlausibleRct(t: ReplacementCostTable): void {
  const inPsf = (v: number): boolean => Number.isFinite(v) && v >= RCT_PSF_MIN && v <= RCT_PSF_MAX;
  const band = (low: number, mid: number, high: number): boolean => [low, mid, high].every(inPsf) && low <= mid && mid <= high;
  if (!band(t.psf.low, t.psf.mid, t.psf.high)) {
    throw new Error(`replacement-cost table ${t.rctVersion}: fallback band is outside the plausible $/SF range or out of order — fail-closed`);
  }
  for (const [m, r] of Object.entries(t.markets)) {
    if (!band(r.low, r.point, r.high) || !inPsf(r.cwHardPsf)) {
      throw new Error(`replacement-cost table ${t.rctVersion}: market '${m}' is outside the plausible $/SF range or out of order — fail-closed`);
    }
  }
  const cm = t.constructionMultipliers;
  const mults = [cm['tilt-precast'], cm.cmu, cm.brick, cm.hybrid, cm.pemb.under20k, cm.pemb.under40k, cm.pemb.upTo50k, cm.pemb.above50k, cm.unknownCap];
  if (!mults.every((v) => Number.isFinite(v) && v >= RCT_MULTIPLIER_MIN && v <= RCT_MULTIPLIER_MAX)) {
    throw new Error(`replacement-cost table ${t.rctVersion}: a construction multiplier is outside the plausible range — fail-closed`);
  }
  if (!Object.values(t.adders).every((v) => Number.isFinite(v) && v >= 0 && v <= RCT_ADDER_MAX)) {
    throw new Error(`replacement-cost table ${t.rctVersion}: an adder is outside the plausible $/SF range — fail-closed`);
  }
}

/** Throws (fail closed) unless `t` is the ratified table pinned above, checked under the secret key. */
export function assertPinnedRct(
  t: ReplacementCostTable,
  key: string | undefined,
  pinnedHmac: string = RATIFIED_RCT_HMAC,
): void {
  if (typeof key !== 'string' || key.trim().length < PIN_KEY_MIN_LENGTH) {
    throw new Error(`replacement-cost table cannot be verified: ${RCT_PIN_KEY_ENV} is not set (or shorter than ${PIN_KEY_MIN_LENGTH} chars) — fail-closed. See docs/ops/rct-runtime-config.md`);
  }
  if (!sameHex(rctTableHmac(t, key.trim()), pinnedHmac)) {
    throw new Error(`replacement-cost table ${t.rctVersion} does not match the ratified table pinned in server/warehouse/rct-pin.ts (re-ratification needs a code change too) — fail-closed`);
  }
}
