import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 2026-09-23 review: "Command Overview" truncated to "Command" at 1280px because the right-hand
// control cluster left the title ~70px. Measured in the browser (1280/1440/375): the title reads in
// full at >=1280 once the cluster compacts below 2xl, and still truncates (never overlaps) on mobile.
const src = readFileSync('src/shell/TopBar.tsx', 'utf8');

describe('TopBar title', () => {
  it('title keeps truncate as the narrow-screen fallback (shrink-0 overlapped the controls at 375px)', () => {
    const h1 = /<h1 className="([^"]+)"/.exec(src)?.[1] ?? '';
    expect(h1).toContain('truncate');
    expect(h1).not.toContain('shrink-0');
  });

  it('the as-of dateline yields first and only shows where it fits', () => {
    const asOf = /<span className="([^"]+)"[^>]*>\s*As of/.exec(src)?.[1] ?? '';
    expect(asOf).toContain('shrink-[100]');
    expect(asOf).toContain('truncate');
    expect(asOf).toContain('min-[1400px]:inline');
  });

  it('the control cluster compacts below 2xl to leave the title its width', () => {
    expect(src).toContain('<span className="hidden 2xl:inline">Search…</span>');
    expect(src).toContain('<div className="flex items-center gap-2 2xl:gap-2.5">');
    expect(readFileSync('src/primitives/StatusPill.tsx', 'utf8')).toContain('className="hidden 2xl:inline"');
  });
});
