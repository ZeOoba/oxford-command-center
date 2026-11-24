// @vitest-environment node
// Tier 3 UI hygiene PR C (2026-11-23 review): --text-tertiary measured 2.7-4.3:1 against the
// surfaces it sits on (WCAG AA for body text is 4.5:1). Pins primary/secondary/tertiary text at AA
// on both the base and the raised surface in every theme, so a palette edit cannot regress it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join('src', 'tokens', 'theme.css'), 'utf8');

function themeBlock(theme: string): string {
  const start = css.indexOf(`[data-theme='${theme}']`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

function token(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`${name} not a 6-digit hex in block`);
  return m[1]!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe.each(['command', 'parchment', 'warm'])('theme %s text contrast', (theme) => {
  const block = themeBlock(theme);
  // --surface-overlay added 2026-11-24: the scenario/profile pills sit on it, and the first e2e axe run
  // caught tertiary text at 4.3:1 there (the base/raised check alone missed it).
  it.each(['--text-primary', '--text-secondary', '--text-tertiary'])('%s is at least 4.5:1 on base, raised and overlay surfaces', (name) => {
    const fg = token(block, name);
    for (const surface of ['--surface-base', '--surface-raised', '--surface-overlay']) {
      expect(contrast(fg, token(block, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
