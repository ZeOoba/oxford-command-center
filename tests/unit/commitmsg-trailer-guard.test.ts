import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ALLOWED_AI_TRAILERS,
  findAiCoAuthorLines,
  validateAiTrailers,
} from '../../scripts/commitmsg-trailer-guard.mjs';

// Pure-function coverage for the matching/allowlist logic (extracted so the dependency-free CLI
// entrypoint stays testable without spawning a subprocess for every case).

describe('findAiCoAuthorLines', () => {
  it('matches a Co-Authored-By line naming Claude', () => {
    const msg = 'fix: thing\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n';
    expect(findAiCoAuthorLines(msg)).toEqual(['Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>']);
  });

  it('matches case-insensitively on both the trailer key and "claude"/"anthropic"', () => {
    const msg = 'Co-authored-by: claude sonnet 5 <noreply@anthropic.com>';
    expect(findAiCoAuthorLines(msg)).toEqual(['Co-authored-by: claude sonnet 5 <noreply@anthropic.com>']);
  });

  it('matches on "anthropic" even without the word "claude"', () => {
    const msg = 'Co-Authored-By: Some Anthropic Model <noreply@anthropic.com>';
    expect(findAiCoAuthorLines(msg)).toEqual(['Co-Authored-By: Some Anthropic Model <noreply@anthropic.com>']);
  });

  it('ignores a human co-author trailer', () => {
    const msg = 'chore: x\n\nCo-authored-by: Test <test@test.com>';
    expect(findAiCoAuthorLines(msg)).toEqual([]);
  });

  it('ignores an unrelated trailer line', () => {
    const msg = 'chore: x\n\nRefute-Reviewed: adversarial pass by a Claude Fable 5.1 subagent, all green.';
    expect(findAiCoAuthorLines(msg)).toEqual([]);
  });

  it('returns empty for a message with no trailers at all', () => {
    expect(findAiCoAuthorLines('just a subject line')).toEqual([]);
  });

  it('finds multiple AI co-author lines', () => {
    const msg = [
      'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
      'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
    ].join('\n');
    expect(findAiCoAuthorLines(msg)).toHaveLength(2);
  });
});

describe('ALLOWED_AI_TRAILERS', () => {
  it('contains the canonical trailer verified against this repo\'s real commit history', () => {
    expect(ALLOWED_AI_TRAILERS).toContain('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  });

  it('contains the Fable trailer also verified in this repo\'s real commit history', () => {
    expect(ALLOWED_AI_TRAILERS).toContain('Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>');
  });
});

describe('validateAiTrailers', () => {
  it('passes silently when no AI co-author trailer is present', () => {
    const result = validateAiTrailers('chore: unrelated commit\n\nCo-authored-by: Test <test@test.com>\n');
    expect(result.ok).toBe(true);
    expect(result.offending).toEqual([]);
  });

  it('passes when the AI trailer exactly matches the allowlist', () => {
    const result = validateAiTrailers(
      'fix: thing\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n',
    );
    expect(result.ok).toBe(true);
  });

  it('blocks a malformed/incorrect AI trailer (the exact regression this guard exists for)', () => {
    const result = validateAiTrailers(
      'fix: thing\n\nCo-Authored-By: Claude 5 Sonnet <noreply@anthropic.com>\n',
    );
    expect(result.ok).toBe(false);
    expect(result.offending).toEqual(['Co-Authored-By: Claude 5 Sonnet <noreply@anthropic.com>']);
  });

  it('blocks a trailer with the wrong email domain', () => {
    const result = validateAiTrailers(
      'fix: thing\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.example.com>\n',
    );
    expect(result.ok).toBe(false);
  });

  it('is exact-match (whitespace-sensitive) against the allowlist', () => {
    const result = validateAiTrailers(
      'fix: thing\n\nCo-Authored-By:  Claude Sonnet 5 <noreply@anthropic.com>\n', // double space
    );
    expect(result.ok).toBe(false);
  });
});

describe('commitmsg-trailer-guard CLI', () => {
  const scriptPath = join(process.cwd(), 'scripts', 'commitmsg-trailer-guard.mjs');
  let dir: string;

  function runCli(message: string): { status: number; stderr: string } {
    dir = mkdtempSync(join(tmpdir(), 'commitmsg-trailer-guard-test-'));
    const msgFile = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(msgFile, message, 'utf8');
    try {
      execFileSync(process.execPath, [scriptPath, msgFile], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number | null; stderr?: string };
      return { status: err.status ?? 1, stderr: String(err.stderr ?? '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 for a commit message with no AI trailer', () => {
    expect(runCli('chore: unrelated\n').status).toBe(0);
  });

  it('exits 0 for a commit message with the correct AI trailer', () => {
    expect(runCli('fix: thing\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n').status).toBe(0);
  });

  it('exits non-zero and prints the offending + expected lines for a wrong AI trailer', () => {
    const result = runCli('fix: thing\n\nCo-Authored-By: Claude 5 Sonnet <noreply@anthropic.com>\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Co-Authored-By: Claude 5 Sonnet <noreply@anthropic.com>');
    expect(result.stderr).toContain('Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  });
});
