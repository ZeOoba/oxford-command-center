// Direct unit coverage for server/briefing/confidential.ts — previously only exercised indirectly
// through briefing.test.ts. Covers the 2026-07-06 audit fix: this is a confidentiality gate, so it
// must fail CLOSED (throw) when confidential-terms.json is absent/unreadable/empty, and the ONLY way
// to get reduced (placeholder-only) coverage is the explicit CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1
// opt-out -- never an automatic, silent fallback.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForConfidential, assertNoConfidential, collectText } from '../../server/briefing/confidential';

let priorTermsPath: string | undefined;
let priorAllowPlaceholder: string | undefined;
let tmpDir: string | undefined;

beforeEach(() => {
  priorTermsPath = process.env.CONFIDENTIAL_TERMS_PATH;
  priorAllowPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
});

afterEach(() => {
  if (priorTermsPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = priorTermsPath;
  if (priorAllowPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = priorAllowPlaceholder;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('loadTerms (via scanForConfidential) — fails closed on a missing/unreadable file', () => {
  it('throws when CONFIDENTIAL_TERMS_PATH points at a nonexistent file and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('throws when the file exists but is unparseable JSON, and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(file, '{ not valid json ', 'utf8');
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('throws when the file parses but has no non-underscore keys, and no opt-out is set', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(file, JSON.stringify({ _comment: 'empty on purpose' }), 'utf8');
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(() => scanForConfidential('anything')).toThrow(/confidential-terms\.json is absent/);
  });

  it('falls back to placeholder-only scanning WITHOUT throwing when the opt-out is explicitly set', () => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => scanForConfidential('ordinary text with no confidential markers')).not.toThrow();
    // The placeholder term is the only thing it can catch in this mode.
    expect(scanForConfidential('__ora_confidential_placeholder__')?.dealLabel).toBe('Confidential Deal');
  });

  it('the opt-out does not mask a hit when placeholder-only text is present', () => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    process.env.CONFIDENTIAL_TERMS_PATH = join(tmpdir(), 'zzz-does-not-exist-confidential-terms.json');
    expect(() => assertNoConfidential('contains __ora_confidential_placeholder__ here')).toThrow(
      /refusing to render/,
    );
  });
});

describe('scanForConfidential — matching semantics against a real terms file', () => {
  it('matches an "always" term case-insensitively as a substring', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-x': { label: 'Deal X', active: true, always: ['ZzzUniqueTrigger123'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('some text mentioning zzzuniquetrigger123 in passing')?.dealLabel).toBe('Deal X');
  });

  it('does not match a context term unless its context_requires_any anchor is also present', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-y': {
          label: 'Deal Y',
          active: true,
          always: [],
          context: ['zzz-context-term'],
          context_requires_any: ['zzz-anchor-term'],
        },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('zzz-context-term appears alone')).toBeNull();
    expect(scanForConfidential('zzz-anchor-term and zzz-context-term appear together')?.dealLabel).toBe('Deal Y');
  });

  it('skips inactive deals', () => {
    delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
    tmpDir = mkdtempSync(join(tmpdir(), 'confidential-test-'));
    const file = join(tmpDir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({
        'deal-z': { label: 'Deal Z', active: false, always: ['zzz-inactive-term'], context: [], context_requires_any: [] },
      }),
      'utf8',
    );
    process.env.CONFIDENTIAL_TERMS_PATH = file;
    expect(scanForConfidential('zzz-inactive-term present')).toBeNull();
  });
});

describe('collectText — flattens nested structures for scanning', () => {
  it('flattens arrays and objects into a single space-joined string', () => {
    expect(collectText({ a: ['x', 'y'], b: { c: 'z' } })).toBe('x y z');
  });
  it('returns empty string for null/undefined', () => {
    expect(collectText(null)).toBe('');
    expect(collectText(undefined)).toBe('');
  });
});
