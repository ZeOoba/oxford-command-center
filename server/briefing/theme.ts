// server/briefing/theme.ts
//
// ORA Style Guide tokens + brand-font registration for the briefing PDF. SERVER-ONLY (imports
// @react-pdf/renderer and @fontsource/* — never reachable from the client bundle).
//
// Fonts: the brand faces ship from the @fontsource/* packages as .woff/.woff2 (fontsource v5
// publishes those, not raw .ttf). react-pdf's bundled fontkit cannot embed the @fontsource woff/woff2
// reliably (the woff codepath crashes on the space glyph; the woff2 subsetter crashes on embed). Its
// TTF path embeds cleanly — so we decode each brand .woff → a standard TTF in-process (pure node:zlib,
// no dep, offline, deterministic — see woff-to-ttf.ts), cache it once, and register the TTF file. The
// embedded subset carries an extractable ToUnicode CMap, so the text layer IS the brand typeface AND
// is searchable/extractable (verified end-to-end in the test suite). No font is fetched from the web.
//
// FAIL-LOUD fallback (Behavior contract / adversarial #3): if a brand face file is missing or fails to
// decode we LOG a loud error and register Helvetica under the brand family name so layout still
// renders — we NEVER silently swap a non-brand face without a trace. `fontHealth()` lets a test assert
// every brand face resolved to a real file (guarding a silent brand-face drop).
import { Font } from '@react-pdf/renderer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { woffToTtf } from './woff-to-ttf';

const require = createRequire(import.meta.url);

// ── ORA brand tokens (Style Guide v1.0) ──────────────────────────────────────────────────────
export const ORA = {
  navy: '#1B2A4A', // masthead, headers
  gold: '#C9A96E', // rules, accents
  parchment: '#F5F3EF', // panels
  ink: '#1A1A1A', // body text
  muted: '#6B7280', // secondary text
  pos: '#15803D', // favorable
  neg: '#B91C1C', // unfavorable
  hairline: '#D8D4CC',
  white: '#FFFFFF',
} as const;

export const FONT = {
  serif: 'EB Garamond', // display / headings
  sans: 'DM Sans', // labels / body
  mono: 'IBM Plex Mono', // figures (tabular)
} as const;

interface FaceSpec {
  family: string;
  pkg: string; // @fontsource subpath for the .woff file
  fontWeight: number;
}

// Brand faces. Each maps a family+weight to a @fontsource .woff (decoded to TTF before registration).
// Resolved via createRequire so the path is correct in every worktree / install location.
const FACES: FaceSpec[] = [
  { family: FONT.serif, pkg: '@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff', fontWeight: 400 },
  { family: FONT.serif, pkg: '@fontsource/eb-garamond/files/eb-garamond-latin-600-normal.woff', fontWeight: 600 },
  { family: FONT.serif, pkg: '@fontsource/eb-garamond/files/eb-garamond-latin-700-normal.woff', fontWeight: 700 },
  { family: FONT.sans, pkg: '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff', fontWeight: 400 },
  { family: FONT.sans, pkg: '@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff', fontWeight: 500 },
  { family: FONT.sans, pkg: '@fontsource/dm-sans/files/dm-sans-latin-700-normal.woff', fontWeight: 700 },
  { family: FONT.mono, pkg: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff', fontWeight: 400 },
  { family: FONT.mono, pkg: '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff', fontWeight: 500 },
];

export interface FontHealth {
  family: string;
  fontWeight: number;
  resolvedPath: string | null; // null ⇒ the brand file was missing/undecodable; Helvetica substituted
  brandFaceLoaded: boolean;
}

let registered: FontHealth[] | null = null;

/** Deterministic on-disk cache dir for the decoded TTFs (one per host tmpdir; idempotent). */
function cacheDir(): string {
  const dir = join(tmpdir(), 'ora-briefing-fonts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Decode a brand .woff to a TTF on disk (cached by content hash) and return the TTF path. */
function decodeToTtf(woffPath: string, family: string, weight: number): string {
  const woff = readFileSync(woffPath);
  const hash = createHash('sha1').update(woff).digest('hex').slice(0, 12);
  const out = join(cacheDir(), `${family.replace(/\s+/g, '')}-${weight}-${hash}.ttf`);
  if (!existsSync(out)) writeFileSync(out, woffToTtf(woff));
  return out;
}

/** Register every brand face exactly once. Idempotent; returns the per-face health report. */
export function registerFonts(): FontHealth[] {
  if (registered) return registered;
  const health: FontHealth[] = [];
  for (const face of FACES) {
    let ttfPath: string | null = null;
    try {
      const woffPath = require.resolve(face.pkg);
      if (existsSync(woffPath)) ttfPath = decodeToTtf(woffPath, face.family, face.fontWeight);
    } catch {
      ttfPath = null;
    }
    if (ttfPath) {
      Font.register({ family: face.family, src: ttfPath, fontWeight: face.fontWeight });
      health.push({ family: face.family, fontWeight: face.fontWeight, resolvedPath: ttfPath, brandFaceLoaded: true });
    } else {
      // FAIL LOUD — never a silent non-brand swap (adversarial #3).
      console.error(
        `[briefing] BRAND FONT MISSING: ${face.family} ${face.fontWeight} (${face.pkg}) — ` +
          `falling back to Helvetica for this face. The PDF will NOT be in the brand typeface.`,
      );
      health.push({ family: face.family, fontWeight: face.fontWeight, resolvedPath: null, brandFaceLoaded: false });
    }
  }
  // Disable react-pdf hyphenation (deterministic line breaks; no dictionary fetch).
  Font.registerHyphenationCallback((word) => [word]);
  registered = health;
  return health;
}

/** True iff EVERY brand face resolved to a real file (no Helvetica substitution). A test asserts
 *  this so a silent brand-face drop fails the suite (adversarial #3). */
export function fontHealth(): FontHealth[] {
  return registerFonts();
}

export function allBrandFacesLoaded(): boolean {
  return registerFonts().every((f) => f.brandFaceLoaded);
}
