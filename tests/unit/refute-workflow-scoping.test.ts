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
import { createHash } from 'node:crypto';
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
  worstSeverityRank: number;
  clean: boolean;
  lensesDefault: boolean;
  lensLabels: string[];
  outOfScope: string[];
  scoped: boolean;
  repo: string;
  changeSetSha256: string | null;
  changeSetLength: number | null;
  greenContextSha256: string | null;
  greenContextLength: number | null;
  effort: string | null;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...a: string[]
) => (...x: unknown[]) => Promise<WorkflowResult>;

interface Call { label: string; prompt: string; opts: Record<string, unknown> }

/**
 * Run the workflow under a stubbed runtime that records every prompt. The default `parallel` stub mirrors the
 * Workflow runtime contract (a thunk that throws resolves to null; the call never rejects). `propagate: true`
 * swaps in a stub that lets a thrown agent reject the whole run, so a test can prove a throw is never swallowed
 * into a clean result under either contract.
 */
async function run(args: unknown, respond: (c: Call) => unknown, opts: { propagate?: boolean } = {}) {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^export\s+/m, '');
  const calls: Call[] = [];
  const agent = async (prompt: string, o: { label?: string } = {}) => {
    const c: Call = { label: o.label ?? '?', prompt, opts: o as Record<string, unknown> };
    calls.push(c);
    return respond(c);
  };
  const parallel = opts.propagate
    ? (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()))
    : (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const fn = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', src);
  const logs: string[] = [];
  const result = await fn(agent, parallel, () => undefined, (m: string) => logs.push(m), args);
  return { calls, result, logs };
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
    }
  });

  it('names the worktree under review, forbids --force, and removes the junction BEFORE a plain git worktree remove', async () => {
    const repo = 'C:\\some\\checkout-under-review';
    const { calls } = await run({ changeSet: 'x', repo }, (c) => clean(lensOf(c.label)));
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      const i = c.prompt.indexOf('CLEAN UP before you finish');
      const block = c.prompt.slice(i, c.prompt.indexOf('CHANGE SET:'));
      // The worktree under review is named explicitly inside the clean-up instruction.
      expect(block).toContain(repo);
      expect(block).toMatch(/NEVER run `git worktree remove` on the worktree under review/);
      // --force is never recommended; it is forbidden by name.
      expect(c.prompt).not.toContain('git worktree remove --force');
      expect(block).toMatch(/NEVER pass --force/);
      // Order: junction / scratch node_modules removed first, then a plain remove that fails safely.
      const rm = block.indexOf('cmd /c rmdir');
      const plain = block.indexOf('then run plain `git worktree remove <your-scratch-path>`');
      expect(rm).toBeGreaterThan(-1);
      expect(plain).toBeGreaterThan(rm);
      expect(block).toMatch(/refuses.*uncommitted.*STOP and report/s);
      // Never reads as permission to delete a node_modules recursively: only a junction/symlink is removed.
      expect(block).not.toMatch(/delete a node_modules/);
      expect(block).toMatch(/remove ONLY a node_modules junction or symlink/);
      expect(block).toMatch(/leave a real node_modules directory alone/);
    }
  });
});

