import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Hard Invariant 3 structural guard. Brain serves its snapshot via `this.snapshot`; before this guard
// each assignment site had to remember applyRosterOverride by hand (five sites, three separate misses
// found by adversarial review: cold fallback, warm fallback, rederive). The invariant is now structural:
// `this.snapshot` is assigned in exactly ONE place — adoptSnapshot() — and that method roster-checks.
// A new write path that assigns `this.snapshot` directly fails here instead of silently serving a deal
// the roster claims as confidential:false.
const SRC = readFileSync(join(process.cwd(), 'server', 'brain.ts'), 'utf8');

/** Source with comments blanked (length-preserving) so prose mentioning `this.snapshot =` can't count. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Body of `private adoptSnapshot(...) { ... }` by brace matching, or null. */
function methodBody(code: string, name: string): { start: number; end: number; text: string } | null {
  const m = new RegExp(String.raw`\b${name}\s*\([^)]*\)[^{;]*\{`).exec(code);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return { start, end: i, text: code.slice(start, i) };
}

describe('Brain snapshot choke point (Hard Invariant 3)', () => {
  const code = stripComments(SRC);
  const assignments = [...code.matchAll(/this\.snapshot\s*=(?!=)/g)].map((m) => m.index!);

  it('defines adoptSnapshot()', () => {
    expect(methodBody(code, 'adoptSnapshot')).not.toBeNull();
  });

  it('assigns this.snapshot in exactly one place, inside adoptSnapshot()', () => {
    const body = methodBody(code, 'adoptSnapshot')!;
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toBeGreaterThanOrEqual(body.start);
    expect(assignments[0]).toBeLessThan(body.end);
  });

  it('adoptSnapshot() roster-checks the deals it adopts', () => {
    expect(methodBody(code, 'adoptSnapshot')!.text).toMatch(/rosterChecked\(|applyRosterOverride\(/);
  });

  it('never spreads or mutates the snapshot object around the choke point (no `.snapshot.deals =`)', () => {
    expect(code).not.toMatch(/\.snapshot\.deals\s*=(?!=)/);
  });
});
