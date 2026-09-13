import { describe, it, expect } from 'vitest';
import {
  allowedHosts,
  isAllowedHost,
  isAllowedRequestOrigin,
  checkRequestBoundary,
  extraAllowedHostsFromEnv,
} from '../../server/host-guard';
import { ORA_CLIENT_HEADER_VALUE } from '../../src/contracts/client-header';

/**
 * Regression lock on the Brain Server's request boundary (OI-050). Companion to server-cors.test.ts:
 * that file proves the CORS *response header* policy; this one proves the checks that actually
 * REJECT a request before any handler runs — the Host allowlist (DNS-rebinding defense), the
 * fail-closed Origin check, and the custom-header requirement on state-mutating methods.
 */
const PORT = 8911;
const DEFAULT = allowedHosts(PORT);

describe('allowedHosts', () => {
  it('is exactly the two loopback authorities for the listening port — nothing else', () => {
    expect([...DEFAULT].sort()).toEqual(['127.0.0.1:8911', 'localhost:8911']);
  });

  it('tracks the configured port, not a hardcoded 8911', () => {
    expect([...allowedHosts(8930)].sort()).toEqual(['127.0.0.1:8930', 'localhost:8930']);
  });

  it('accepts the bare (port-less) authority ONLY when listening on the http default port 80', () => {
    expect([...allowedHosts(80)].sort()).toEqual(['127.0.0.1', '127.0.0.1:80', 'localhost', 'localhost:80']);
    expect(DEFAULT.has('localhost')).toBe(false);
    expect(DEFAULT.has('127.0.0.1')).toBe(false);
  });

  it('adds explicitly configured extra hosts, normalized (trimmed, lower-cased, blanks dropped)', () => {
    const set = allowedHosts(PORT, [' Brain.OxfordRA.net ', '', '  ']);
    expect([...set].sort()).toEqual(['127.0.0.1:8911', 'brain.oxfordra.net', 'localhost:8911']);
  });
});