describe('refute-financial-change — custom lenses (what clean may claim)', () => {
  const ALL_DEFAULT = ['correctness', 'determinism', 'edges', 'sweep-completer', 'scope-auditor'];

  it('a default run reports lensesDefault=true and every default label', async () => {
    const { result } = await run('x', (c) => clean(lensOf(c.label)));
    expect(result.lensesDefault).toBe(true);
    expect(result.lensLabels).toEqual(ALL_DEFAULT);
    expect(result.clean).toBe(true);
  });

  it('a single weak custom lens is NOT clean even when it passes (the "confirm it looks fine" bypass)', async () => {
    const { result, logs } = await run({ changeSet: 'x', lenses: [{ label: 'x', focus: 'confirm it looks fine' }] }, (c) =>
      clean(lensOf(c.label)),
    );
    expect(result.lensCount).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.lensesDefault).toBe(false);
    expect(result.lensLabels).toEqual(['x']);
    expect(result.clean).toBe(false);
    expect(logs.join('\n')).not.toContain('Clear to commit');
  });

  it('a custom lens reusing a default LABEL with a weaker focus does not count as that default lens', async () => {
    const { result } = await run({ changeSet: 'x', lenses: ALL_DEFAULT.map((label) => ({ label, focus: 'looks fine' })) }, (c) =>
      clean(lensOf(c.label)),
    );
    expect(result.lensesDefault).toBe(false);
    expect(result.clean).toBe(false);
  });

  it('a custom set that is a SUPERSET of the default lenses can be clean', async () => {
    // Recover the exact default lenses from a default run's prompts (prompt = base + focus).
    const { calls } = await run('x', (c) => clean(lensOf(c.label)));
    const base = calls[0]!.prompt.slice(0, calls[0]!.prompt.indexOf('YOUR LENS: ') + 'YOUR LENS: '.length);
    const defaults = calls.map((c) => ({ label: lensOf(c.label), focus: c.prompt.slice(base.length) }));
    const { result } = await run(
      { changeSet: 'x', lenses: [...defaults, { label: 'extra', focus: 'TAX BASIS — break the depreciation split.' }] },
      (c) => clean(lensOf(c.label)),
    );
    expect(result.lensCount).toBe(6);
    expect(result.lensesDefault).toBe(false);
    expect(result.lensLabels).toEqual([...ALL_DEFAULT, 'extra']);
    expect(result.clean).toBe(true);
  });

  it('a malformed custom lens throws instead of running (no "YOUR LENS: undefined")', async () => {
    const bad: unknown[] = [
      [{ label: 'x' }],
      [{ focus: 'f' }],
      [{ label: '', focus: 'f' }],
      [{ label: 'x', focus: '   ' }],
      [{ label: 1, focus: 'f' }],
      [{ label: 'x', focus: ['f'] }],
      [null],
      ['a string lens'],
      [{ label: 'ok', focus: 'ok' }, {}],
    ];
    for (const lenses of bad) {
      await expect(run({ changeSet: 'x', lenses }, () => null)).rejects.toThrow(/lens/);
    }
  });

  it('a non-array lenses value throws instead of silently falling back to the defaults', async () => {
    for (const lenses of ['correctness', { label: 'x', focus: 'f' }, 3, true]) {
      await expect(run({ changeSet: 'x', lenses }, () => null)).rejects.toThrow(/lenses must be an array/);
    }
  });
});

describe('refute-financial-change — a thrown lens agent is never clean', () => {
  it('runtime contract (thrown thunk -> null): one lens throwing makes the run not clean', async () => {
    const { result, logs } = await run('x', (c) => {
      if (lensOf(c.label) === 'edges') throw new Error('agent crashed');
      return clean(lensOf(c.label));
    });
    expect(result.succeeded).toBe(4);
    expect(result.lensCount).toBe(5);
    expect(result.clean).toBe(false);
    expect(logs.join('\n')).not.toContain('Clear to commit');
  });

  it('propagating parallel: one lens throwing rejects the whole run (no result, so nothing to cite as clean)', async () => {
    await expect(
      run(
        'x',
        (c) => {
          if (lensOf(c.label) === 'edges') throw new Error('agent crashed');
          return clean(lensOf(c.label));
        },
        { propagate: true },
      ),
    ).rejects.toThrow(/agent crashed/);
  });
});

describe('refute-financial-change — foundRealDefect must be exactly false to count as clean', () => {
  for (const [name, value] of [
    ['missing', undefined],
    ['null', null],
    ['0', 0],
    ["'false'", 'false'],
    ["''", ''],
  ] as const) {
    it(`foundRealDefect ${name} is NOT clean`, async () => {
      const { result, logs } = await run('x', (c) => {
        if (lensOf(c.label) !== 'edges') return clean(lensOf(c.label));
        const v: Record<string, unknown> = { lens: 'edges', maxSeverity: 'none', findings: [], summary: 's' };
        if (value !== undefined) v.foundRealDefect = value;
        return v;
      });
      expect(result.anyRealDefect).toBe(true);
      expect(result.clean).toBe(false);
      expect(logs.join('\n')).not.toContain('Clear to commit');
    });
  }

  it('control: boolean false stays clean', async () => {
    const { result } = await run('x', (c) => clean(lensOf(c.label)));
    expect(result.anyRealDefect).toBe(false);
    expect(result.clean).toBe(true);
  });
});

