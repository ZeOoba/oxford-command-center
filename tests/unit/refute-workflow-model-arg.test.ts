// @vitest-environment node
//
// tests/unit/refute-workflow-model-arg.test.ts
//
// The refute-financial-change workflow hardcoded model: 'fable' with an opus fallback. When Fable is
// unavailable (monthly spend cap) the only way to run it on opus was a FORKED script copy
// ("refute-financial-change-opus": 5 runs, 47 lines of drift, two script versions in circulation).
// The model is now an argument instead, so there is one script. These tests pin: (1) the default
// behavior every historical run relied on is unchanged, (2) the override is validated and cannot
// silently drop below the opus fallback tier, (3) the result records which model actually ran so a
// `Refute-Reviewed:` attestation is auditable, (4) the base-prompt block keeps a `const base =` ...
// `\nconst verdicts` shape, so tests that slice the prompt statement out of the script keep working.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), '.claude', 'workflows', 'refute-financial-change.js');

interface WorkflowResult {
  verdicts: unknown[];
  anyRealDefect: boolean;
  worstSeverityRank: number;
  succeeded: number;
  allFailed: boolean;
  models: { primary: string; fallback: string | null };
  modelFloorMet: boolean;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...a: string[]
) => (...x: unknown[]) => Promise<WorkflowResult>;

interface Call { label: string; model: string | null }

/** Run the workflow under a stubbed Workflow runtime; `respond` decides each agent() return value. */
async function run(args: unknown, respond: (c: Call) => unknown) {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^export\s+/m, '');
  const calls: Call[] = [];
  const logs: string[] = [];
  const agent = async (_p: string, o: { label?: string; model?: string } = {}) => {
    const c = { label: o.label ?? '?', model: o.model ?? null };
    calls.push(c);
    return respond(c);
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const fn = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', src);
  const result = await fn(agent, parallel, () => undefined, (m: string) => logs.push(m), args);
  return { calls, logs, result };
}

const clean = (lens: string) => ({ lens, foundRealDefect: false, maxSeverity: 'none', findings: [], summary: 's' });
const lensOf = (label: string) => label.replace(/^refute:/, '').replace(/:opus-fallback$/, '');

describe('refute-financial-change — model argument', () => {
  it('defaults to opus (Opus 5.5 floor) for every lens with no fallback configured', async () => {
    const { calls, result } = await run('a change set', (c) => clean(lensOf(c.label)));
    expect(calls.length).toBe(5);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(['opus']));
    expect(result.succeeded).toBe(5);
    expect(result.allFailed).toBe(false);
    expect(result.models).toEqual({ primary: 'opus', fallback: null });
    expect(result.modelFloorMet).toBe(true);
  });

  it('keeps the per-lens opus fallback when an explicit model:fable call returns null', async () => {
    const { calls, result } = await run({ changeSet: 'x', model: 'fable' }, (c) =>
      c.label === 'refute:edges' ? null : clean(lensOf(c.label)),
    );
    const fb = calls.filter((c) => c.label === 'refute:edges:opus-fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0]?.model).toBe('opus');
    expect(result.succeeded).toBe(5);
  });

  it('model: opus runs every lens on opus, makes no redundant same-model retry, and reports the floor as met', async () => {
    const { calls, result } = await run({ changeSet: 'x', model: 'opus' }, (c) =>
      c.label === 'refute:determinism' ? null : clean(lensOf(c.label)),
    );
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(['opus']));
    expect(calls.some((c) => c.label.endsWith(':opus-fallback'))).toBe(false); // would retry opus with opus
    expect(calls).toHaveLength(5);
    expect(result.succeeded).toBe(4); // the failed lens is dropped, not silently counted clean
    expect(result.models).toEqual({ primary: 'opus', fallback: null });
    expect(result.modelFloorMet).toBe(true);
  });

  it('all lenses failing is still a tooling failure, never clean, under an override', async () => {
    const { result, logs } = await run({ changeSet: 'x', model: 'opus' }, () => null);
    expect(result.allFailed).toBe(true);
    expect(result.anyRealDefect).toBe(false);
    expect(logs.join('\n')).toMatch(/TOOLING FAILURE/);
  });

  it('rejects any model below the opus tier instead of silently accepting it', async () => {
    for (const model of ['sonnet', 'haiku', 'gpt-5', '']) {
      await expect(run({ changeSet: 'x', model }, () => null)).rejects.toThrow(/model/i);
    }
    await expect(run({ changeSet: 'x', fallbackModel: 'sonnet' }, () => null)).rejects.toThrow(/fallbackModel/);
  });
});

describe('refute-financial-change — shape other code relies on', () => {
  it('still has `const base =` followed (after the prompt statement) by `\\nconst verdicts`', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const start = src.indexOf('const base =');
    const end = src.indexOf('\nconst verdicts', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('keeps the result keys the weekly sweep task consumes', async () => {
    const { result } = await run('x', (c) => clean(lensOf(c.label)));
    for (const k of ['verdicts', 'anyRealDefect', 'worstSeverityRank', 'succeeded', 'allFailed']) {
      expect(result).toHaveProperty(k);
    }
  });
});
