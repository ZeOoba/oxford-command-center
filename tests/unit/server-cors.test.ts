import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, LOCALHOST_ORIGIN_RE } from '../../server/cors-policy';

/**
 * Regression lock on the API's localhost-only CORS rule (CLAUDE.md §9: "never relax").
 * Confidential deal data must never be reachable cross-origin.
 */
describe('isAllowedOrigin', () => {
  it.each([
    'http://localhost',
    'https://localhost',
    'http://localhost:5173',
    'http://localhost:8911',
    'http://127.0.0.1',
    'https://127.0.0.1',
    'http://127.0.0.1:3000',
  ])('echoes the same-machine origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(origin);
  });

  it.each([
    'http://evil.com',
    'https://app.oxfordra.net',
    'http://192.168.1.50',
    'http://10.0.0.1:8911',
    'http://0.0.0.0:8911',
    // Look-alikes that must NOT pass — anchoring matters.
    'http://localhost.evil.com',
    'http://evil.com/localhost',
    'https://127.0.0.1.evil.com',
    'http://notlocalhost',
    'http://localhost:abc',
    'file://localhost',
    '',
    'null',
  ])('rejects non-localhost origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBeNull();
  });

  it('is fully anchored (no leading/trailing slop)', () => {
    expect(LOCALHOST_ORIGIN_RE.source.startsWith('^')).toBe(true);
    expect(LOCALHOST_ORIGIN_RE.source.endsWith('$')).toBe(true);
  });
});