describe('refute-financial-change — what was reviewed is auditable (repo, changeSet, greenContext)', () => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

  it('echoes repo and the sha256 + length of changeSet and greenContext', async () => {
    const changeSet = 'Change set — NOI guard; ünïcödé and an astral 𝄞 char\nline two';
    const greenContext = 'Gate is green on the current corpus.';
    const repo = 'C:\\some\\checkout';
    const { result } = await run({ changeSet, greenContext, repo }, (c) => clean(lensOf(c.label)));
    expect(result.repo).toBe(repo);
    expect(result.changeSetSha256).toBe(sha(changeSet));
    expect(result.changeSetLength).toBe(changeSet.length);
    expect(result.greenContextSha256).toBe(sha(greenContext));
    expect(result.greenContextLength).toBe(greenContext.length);
  });

  it('hashes match node:crypto across edge inputs (empty, long, multi-block, lone surrogate)', async () => {
    for (const changeSet of ['', 'a', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(10_000), 'lone \uD800 surrogate']) {
      const { result } = await run({ changeSet }, (c) => clean(lensOf(c.label)));
      expect(result.changeSetSha256).toBe(sha(changeSet));
    }
  });

  it('a non-string changeSet or greenContext throws (it would otherwise reach the prompt as "[object Object]")', async () => {
    for (const bad of [{ a: 1 }, ['x'], 42, true]) {
      await expect(run({ changeSet: bad }, () => null)).rejects.toThrow(/changeSet must be a string/);
      await expect(run({ changeSet: 'x', greenContext: bad }, () => null)).rejects.toThrow(/greenContext must be a string/);
    }
  });

  it('lengths are UTF-16 code units (JS string length), not bytes or code points, and the header says so', async () => {
    // U+1D11E is 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes; 'é' is 1 unit, 2 bytes.
    const changeSet = 'é𝄞';
    const { result } = await run({ changeSet, greenContext: '𝄞' }, (c) => clean(lensOf(c.label)));
    expect(result.changeSetLength).toBe(3);
    expect(result.greenContextLength).toBe(2);
    const header = readFileSync(SCRIPT, 'utf8').split('\nexport const meta')[0]!;
    expect(header).toMatch(/changeSetLength[^\n]*\n?[^\n]*UTF-16 code units/);
    expect(header).toMatch(/not bytes/);
  });

  it('a plain-string args value is the changeSet', async () => {
    const { result } = await run('plain change set', (c) => clean(lensOf(c.label)));
    expect(result.changeSetSha256).toBe(sha('plain change set'));
    expect(result.changeSetLength).toBe('plain change set'.length);
  });

  it('absent changeSet / greenContext echo null (the built-in defaults are not caller input)', async () => {
    const { result } = await run({}, (c) => clean(lensOf(c.label)));
    expect(result.changeSetSha256).toBeNull();
    expect(result.changeSetLength).toBeNull();
    expect(result.greenContextSha256).toBeNull();
    expect(result.greenContextLength).toBeNull();
    expect(result.repo).toBe('C:\\Users\\Owner\\oxford-command-center');
  });
});

