import { describe, expect, it } from 'vitest';
import { findUndefinedTokens } from '../../scripts/check-css-tokens';

describe('findUndefinedTokens', () => {
  it('flags a var() reference with no definition anywhere', () => {
    const out = findUndefinedTokens([
      { path: 'a.css', text: ':root { --defined: 1px; }' },
      { path: 'b.tsx', text: `<div style={{ background: 'var(--missing)' }} />` },
    ]);
    expect(out).toEqual([{ token: '--missing', path: 'b.tsx', line: 1 }]);
  });

  it('accepts tokens defined in a stylesheet or by an inline setter', () => {
    const out = findUndefinedTokens([
      { path: 'a.css', text: '[data-theme="x"] { --surface-raised: #fff; }' },
      { path: 'b.tsx', text: `style={{ '--bar-w': w }} /> var(--bar-w) var(--surface-raised)` },
    ]);
    expect(out).toEqual([]);
  });

  it('still flags a token whose var() has a fallback', () => {
    const out = findUndefinedTokens([{ path: 'c.tsx', text: `'var(--danger, #e05c5c)'` }]);
    expect(out.map((o) => o.token)).toEqual(['--danger']);
  });

  it('skips runtime-built names like var(--pf-c${slot})', () => {
    const out = findUndefinedTokens([{ path: 'e.tsx', text: 'const c = `var(--pf-c${slot})`;' }]);
    expect(out).toEqual([]);
  });

  it('flags the nested fallback token too and reports the line', () => {
    const out = findUndefinedTokens([
      { path: 'd.tsx', text: `ok\n'var(--surface-alt, var(--surface))'` },
    ]);
    expect(out.map((o) => `${o.token}@${o.line}`)).toEqual(['--surface-alt@2', '--surface@2']);
  });
});
