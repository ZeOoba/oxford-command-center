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

// BRAIN_HOST_AUTH=tailnet (Gabriel-approved 2026-11-09). The live server is reached through Tailscale
// Serve, not Cloudflare Access, so the tunnel rule above would crash-loop it. The opt-in is explicit and
// narrow: extra hosts are allowed without ACCESS_REQUIRE=1 ONLY if every one is a *.ts.net name, matched
// on whole DNS labels (never a substring), and any other BRAIN_HOST_AUTH value refuses to start.
describe('accessAuthzOptionsFromEnv — BRAIN_HOST_AUTH=tailnet opt-in', () => {
  const LIVE_HOST = 'ora-command-center.tail71f8c8.ts.net';
  const quiet = () => {};

  it('tailnet + a .ts.net host starts with Access inert and logs the tailnet boundary once', () => {
    const lines: string[] = [];
    const opts = accessAuthzOptionsFromEnv(
      { BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: LIVE_HOST },
      (m) => lines.push(m),
    );
    expect(opts.enabled).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/tailnet ACL is the authorization boundary/);
    expect(lines[0]).toContain(LIVE_HOST);
  });

  it.each([
    ['upper case', 'ORA-Command-Center.Tail71F8C8.TS.NET'],
    ['several .ts.net hosts', `${LIVE_HOST}, other-box.tail71f8c8.ts.net`],
    ['explicit port', `${LIVE_HOST}:443`],
    ['single label before ts.net', 'box.ts.net'],
  ])('tailnet accepts %s', (_label, hosts) => {
    expect(
      accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: hosts }, quiet).enabled,
    ).toBe(false);
  });

  it.each([
    'evil.example.com',
    'ts.net.evil.com',
    'ts.net',
    '.ts.net',
    'evilts.net',
    'box.evilts.net',
    'box.ts.network',
    'box.ts.net.',
    'box.ts.net.evil',
    'box.ts-net',
    'box..ts.net',
    '*.ts.net',
    'box.ts.net@evil.com',
    'evil.com#.ts.net',
    'evil.com/.ts.net',
    'evil.com?.ts.net',
    'box.ts.net:',
    'box.ts.net:0',
    'box.ts.net:65536',
    'box.ts.net:443:443',
    'box.ts.net:+443',
    'box.ts.net :443',
    'bo x.ts.net',
    'box.ts\u2024net',
    'b\u00f6x.ts.net',
    'box.ts.ne\u0074\u0000',
    '-box.ts.net',
    'box-.ts.net',
    '[::1].ts.net',
    '127.0.0.1',
    `${LIVE_HOST}, evil.example.com`,
  ])('tailnet refuses to start with non-.ts.net extra host %j', (hosts) => {
    expect(() =>
      accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: hosts }, quiet),
    ).toThrow(/BRAIN_HOST_AUTH=tailnet/);
  });

  it.each(['Tailnet', 'TAILNET', ' tailnet', 'tailnet ', 'tailscale', 'access', 'none', '0', '1', 'true', 'tailnet,access'])(
    'bad BRAIN_HOST_AUTH=%j refuses to start, even with no extra hosts',
    (value) => {
      expect(() => accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: value }, quiet)).toThrow(/BRAIN_HOST_AUTH/);
      expect(() =>
        accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: value, BRAIN_ALLOWED_HOSTS: LIVE_HOST }, quiet),
      ).toThrow(/BRAIN_HOST_AUTH/);
    },
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('BRAIN_HOST_AUTH %s keeps the existing rule: .ts.net host without ACCESS_REQUIRE=1 refuses', (_l, value) => {
    expect(() =>
      accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: value, BRAIN_ALLOWED_HOSTS: LIVE_HOST }, quiet),
    ).toThrow(/ACCESS_REQUIRE is not "1"/);
  });

  it('BRAIN_HOST_AUTH unset logs nothing on a loopback-only start', () => {
    const lines: string[] = [];
    accessAuthzOptionsFromEnv({}, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  it('tailnet + ACCESS_REQUIRE=1 is allowed and means Access is enforced as well', () => {
    const lines: string[] = [];
    const opts = accessAuthzOptionsFromEnv(
      { BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: LIVE_HOST, ACCESS_REQUIRE: '1', ...CONFIGURED },
      (m) => lines.push(m),
    );
    expect(opts.enabled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Access is enforced as well/);
  });

  it('tailnet + ACCESS_REQUIRE=1 still enforces the .ts.net-only rule', () => {
    expect(() =>
      accessAuthzOptionsFromEnv(
        { BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: 'evil.example.com', ACCESS_REQUIRE: '1', ...CONFIGURED },
        quiet,
      ),
    ).toThrow(/BRAIN_HOST_AUTH=tailnet/);
  });

  it('tailnet + ACCESS_REQUIRE=1 with missing ACCESS_* config still refuses', () => {
    expect(() =>
      accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: LIVE_HOST, ACCESS_REQUIRE: '1' }, quiet),
    ).toThrow(/ACCESS_ISSUER/);
  });

  it('tailnet + malformed ACCESS_REQUIRE still refuses', () => {
    expect(() =>
      accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: 'tailnet', BRAIN_ALLOWED_HOSTS: LIVE_HOST, ACCESS_REQUIRE: 'true' }, quiet),
    ).toThrow(/ACCESS_REQUIRE/);
  });

  it('tailnet with no extra hosts starts loopback-only and says so', () => {
    const lines: string[] = [];
    const opts = accessAuthzOptionsFromEnv({ BRAIN_HOST_AUTH: 'tailnet' }, (m) => lines.push(m));
    expect(opts.enabled).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no extra hosts/);
  });
});