describe('refute-financial-change — non-array findings fail closed', () => {
  it('findings that is not an array ranks as critical and is not clean', async () => {
    for (const findings of [undefined, null, 'none', { severity: 'low' }, 0]) {
      const { result } = await run('x', (c) =>
        lensOf(c.label) === 'edges'
          ? { lens: 'edges', foundRealDefect: false, maxSeverity: 'none', findings, summary: 's' }
          : clean(lensOf(c.label)),
      );
      expect(result.worstSeverityRank).toBe(4);
      expect(result.clean).toBe(false);
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

  it('a non-string element inside an outOfScope array throws instead of becoming "[object Object]"', async () => {
    for (const outOfScope of [[{}], [null], [1], ['ok', ['nested']]]) {
      await expect(run({ changeSet: 'x', outOfScope }, () => null)).rejects.toThrow(/outOfScope array elements/);
    }
  });

  it('echoes the (trimmed, non-empty) items and flags the run as scoped', async () => {
    const { result } = await run({ changeSet: 'x', outOfScope: ['  limit A ', '', 'limit B'] }, (c) => clean(lensOf(c.label)));
    expect(result.outOfScope).toEqual(['limit A', 'limit B']);
    expect(result.scoped).toBe(true);
  });

  it('an unscoped run echoes an empty list and scoped=false', async () => {
    for (const a of ['x', { changeSet: 'x' }, { changeSet: 'x', outOfScope: [] }, { changeSet: 'x', outOfScope: '  ' }]) {
      const { result } = await run(a, (c) => clean(lensOf(c.label)));
      expect(result.outOfScope).toEqual([]);
      expect(result.scoped).toBe(false);
    }
  });

  it('caps the item count at 20', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 'limit ' + i);
    const { result } = await run({ changeSet: 'x', outOfScope: twenty }, (c) => clean(lensOf(c.label)));
    expect(result.outOfScope).toHaveLength(20);
    await expect(run({ changeSet: 'x', outOfScope: [...twenty, 'one more'] }, () => null)).rejects.toThrow(/outOfScope.*20/);
  });

  it('rejects an item containing a newline or carriage return (one item cannot smuggle extra bullets)', async () => {
    for (const item of ['limit A\n- limit B', 'limit A\r- limit B', 'a\r\nb', 'trailing\nnewline-in-middle']) {
      await expect(run({ changeSet: 'x', outOfScope: [item] }, () => null)).rejects.toThrow(/outOfScope.*line break/);
      await expect(run({ changeSet: 'x', outOfScope: item }, () => null)).rejects.toThrow(/outOfScope.*line break/);
    }
    // Surrounding whitespace (incl. a trailing newline) is trimmed first, so it is not a smuggled line.
    const { result } = await run({ changeSet: 'x', outOfScope: ['  limit A\n'] }, (c) => clean(lensOf(c.label)));
    expect(result.outOfScope).toEqual(['limit A']);
  });

  it('rejects every other line/paragraph separator too: \\v, \\f, NEL (U+0085), LS (U+2028), PS (U+2029)', async () => {
    for (const sep of ['\v', '\f', '\u0085', '\u2028', '\u2029']) {
      const item = 'limit A' + sep + '- limit B';
      await expect(run({ changeSet: 'x', outOfScope: [item] }, () => null)).rejects.toThrow(/outOfScope.*line break/);
      await expect(run({ changeSet: 'x', outOfScope: item }, () => null)).rejects.toThrow(/outOfScope.*line break/);
    }
  });

  it('caps each item at 300 characters', async () => {
    const { result } = await run({ changeSet: 'x', outOfScope: ['a'.repeat(300)] }, (c) => clean(lensOf(c.label)));
    expect(result.outOfScope[0]).toHaveLength(300);
    await expect(run({ changeSet: 'x', outOfScope: ['a'.repeat(301)] }, () => null)).rejects.toThrow(/outOfScope.*300/);
    await expect(run({ changeSet: 'x', outOfScope: 'a'.repeat(301) }, () => null)).rejects.toThrow(/outOfScope.*300/);
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

  it('a lens reporting medium-or-higher severity with foundRealDefect=false is NOT clean (severity must agree with the loop rule)', async () => {
    for (const maxSeverity of ['medium', 'high', 'critical']) {
      const { result } = await run('x', (c) =>
        lensOf(c.label) === 'edges' ? { lens: 'edges', foundRealDefect: false, maxSeverity, findings: [], summary: 's' } : clean(lensOf(c.label)),
      );
      expect(result.anyRealDefect).toBe(false);
      expect(result.succeeded).toBe(5);
      expect(result.clean).toBe(false);
    }
  });

  it('a finding of medium-or-higher severity under a lower self-reported maxSeverity is NOT clean (worst spans findings too)', async () => {
    for (const severity of ['medium', 'high', 'critical']) {
      const { result, logs } = await run('x', (c) =>
        lensOf(c.label) === 'edges'
          ? { lens: 'edges', foundRealDefect: false, maxSeverity: 'low', findings: [{ title: 't', severity, detail: 'd' }], summary: 's' }
          : clean(lensOf(c.label)),
      );
      expect(result.worstSeverityRank).toBeGreaterThanOrEqual(2);
      expect(result.clean).toBe(false);
      expect(logs.join('\n')).toContain('NOT clean');
      expect(logs.join('\n')).not.toContain('Clear to commit');
    }
  });

  it('an unknown or missing severity fails closed (ranks as critical), including inherited-key names', async () => {
    for (const maxSeverity of ['HIGH', 'constructor', 'toString', undefined, 7]) {
      const { result } = await run('x', (c) =>
        lensOf(c.label) === 'edges' ? { lens: 'edges', foundRealDefect: false, maxSeverity, findings: [], summary: 's' } : clean(lensOf(c.label)),
      );
      expect(result.worstSeverityRank).toBe(4);
      expect(result.clean).toBe(false);
    }
    const { result } = await run('x', (c) =>
      lensOf(c.label) === 'edges'
        ? { lens: 'edges', foundRealDefect: false, maxSeverity: 'low', findings: [{ title: 't', severity: 'bogus' }], summary: 's' }
        : clean(lensOf(c.label)),
    );
    expect(result.clean).toBe(false);
  });

  it('a clean run still logs "Clear to commit" and a low-only finding stays clean', async () => {
    const { result, logs } = await run('x', (c) =>
      lensOf(c.label) === 'edges'
        ? { lens: 'edges', foundRealDefect: false, maxSeverity: 'low', findings: [{ title: 't', severity: 'low' }], summary: 's' }
        : clean(lensOf(c.label)),
    );
    expect(result.clean).toBe(true);
    expect(logs.join('\n')).toContain('Clear to commit');
  });

  it('a low-severity note with foundRealDefect=false is still clean', async () => {
    const { result } = await run('x', (c) =>
      lensOf(c.label) === 'edges' ? { lens: 'edges', foundRealDefect: false, maxSeverity: 'low', findings: [], summary: 's' } : clean(lensOf(c.label)),
    );
    expect(result.clean).toBe(true);
  });

  it('all lenses failing is not clean', async () => {
    const { result } = await run('x', () => null);
    expect(result.allFailed).toBe(true);
    expect(result.clean).toBe(false);
  });
});

describe('refute-financial-change — effort (optional per-lens reasoning effort)', () => {
  it('with no effort arg no lens call carries an effort option and the result reports null', async () => {
    const { calls, result } = await run({ changeSet: 'x' }, (c) => clean(lensOf(c.label)));
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.opts).not.toHaveProperty('effort');
    expect(result.effort).toBeNull();
  });

  it('passes the effort option to every lens call, including the fallback retry, and reports it', async () => {
    let first = true;
    const { calls, result } = await run({ changeSet: 'x', effort: 'low' }, (c) => {
      if (first) { first = false; return null; } // first lens fails once -> retried on the fallback
      return clean(lensOf(c.label));
    });
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) expect(c.opts.effort).toBe('low');
    expect(result.effort).toBe('low');
  });

  it('accepts every documented level', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const { calls } = await run({ changeSet: 'x', effort }, (c) => clean(lensOf(c.label)));
      for (const c of calls) expect(c.opts.effort).toBe(effort);
    }
  });

  it('an unknown effort value throws instead of being silently dropped', async () => {
    for (const effort of ['LOW', 'ultra', '', 5, null]) {
      let dispatched = 0;
      await expect(run({ changeSet: 'x', effort }, () => { dispatched++; return null; })).rejects.toThrow(/effort must be one of/);
      expect(dispatched).toBe(0); // thrown before any lens was dispatched
    }
  });
});
