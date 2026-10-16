// @vitest-environment node
//
// tests/unit/refute-workflow-scoping.test.ts
//
// Pins the review-hygiene and scoping behavior added to the refute-financial-change workflow:
//  (1) reviewers are told to clean up scratch worktrees and node_modules junctions, and to remove the
//      junction with rmdir and NEVER recursively (a recursive delete follows the link and wipes the real
//      node_modules);
//  (2) an optional `outOfScope` arg injects the documented limits of the mechanism under the change into
//      EVERY lens prompt, between the change set and the lens, so a guard is reviewed GIVEN those limits;
//      with no `outOfScope` the prompt carries no such block;
//  (3) a bad `outOfScope` type throws instead of silently dropping the scoping;
//  (4) the result carries `clean` / `lensCount` so a Refute-Reviewed trailer can only be a bare run id when
//      EVERY lens succeeded and none found a real defect.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), '.claude', 'workflows', 'refute-financial-change.js');

interface WorkflowResult {
  verdicts: unknown[];
  anyRealDefect: boolean;
  succeeded: number;
  allFailed: boolean;
  lensCount: number;
  clean: boolean;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...a: string[]
) => (...x: unknown[]) => Promise<WorkflowResult>;

interface Call { label: string; prompt: string }

/** Run the workflow under a stubbed runtime that records every prompt. */
async function run(args: unknown, respond: (c: Call) => unknown) {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^export\s+/m, '');
  const calls: Call[] = [];
  const agent = async (prompt: string, o: { label?: string } = {}) => {
    const c = { label: o.label ?? '?', prompt };
    calls.push(c);
    return respond(c);
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const fn = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', src);
  const result = await fn(agent, parallel, () => undefined, () => undefined, args);
  return { calls, result };
}

const lensOf = (label: string) => label.replace(/^refute:/, '').replace(/:opus-fallback$/, '');
const clean = (lens: string) => ({ lens, foundRealDefect: false, maxSeverity: 'none', findings: [], summary: 's' });
const defect = (lens: string) => ({ lens, foundRealDefect: true, maxSeverity: 'medium', findings: [], summary: 's' });

describe('refute-financial-change — reviewer hygiene', () => {
  it('every lens prompt tells the reviewer to rmdir (never recursively delete) a node_modules junction and remove its scratch worktree', async () => {
    const { calls } = await run('a change set', (c) => clean(lensOf(c.label)));
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.prompt).toContain('CLEAN UP before you finish');
      expect(c.prompt).toContain('cmd /c rmdir');
      expect(c.prompt).toMatch(/NEVER rm -rf or any recursive delete through it/);
      expect(c.prompt).toContain('git worktree remove --force');
    }
  });
});

describe('refute-financial-change — outOfScope (scoping a guard review)', () => {
  it('with no outOfScope the prompt carries no known-limits block', async () => {
    const { calls } = await run({ changeSet: 'x' }, (c) => clean(lensOf(c.label)));
    for (const c of calls) expect(c.prompt).not.toContain('KNOWN LIMITS OF THE UNDERLYING MECHANISM');
  });

  it('injects every item into EVERY lens prompt, after the change set and before the lens', async () => {
    const { calls } = await run(
      { changeSet: 'CHANGE-SET-MARKER', outOfScope: ['detector flips on noise', '  restale moves rows in place  ', ''] },
      (c) => clean(lensOf(c.label)),
    );
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.prompt).toContain('KNOWN LIMITS OF THE UNDERLYING MECHANISM');
      expect(c.prompt).toContain('- detector flips on noise');
      expect(c.prompt).toContain('- restale moves rows in place'); // trimmed
      expect(c.prompt).not.toMatch(/- \s*\n/); // the empty item was dropped
      const i = c.prompt.indexOf('CHANGE-SET-MARKER');
      const j = c.prompt.indexOf('KNOWN LIMITS OF THE UNDERLYING MECHANISM');
      const k = c.prompt.indexOf('YOUR LENS:');
      expect(i).toBeGreaterThan(-1);
      expect(j).toBeGreaterThan(i);
      expect(k).toBeGreaterThan(j);
    }
  });

  it('accepts a single string', async () => {
    const { calls } = await run({ changeSet: 'x', outOfScope: 'one known limit' }, (c) => clean(lensOf(c.label)));
    for (const c of calls) expect(c.prompt).toContain('- one known limit');
  });

  it('an empty list or empty string adds no block', async () => {
    for (const outOfScope of [[], '', '   ', null]) {
      const { calls } = await run({ changeSet: 'x', outOfScope }, (c) => clean(lensOf(c.label)));
      for (const c of calls) expect(c.prompt).not.toContain('KNOWN LIMITS OF THE UNDERLYING MECHANISM');
    }
  });

  it('a non-string, non-array outOfScope throws instead of silently dropping the scoping', async () => {
    for (const outOfScope of [42, { a: 1 }, true]) {
      await expect(run({ changeSet: 'x', outOfScope }, () => null)).rejects.toThrow(/outOfScope/);
    }
  });
});

describe('refute-financial-change — clean / lensCount (what a bare Refute-Reviewed id may claim)', () => {
  it('clean is true only when every lens succeeded and none found a real defect', async () => {
    const { result } = await run('x', (c) => clean(lensOf(c.label)));
    expect(result.lensCount).toBe(5);
    expect(result.succeeded).toBe(5);
    expect(result.anyRealDefect).toBe(false);
    expect(result.clean).toBe(true);
  });

  it('a real defect in any lens makes the run not clean', async () => {
    const { result } = await run('x', (c) => (lensOf(c.label) === 'edges' ? defect('edges') : clean(lensOf(c.label))));
    expect(result.anyRealDefect).toBe(true);
    expect(result.clean).toBe(false);
  });

  it('a lens that failed (even after its retry) with no defects elsewhere is NOT clean — partial coverage is not a pass', async () => {
    const { result } = await run('x', (c) => (lensOf(c.label) === 'determinism' ? null : clean(lensOf(c.label))));
    expect(result.succeeded).toBe(4);
    expect(result.lensCount).toBe(5);
    expect(result.anyRealDefect).toBe(false);
    expect(result.clean).toBe(false);
  });

  it('all lenses failing is not clean', async () => {
    const { result } = await run('x', () => null);
    expect(result.allFailed).toBe(true);
    expect(result.clean).toBe(false);
  });
});
