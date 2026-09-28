// @vitest-environment node
//
// tests/unit/refute-workflow-sqlite-ban.test.ts
//
// CLAUDE.md §9 forbids opening data/warehouse/finance.sqlite (live warehouse). Refute reviewers are
// subagents that read the repo freely, and refute wf_d23d3a9d-381 showed two of them scanning the live
// DB read-only because the workflow's base prompt never told them not to. No hook enforces this, so
// the prompt is the only guard at this layer: pin that it stays in the UNCONDITIONAL `base` string
// (every lens, every run), not in a per-call argument a caller could omit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(process.cwd(), '.claude', 'workflows', 'refute-financial-change.js'), 'utf8');

/** The `const base = ...` statement: from its declaration to the next top-level statement. */
function baseStatement(): string {
  const start = SRC.indexOf('const base =');
  const end = SRC.indexOf('\nconst verdicts', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base prompt statement');
  return SRC.slice(start, end);
}

describe('refute-financial-change — live-warehouse ban in the base prompt', () => {
  it('forbids opening, querying or reading any sqlite file under data/', () => {
    const base = baseStatement();
    expect(base).toMatch(/NEVER open, query,? or read/i);
    expect(base).toContain('data/**/*.sqlite');
    expect(base).toContain('finance.sqlite');
  });

  it('points reviewers at in-memory test databases instead', () => {
    expect(baseStatement()).toMatch(/in-memory/i);
  });

  it('is unconditional: not built from a caller argument (A.*) or greenContext', () => {
    const base = baseStatement();
    const banIdx = base.indexOf('data/**/*.sqlite');
    // The ban text is a string literal in the base expression; the interpolated arguments come after it.
    expect(banIdx).toBeGreaterThan(-1);
    const literalPrefix = base.slice(0, banIdx);
    expect(literalPrefix).not.toMatch(/\b(A\.|changeSet|greenContext|lenses)\b/);
  });
});
