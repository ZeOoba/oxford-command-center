// tests/unit/theme-text-contrast.test.ts
import { describe, it, expect } from 'vitest';

function lin(c: number): number {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace('#', '');
  return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16), parseInt(hex.substring(4, 6), 16)];
}
function rgbToHex(rgb: (number | undefined)[]): string {
  let hex = '#';
  for (let i = 0; i < rgb.length; i++) {
    const v: number | undefined = rgb[i];
    const clamped: number = Math.max(0, Math.min(255, Math.round(v ?? 0)));
    const str: string = clamped.toString(16);
    const padded: string = str.padStart(2, '0');
    hex += padded;
  }
  return hex;
}
function composite(fgHex: string, alphaPct: number, bgHex: string): string {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  const a = alphaPct / 100;
  return rgbToHex(fg.map((c, i) => a * c + (1 - a) * (bg[i] ?? 0)));
}

const THEMES = {
  parchment: {
    surfaceBase: '#eef1f6',
    surfaceRaised: '#ffffff',
    surfaceOverlay: '#f6f8fb',
    color: { neg: '#d35338', warn: '#bd8311', info: '#2f7fd6', pos: '#1c9c63', accent: '#0e9e8e', accent2: '#7a5ad0' },
    text: { neg: '#a3402b', warn: '#835a0c', info: '#2462a4', pos: '#146f46', accent: '#0a6e62', accent2: '#684db2' },
  },
  warm: {
    surfaceBase: '#f3ede1',
    surfaceRaised: '#fffdf8',
    surfaceOverlay: '#fbf6ec',
    color: { neg: '#c2603c', warn: '#b8881f', info: '#2f6f6a', pos: '#3f8a5a', accent: '#c2603c', accent2: '#8a5a72' },
    text: { neg: '#94492e', warn: '#7c5b15', info: '#2f6f6a', pos: '#306a45', accent: '#94492e', accent2: '#8a5a72' },
  },
  command: {
    surfaceBase: '#0c0f14',
    surfaceRaised: '#141a22',
    surfaceOverlay: '#171f29',
    color: { neg: '#f06a4d', warn: '#f4b740', info: '#5aa7f0', pos: '#54d49a', accent: '#39d3c0', accent2: '#a98cf0' },
    text: { neg: '#f06a4d', warn: '#f4b740', info: '#5aa7f0', pos: '#54d49a', accent: '#39d3c0', accent2: '#a98cf0' },
  },
} as const;

const TINT_PCTS = [9, 10, 12, 14, 16];
const AA_SMALL_TEXT = 4.5;

describe('theme text-safe tone tokens clear WCAG AA (4.5:1)', () => {
  for (const [themeName, t] of Object.entries(THEMES)) {
    describe(themeName, () => {
      for (const tone of Object.keys(t.text) as Array<keyof typeof t.text>) {
        const textHex = t.text[tone];
        const fillHex = t.color[tone];

        it(`--text-${tone} on every ambient surface`, () => {
          for (const surf of ['surfaceBase', 'surfaceRaised', 'surfaceOverlay'] as const) {
            const c = contrast(textHex, t[surf]);
            expect(c, `${tone} on ${surf} (${t[surf]}): ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
          }
        });

        it(`--text-${tone} on every self-paired tint of --color-${tone}`, () => {
          for (const pct of TINT_PCTS) {
            for (const backdrop of [t.surfaceBase, t.surfaceRaised] as const) {
              const tinted = composite(fillHex, pct, backdrop);
              const c = contrast(textHex, tinted);
              expect(c, `${tone} on ${pct}% tint over ${backdrop} (${tinted}): ${c.toFixed(2)}`).toBeGreaterThanOrEqual(
                AA_SMALL_TEXT,
              );
            }
          }
        });
      }
    });
  }
});
