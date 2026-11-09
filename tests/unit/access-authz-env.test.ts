// accessAuthzOptionsFromEnv — startup parse of ACCESS_REQUIRE (audit 2026-11-08,
// brain-authz-fail-open-tunnel). The Brain Server used `enabled = ACCESS_REQUIRE === '1'`, so any
// other value ('true', '1 ', 'yes', a typo) booted with authorization INERT while the edge
// (functions/_shared/access-identity.ts) fails closed on the very same input. With BRAIN_ALLOWED_HOSTS
// admitting the tunnel hostname, that exposed every /api/* and /sse route unauthenticated.
//
// Rule now mirrors the edge: unset / '' / '0' = inert, '1' = enabled, anything else = refuse to start.
// And a tunnel configuration (BRAIN_ALLOWED_HOSTS non-empty) without ACCESS_REQUIRE=1 refuses to start.
import { describe, it, expect } from 'vitest';
import { accessAuthzOptionsFromEnv } from '../../server/access-authz';

const CONFIGURED = {
  ACCESS_ISSUER: 'https://team.cloudflareaccess.example.invalid',
  ACCESS_AUD: 'aud-tag',
  ACCESS_ALLOWLIST: 'a@example.invalid',
};

describe('accessAuthzOptionsFromEnv — ACCESS_REQUIRE parse mirrors the edge rule', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['"0"', '0'],
  ])('%s is inert (local dev)', (_label, value) => {
    const opts = accessAuthzOptionsFromEnv({ ACCESS_REQUIRE: value });
    expect(opts.enabled).toBe(false);
  });

  it('"1" with full config is enabled', () => {
    const opts = accessAuthzOptionsFromEnv({ ACCESS_REQUIRE: '1', ...CONFIGURED });
    expect(opts.enabled).toBe(true);
    expect(opts.allowlist).toEqual(['a@example.invalid']);
  });

  it('"1" with missing issuer/aud/allowlist still refuses to start', () => {
    expect(() => accessAuthzOptionsFromEnv({ ACCESS_REQUIRE: '1' })).toThrow(/refusing to start/);
  });

  it.each(['true', 'TRUE', 'yes', 'on', '1 ', ' 1', '01', '00', '2', 'false', 'off'])(
    'malformed ACCESS_REQUIRE=%j refuses to start instead of going inert',
    (value) => {
      expect(() => accessAuthzOptionsFromEnv({ ACCESS_REQUIRE: value, ...CONFIGURED })).toThrow(
        /ACCESS_REQUIRE/,
      );
    },
  );
});

describe('accessAuthzOptionsFromEnv — tunnel hosts require ACCESS_REQUIRE=1', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['"0"', '0'],
  ])('BRAIN_ALLOWED_HOSTS set with ACCESS_REQUIRE %s refuses to start', (_label, value) => {
    expect(() =>
      accessAuthzOptionsFromEnv({ ACCESS_REQUIRE: value, BRAIN_ALLOWED_HOSTS: 'brain.example.invalid' }),
    ).toThrow(/BRAIN_ALLOWED_HOSTS/);
  });

  it('BRAIN_ALLOWED_HOSTS set with ACCESS_REQUIRE=1 and full config starts enabled', () => {
    const opts = accessAuthzOptionsFromEnv({
      ACCESS_REQUIRE: '1',
      BRAIN_ALLOWED_HOSTS: 'brain.example.invalid',
      ...CONFIGURED,
    });
    expect(opts.enabled).toBe(true);
  });

  it('whitespace/comma-only BRAIN_ALLOWED_HOSTS counts as no extra hosts (same parse as host-guard)', () => {
    const opts = accessAuthzOptionsFromEnv({ BRAIN_ALLOWED_HOSTS: ' , ,' });
    expect(opts.enabled).toBe(false);
  });
});