describe('isAllowedHost', () => {
  it.each([
    'localhost:8911',
    '127.0.0.1:8911',
    'LOCALHOST:8911', // hostnames are case-insensitive
    'Localhost:8911',
  ])('accepts the same-machine authority %s', (host) => {
    expect(isAllowedHost(host, DEFAULT)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '   ',
    // The DNS-rebinding case: an attacker hostname resolving to 127.0.0.1 still names ITSELF here.
    'attacker.example:8911',
    'attacker.example',
    // Right machine, wrong port — not this server.
    'localhost:8912',
    '127.0.0.1:8912',
    'localhost',
    '127.0.0.1',
    // Other local/loopback spellings the server does not bind (serve() binds 127.0.0.1 only).
    '[::1]:8911',
    '0.0.0.0:8911',
    '127.1:8911',
    '127.0.0.2:8911',
    '2130706433:8911',
    '0x7f000001:8911',
    '192.168.1.50:8911',
    '10.0.0.1:8911',
    // Look-alikes that must NOT pass — exact-match, not prefix/suffix/substring.
    'localhost.evil.com:8911',
    'evil.localhost:8911',
    'localhost:8911.evil.com',
    '127.0.0.1.evil.com:8911',
    'notlocalhost:8911',
    'localhost:08911',
    'localhost:8911:8911',
    'localhost:8911/',
    'evil.com/localhost:8911',
    'http://localhost:8911',
    'localhost:abc',
    'localhost:',
  ])('rejects non-matching Host %s', (host) => {
    expect(isAllowedHost(host, DEFAULT)).toBe(false);
  });

  it('accepts a configured extra host, and still rejects its look-alikes', () => {
    const set = allowedHosts(PORT, ['brain.oxfordra.net']);
    expect(isAllowedHost('brain.oxfordra.net', set)).toBe(true);
    expect(isAllowedHost('BRAIN.oxfordra.net', set)).toBe(true);
    expect(isAllowedHost('brain.oxfordra.net.evil.com', set)).toBe(false);
    expect(isAllowedHost('xbrain.oxfordra.net', set)).toBe(false);
    expect(isAllowedHost('brain.oxfordra.net:8911', set)).toBe(false);
  });

  it('rejects everything on an empty allowlist rather than defaulting to open', () => {
    expect(isAllowedHost('localhost:8911', new Set())).toBe(false);
  });
});

describe('isAllowedRequestOrigin', () => {
  it.each([
    'http://localhost',
    'http://localhost:5173',
    'http://localhost:5273',
    'http://localhost:8911',
    'http://127.0.0.1:3000',
    'https://127.0.0.1',
  ])('accepts the same-machine origin %s (delegates to cors-policy)', (origin) => {
    expect(isAllowedRequestOrigin(origin, DEFAULT)).toBe(true);
  });

  it.each([
    'http://evil.com',
    'https://app.oxfordra.net',
    'http://192.168.1.50',
    'http://0.0.0.0:8911',
    'http://localhost.evil.com',
    'http://evil.com/localhost',
    'https://127.0.0.1.evil.com',
    'http://notlocalhost',
    'file://localhost',
    'null', // opaque origin (sandboxed iframe / redirect) is not a same-machine page
    '',
  ])('rejects the foreign origin %s', (origin) => {
    expect(isAllowedRequestOrigin(origin, DEFAULT)).toBe(false);
  });

  it('accepts an origin whose authority is a configured extra host, exactly', () => {
    const set = allowedHosts(PORT, ['brain.oxfordra.net']);
    expect(isAllowedRequestOrigin('https://brain.oxfordra.net', set)).toBe(true);
    expect(isAllowedRequestOrigin('http://brain.oxfordra.net', set)).toBe(true);
    expect(isAllowedRequestOrigin('https://brain.oxfordra.net.evil.com', set)).toBe(false);
    expect(isAllowedRequestOrigin('https://evil.com/brain.oxfordra.net', set)).toBe(false);
    expect(isAllowedRequestOrigin('https://brain.oxfordra.net/path', set)).toBe(false); // not an origin
    expect(isAllowedRequestOrigin('https://brain.oxfordra.net:8443', set)).toBe(false); // wrong authority
    expect(isAllowedRequestOrigin('ftp://brain.oxfordra.net', set)).toBe(false);
  });
});

describe('checkRequestBoundary', () => {
  const ok = (method: string, over: Partial<Parameters<typeof checkRequestBoundary>[0]> = {}) =>
    checkRequestBoundary(
      { method, host: 'localhost:8911', origin: undefined, clientHeader: undefined, ...over },
      DEFAULT,
    );

  it('passes a plain same-origin GET (no Origin header, right Host)', () => {
    expect(ok('GET')).toEqual({ ok: true });
    expect(ok('HEAD')).toEqual({ ok: true });
  });

  it('rejects a foreign Host FIRST, whatever else the request carries', () => {
    expect(
      ok('GET', { host: 'attacker.example:8911', origin: 'http://localhost:5273', clientHeader: ORA_CLIENT_HEADER_VALUE }),
    ).toEqual({ ok: false, reason: 'host' });
    expect(ok('GET', { host: undefined })).toEqual({ ok: false, reason: 'host' });
  });

  it('rejects a present-but-foreign Origin even on a GET (fail-closed, not merely un-CORSed)', () => {
    expect(ok('GET', { origin: 'http://evil.com' })).toEqual({ ok: false, reason: 'origin' });
    expect(ok('GET', { origin: 'null' })).toEqual({ ok: false, reason: 'origin' });
  });

  it('accepts a same-machine Origin (the Vite dev-proxy shape)', () => {
    expect(ok('GET', { origin: 'http://localhost:5273' })).toEqual({ ok: true });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects a %s without the client header (simple cross-site write)', (m) => {
    expect(ok(m)).toEqual({ ok: false, reason: 'client-header' });
    expect(ok(m, { clientHeader: '' })).toEqual({ ok: false, reason: 'client-header' });
    expect(ok(m, { clientHeader: '   ' })).toEqual({ ok: false, reason: 'client-header' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('accepts a %s carrying the client header', (m) => {
    expect(ok(m, { clientHeader: ORA_CLIENT_HEADER_VALUE })).toEqual({ ok: true });
    expect(ok(m, { clientHeader: ORA_CLIENT_HEADER_VALUE, origin: 'http://localhost:5273' })).toEqual({ ok: true });
  });

  it('a foreign Origin on a write is rejected on origin even when the header is present', () => {
    expect(ok('POST', { origin: 'https://app.oxfordra.net', clientHeader: ORA_CLIENT_HEADER_VALUE })).toEqual({
      ok: false,
      reason: 'origin',
    });
  });

  it('is method-case-insensitive (a lower-cased "post" is still a write)', () => {
    expect(ok('post')).toEqual({ ok: false, reason: 'client-header' });
  });

  it('does not require the client header on the OPTIONS preflight itself (it carries Access-Control-Request-Headers instead)', () => {
    expect(ok('OPTIONS', { origin: 'http://localhost:5273' })).toEqual({ ok: true });
    // …but a preflight from a foreign page is still refused outright.
    expect(ok('OPTIONS', { origin: 'http://evil.com' })).toEqual({ ok: false, reason: 'origin' });
  });
});

describe('extraAllowedHostsFromEnv', () => {
  it('is empty when BRAIN_ALLOWED_HOSTS is unset or blank', () => {
    expect(extraAllowedHostsFromEnv({})).toEqual([]);
    expect(extraAllowedHostsFromEnv({ BRAIN_ALLOWED_HOSTS: '' })).toEqual([]);
    expect(extraAllowedHostsFromEnv({ BRAIN_ALLOWED_HOSTS: ' , ,' })).toEqual([]);
  });

  it('splits a comma-separated list, trimming and dropping blanks', () => {
    expect(extraAllowedHostsFromEnv({ BRAIN_ALLOWED_HOSTS: 'brain.oxfordra.net, abc.cfargotunnel.com ,,' })).toEqual([
      'brain.oxfordra.net',
      'abc.cfargotunnel.com',
    ]);
  });
});
