// @vitest-environment node
// Tier 4 (2026-11-23): model IDs live in one module, defaults are the current 5.5 models, and the
// env overrides still win.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_MODEL, FAST_CALL_FIELDS, FAST_MODEL, assistantModel, omExtractModel } from '../../server/ai/models';

afterEach(() => vi.unstubAllEnvs());

describe('server/ai/models', () => {
  it('defaults to the current Opus and Haiku', () => {
    expect(ASSISTANT_MODEL).toBe('claude-opus-5-5');
    expect(FAST_MODEL).toBe('claude-haiku-5-5');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    vi.stubEnv('OM_EXTRACT_MODEL', '');
    expect(assistantModel()).toBe('claude-opus-5-5');
    expect(omExtractModel()).toBe('claude-haiku-5-5');
  });

  it('env overrides win', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-sonnet-5-5');
    vi.stubEnv('OM_EXTRACT_MODEL', 'claude-haiku-4-5');
    expect(assistantModel()).toBe('claude-sonnet-5-5');
    expect(omExtractModel()).toBe('claude-haiku-4-5');
  });

  it('fast calls turn thinking off and carry no temperature', () => {
    expect(FAST_CALL_FIELDS).toEqual({ thinking: { type: 'disabled' } });
    expect('temperature' in FAST_CALL_FIELDS).toBe(false);
  });

  it('no server source hard-codes a Claude model id outside this module', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : [];
      });
    const offenders = walk('server')
      .filter((f) => !f.endsWith(join('ai', 'models.ts')))
      .filter((f) => /['"]claude-(opus|sonnet|haiku|fable)-[0-9]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
