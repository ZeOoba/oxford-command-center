import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const GUARD = path.join(process.cwd(), '.claude', 'hooks', 'bash-guard.mjs');

function runGuard(command: string, cwd: string): { denied: boolean; reason?: string } {
  const payload = JSON.stringify({ tool_input: { command } });
  const out = execFileSync('node', [GUARD], { input: payload, cwd, encoding: 'utf8' });
  if (!out) return { denied: false };
  const parsed = JSON.parse(out);
  const decision = parsed?.hookSpecificOutput?.permissionDecision;
  return {
    denied: decision === 'deny',
    reason: parsed?.hookSpecificOutput?.permissionDecisionReason,
  };
}

describe('bash-guard.mjs — original 7 blocked classes (regression, post-indirection-fix refactor)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'bash-guard-regress-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('(a) denies git add -A / --all / bare .', () => {
    expect(runGuard('git add -A', repo).denied).toBe(true);
    expect(runGuard('git add --all', repo).denied).toBe(true);
    expect(runGuard('git add .', repo).denied).toBe(true);
  });

  it('(a) allows git add with explicit paths', () => {
    expect(runGuard('git add file1.txt file2.txt', repo).denied).toBe(false);
  });

  it('(b) denies git commit --no-verify / -n', () => {
    expect(runGuard('git commit --no-verify -m "x"', repo).denied).toBe(true);
    expect(runGuard('git commit -n -m "x"', repo).denied).toBe(true);
  });

  it('(b) does not false-positive on a commit message containing -n', () => {
    expect(runGuard('git commit -m "fixes issue -n 5"', repo).denied).toBe(false);
  });

  it('(c) denies git push --force/-f and --no-verify, allows --force-with-lease', () => {
    expect(runGuard('git push --force origin main', repo).denied).toBe(true);
    expect(runGuard('git push -f origin main', repo).denied).toBe(true);
    expect(runGuard('git push --no-verify origin main', repo).denied).toBe(true);
    expect(runGuard('git push --force-with-lease origin main', repo).denied).toBe(false);
  });

  it('(d) denies core.hooksPath tampering', () => {
    expect(runGuard('git config core.hooksPath /tmp/evil', repo).denied).toBe(true);
  });

  it('(d) allows reading core.hooksPath (OI-011)', () => {
    expect(runGuard('git config --get core.hooksPath', repo).denied).toBe(false);
    expect(runGuard('git config --get-all core.hooksPath', repo).denied).toBe(false);
    expect(runGuard('git config core.hooksPath', repo).denied).toBe(false);
  });

  it('(d) still denies core.hooksPath mutation forms beyond the plain set (OI-011 regression guard)', () => {
    expect(runGuard('git config --unset core.hooksPath', repo).denied).toBe(true);
    expect(runGuard('git -c core.hooksPath=/tmp/evil status', repo).denied).toBe(true);
    expect(runGuard('git config --global core.hooksPath /tmp/evil', repo).denied).toBe(true);
  });

  it('(d) denies a dash-prefixed core.hooksPath value (adversarial-review find, no -- separator needed)', () => {
    // Confirmed real bypass during OI-011 adversarial review: `git config core.hooksPath
    // -evilhooks` is a fully valid git SET (no `--` needed) - filtering dash-prefixed
    // tokens out before searching for a value made it invisible and let this through as
    // a misclassified "bare read".
    expect(runGuard('git config core.hooksPath -evilhooks', repo).denied).toBe(true);
  });

  it('(d) allows --get with a trailing value-pattern argument (real git: a filter, not a set)', () => {
    expect(runGuard('git config --get core.hooksPath /tmp/pattern', repo).denied).toBe(false);
  });

  it('(e) denies sqlite3 DDL/DML against the live warehouse', () => {
    expect(
      runGuard('sqlite3 data/warehouse/finance.sqlite "DELETE FROM users"', repo).denied,
    ).toBe(true);
  });

  it('(e) allows sqlite3 reads against the warehouse', () => {
    expect(
      runGuard('sqlite3 data/warehouse/finance.sqlite "SELECT * FROM users"', repo).denied,
    ).toBe(false);
  });

  it('(f) denies rm/unlink of data/warehouse or overlay.json', () => {
    expect(runGuard('rm -rf data/warehouse', repo).denied).toBe(true);
    expect(runGuard('unlink data/overlay.json', repo).denied).toBe(true);
  });

  it('(g) denies writes into .claude/settings*.json or .claude/hooks/', () => {
    expect(runGuard('echo evil >> .claude/hooks/evil.mjs', repo).denied).toBe(true);
    expect(runGuard('echo evil > .claude/settings.json', repo).denied).toBe(true);
  });

  it('(g) allows reads of guardrail files', () => {
    expect(runGuard('cat .claude/settings.json', repo).denied).toBe(false);
  });

  it('(g) allows cp FROM a guardrail file (backup/read), denies cp INTO one (OI-011)', () => {
    expect(runGuard('cp .claude/settings.json /tmp/backup.json', repo).denied).toBe(false);
    expect(runGuard('cp /tmp/evil.json .claude/settings.json', repo).denied).toBe(true);
  });

  it('(g) still denies mv of a guardrail file in either argument position (OI-011 regression guard)', () => {
    // mv, unlike cp, removes the file from its source location - source-position mv is
    // effectively a deletion/neutralization of the guard file, same severity as rm, so it
    // must stay denied even though cp-as-source is now allowed.
    expect(runGuard('mv .claude/hooks/bash-guard.mjs /tmp/gone.mjs', repo).denied).toBe(true);
    expect(runGuard('mv /tmp/evil.json .claude/settings.json', repo).denied).toBe(true);
  });

  it('(g) denies cp into a guardrail directory via -t/--target-directory (OI-011 regression guard)', () => {
    expect(runGuard('cp -t .claude/hooks/ /tmp/evil.mjs', repo).denied).toBe(true);
    expect(runGuard('cp --target-directory=.claude/hooks/ /tmp/evil.mjs', repo).denied).toBe(true);
  });

  it('(g) denies cp into a guardrail directory via the --target-dir abbreviation (adversarial-review find)', () => {
    // Confirmed real bypass during OI-011 adversarial review: GNU cp accepts unambiguous
    // prefix abbreviations of long options, so `--target-dir=` (and shorter prefixes)
    // work identically to `--target-directory=` but weren't matched by the literal-only
    // regex, letting a write straight into .claude/hooks/ through undetected.
    expect(runGuard('cp --target-dir=.claude/hooks/ evil.mjs', repo).denied).toBe(true);
    expect(runGuard('cp --target-d=.claude/hooks/ evil.mjs', repo).denied).toBe(true);
  });

  it('(g) denies cp into a guardrail directory via space-separated --target-directory (adversarial-review round 2 find)', () => {
    // Confirmed real bypass during OI-011 round-2 adversarial review: GNU cp accepts a
    // long option's argument either `=`-attached OR as the next token entirely - only
    // the `=`-attached form was matched, so `cp --target-directory .claude/hooks/
    // evil.mjs` (space-separated, real GNU cp behavior, verified empirically) slipped
    // through with the destination argument mis-picked as `evil.mjs` instead.
    expect(runGuard('cp --target-directory .claude/hooks/ evil.mjs', repo).denied).toBe(true);
    expect(runGuard('cp --target-dir .claude/hooks/ evil.mjs', repo).denied).toBe(true);
  });

  it('still catches git add -A hidden in sh -c / $() / backticks', () => {
    expect(runGuard('sh -c "git add -A"', repo).denied).toBe(true);
    expect(runGuard('echo $(git add -A)', repo).denied).toBe(true);
    expect(runGuard('echo `git add -A`', repo).denied).toBe(true);
  });

  it('fails open on malformed/empty input', () => {
    const out = execFileSync('node', [GUARD], { input: 'not json', cwd: repo, encoding: 'utf8' });
    expect(out).toBe('');
    const out2 = execFileSync('node', [GUARD], {
      input: JSON.stringify({ tool_input: { command: '' } }),
      cwd: repo,
      encoding: 'utf8',
    });
    expect(out2).toBe('');
  });
});

describe('bash-guard.mjs — OI-010: git-alias indirection now resolved and blocked', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'bash-guard-alias-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('denies defining an alias whose value is git add -A (widened detection, not narrowed)', () => {
    expect(runGuard('git config alias.qa "add -A"', repo).denied).toBe(true);
  });

  it('denies invoking a pre-existing alias that resolves to git add -A', () => {
    execFileSync('git', ['config', 'alias.qa2', 'add -A'], { cwd: repo });
    expect(runGuard('git qa2', repo).denied).toBe(true);
  });

  it('denies a pre-existing alias invoked past a preceding git GLOBAL OPTION (adversarial-review find)', () => {
    // Confirmed real bypass: `-c`/`-C`/`--git-dir=`/`-p`/`--no-pager` etc. before the alias
    // name made the original tokens[i+1] check bail out entirely, since ANY leading dash
    // token was treated as "not a candidate" rather than "skip past this option".
    execFileSync('git', ['config', 'alias.qa4', 'add -A'], { cwd: repo });
    expect(runGuard('git -c foo.bar=baz qa4', repo).denied).toBe(true);
    expect(runGuard('git -C . qa4', repo).denied).toBe(true);
    expect(runGuard('git --git-dir=.git --work-tree=. qa4', repo).denied).toBe(true);
    expect(runGuard('git -p qa4', repo).denied).toBe(true);
    expect(runGuard('git --no-pager qa4', repo).denied).toBe(true);
    expect(runGuard('git -c a.b=c -C . qa4', repo).denied).toBe(true);
  });

  it('denies push --force / core.hooksPath aliases invoked past a preceding global option', () => {
    execFileSync('git', ['config', 'alias.pf4', 'push --force'], { cwd: repo });
    execFileSync('git', ['config', 'alias.hp4', 'config core.hooksPath /tmp/evil'], { cwd: repo });
    expect(runGuard('git -c x.y=z pf4 origin main', repo).denied).toBe(true);
    expect(runGuard('git -c a.b=c hp4', repo).denied).toBe(true);
  });

  it('proves the global-option-prefixed alias invocation genuinely performs the blocked action', () => {
    writeFileSync(path.join(repo, 'untracked-globalopt-e2e.txt'), 'hi');
    execFileSync('git', ['config', 'alias.qa5', 'add -A'], { cwd: repo });
    execFileSync('git', ['-c', 'foo.bar=baz', 'qa5'], { cwd: repo });
    const status = execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('A  untracked-globalopt-e2e.txt');
  });

  it('denies invoking a pre-existing alias that resolves to git commit --no-verify', () => {
    execFileSync('git', ['config', 'alias.qc', 'commit --no-verify -m'], { cwd: repo });
    expect(runGuard('git qc "msg"', repo).denied).toBe(true);
  });

  it('denies invoking a pre-existing alias that resolves to git push --force', () => {
    execFileSync('git', ['config', 'alias.qp', 'push --force'], { cwd: repo });
    expect(runGuard('git qp origin main', repo).denied).toBe(true);
  });

  it('denies a bang-alias whose raw shell command tampers with core.hooksPath', () => {
    execFileSync('git', ['config', 'alias.qh', '!git config core.hooksPath /tmp/evil'], {
      cwd: repo,
    });
    expect(runGuard('git qh', repo).denied).toBe(true);
  });

  it('resolves chained aliases (alias A invokes alias B which is dangerous)', () => {
    execFileSync('git', ['config', 'alias.inner', 'add -A'], { cwd: repo });
    execFileSync('git', ['config', 'alias.outer', '!git inner'], { cwd: repo });
    expect(runGuard('git outer', repo).denied).toBe(true);
  });

  it('does NOT flag a benign, unrelated alias', () => {
    execFileSync('git', ['config', 'alias.st', 'status -sb'], { cwd: repo });
    expect(runGuard('git st', repo).denied).toBe(false);
  });

  it('does NOT flag a common legitimate alias pattern that takes a trailing arg', () => {
    execFileSync('git', ['config', 'alias.cm', 'commit -m'], { cwd: repo });
    expect(runGuard('git cm "a normal commit message"', repo).denied).toBe(false);
  });

  it('denies a bang-alias whose verb is fixed but the dangerous path is deferred to invocation args', () => {
    execFileSync('git', ['config', 'alias.qd', '!rm -rf'], { cwd: repo });
    expect(runGuard('git qd data/warehouse', repo).denied).toBe(true);
  });

  it('denies an INLINE git -c alias.X="value" override (never persisted, one-shot, same command)', () => {
    expect(runGuard('git -c alias.qz="add -A" qz', repo).denied).toBe(true);
  });

  it('denies an inline -c bang-alias override with the path deferred to a trailing arg', () => {
    expect(runGuard('git -c alias.qz2="!rm -rf" qz2 data/warehouse', repo).denied).toBe(true);
  });

  it('denies an inline -c bang-alias override whose full dangerous command is in the value itself', () => {
    expect(runGuard('git -c alias.qz3="!rm -rf data/warehouse" qz3', repo).denied).toBe(true);
  });

  it('does NOT flag a benign inline -c alias override', () => {
    expect(runGuard('git -c alias.qz4="status -sb" qz4', repo).denied).toBe(false);
  });

  it('proves the inline -c override genuinely performs the blocked action end-to-end', () => {
    writeFileSync(path.join(repo, 'untracked-inline-e2e.txt'), 'hi');
    execFileSync('git', ['-c', 'alias.qz5=add -A', 'qz5'], { cwd: repo });
    const status = execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('A  untracked-inline-e2e.txt');
  });

  it('does NOT crash or misfire when cwd is not a git repo at all', () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), 'bash-guard-norepo-'));
    try {
      expect(runGuard('git qa', nonRepo).denied).toBe(false);
      expect(runGuard('echo hello', nonRepo).denied).toBe(false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('proves the alias genuinely performs the blocked action end-to-end (sanity check on the exploit itself)', () => {
    writeFileSync(path.join(repo, 'untracked-e2e.txt'), 'hi');
    execFileSync('git', ['config', 'alias.qa3', 'add -A'], { cwd: repo });
    execFileSync('git', ['qa3'], { cwd: repo });
    const status = execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('A  untracked-e2e.txt');
  });
});

describe('bash-guard.mjs — OI-010: wrapper-script indirection now resolved and blocked', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bash-guard-wrapper-'));
    mkdirSync(path.join(dir, 'data', 'warehouse'), { recursive: true });
    mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies a wrapper deferring rm target to $1, invoked with the warehouse path', () => {
    writeFileSync(path.join(dir, 'rmw.sh'), 'rm -rf "$1"');
    expect(runGuard('sh rmw.sh data/warehouse', dir).denied).toBe(true);
  });

  it('denies a wrapper deferring the SQL verb to $1, invoked with a DELETE', () => {
    writeFileSync(path.join(dir, 'sqw.sh'), 'sqlite3 data/warehouse/finance.sqlite "$1"');
    expect(runGuard('sh sqw.sh "DELETE FROM users"', dir).denied).toBe(true);
  });

  it('denies a wrapper deferring the guard-path write target, invoked with a hooks/ path', () => {
    writeFileSync(path.join(dir, 'w3.sh'), 'echo evil >> "$1"');
    expect(runGuard('sh w3.sh .claude/hooks/evil.mjs', dir).denied).toBe(true);
  });

  it('denies a wrapper deferring the hooksPath value, invoked with a path arg', () => {
    writeFileSync(path.join(dir, 'hp.sh'), 'git config core.hookspath "$1"');
    expect(runGuard('sh hp.sh /tmp/evil', dir).denied).toBe(true);
  });

  it('works with bash too, not just sh', () => {
    writeFileSync(path.join(dir, 'rmw2.sh'), 'rm -rf "$1"');
    expect(runGuard('bash rmw2.sh data/warehouse', dir).denied).toBe(true);
  });

  it('does NOT flag a benign script with unrelated content', () => {
    writeFileSync(path.join(dir, 'benign.sh'), 'echo "hello world"\nls -la\n');
    expect(runGuard('sh benign.sh', dir).denied).toBe(false);
  });

  it('does NOT crash on a referenced script that does not exist', () => {
    expect(runGuard('sh does-not-exist.sh data/warehouse', dir).denied).toBe(false);
  });

  it('does NOT touch a non sh/bash interpreter invocation (e.g. node script.js)', () => {
    writeFileSync(path.join(dir, 'looks-dangerous.js'), 'rm -rf data/warehouse');
    expect(runGuard('node looks-dangerous.js', dir).denied).toBe(false);
  });

  it('a later && clause is not pulled into an earlier sh <path> invocation as a false trailing arg', () => {
    writeFileSync(path.join(dir, 'noop.sh'), 'echo hi "$1"');
    expect(runGuard('sh noop.sh foo && rm -rf data/warehouse', dir).denied).toBe(true);
    // (denied here is CORRECT - the literal second clause is a real rm of the warehouse -
    // the point of this test is that it is caught by the ORIGINAL per-segment check on
    // that clause, not smeared/duplicated from the first clause's trailing-arg handling.)
  });

  it('still correctly handles sh -c "..." (unaffected, pre-existing feature)', () => {
    expect(runGuard('sh -c "git add -A"', dir).denied).toBe(true);
  });

  it('does not read a script larger than the size cap (defensive bound, not a security requirement)', () => {
    writeFileSync(path.join(dir, 'huge.sh'), 'rm -rf "$1"\n' + '# padding\n'.repeat(20000));
    // Oversized file is skipped entirely rather than partially read; the command's
    // own literal text still has no trigger, so this should be allowed (documents
    // the accepted bound, not a claim that oversized wrappers are always safe).
    expect(runGuard('sh huge.sh data/warehouse', dir).denied).toBe(false);
  });
});

describe('bash-guard.mjs — adversarial-review round 2: broadened invocation forms', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bash-guard-forms-'));
    mkdirSync(path.join(dir, 'data', 'warehouse'), { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies a direct executable invocation (./script.sh, no sh/bash prefix)', () => {
    writeFileSync(path.join(dir, 'exec1.sh'), 'rm -rf data/warehouse');
    expect(runGuard('./exec1.sh', dir).denied).toBe(true);
  });

  it('does NOT treat a bare command name (no path separator) as a script to read', () => {
    expect(runGuard('ls -la', dir).denied).toBe(false);
    expect(runGuard('git status', dir).denied).toBe(false);
  });

  it('denies source/. invocation forms', () => {
    writeFileSync(path.join(dir, 'src1.sh'), 'rm -rf data/warehouse');
    expect(runGuard('source src1.sh', dir).denied).toBe(true);
    expect(runGuard('. src1.sh', dir).denied).toBe(true);
  });

  it('denies zsh/dash/ksh interpreters, not just sh/bash', () => {
    writeFileSync(path.join(dir, 'zsh1.sh'), 'rm -rf data/warehouse');
    expect(runGuard('zsh zsh1.sh', dir).denied).toBe(true);
    expect(runGuard('dash zsh1.sh', dir).denied).toBe(true);
    expect(runGuard('ksh zsh1.sh', dir).denied).toBe(true);
  });

  it('denies stdin-redirection invocation (sh < script)', () => {
    writeFileSync(path.join(dir, 'redir1.sh'), 'rm -rf data/warehouse');
    expect(runGuard('sh < redir1.sh', dir).denied).toBe(true);
  });

  it('is case-insensitive on the interpreter name', () => {
    writeFileSync(path.join(dir, 'case1.sh'), 'rm -rf data/warehouse');
    expect(runGuard('SH case1.sh', dir).denied).toBe(true);
    expect(runGuard('Bash case1.sh', dir).denied).toBe(true);
  });

  it('handles a quoted script path containing a space', () => {
    mkdirSync(path.join(dir, 'my dir'), { recursive: true });
    writeFileSync(path.join(dir, 'my dir', 'w.sh'), 'rm -rf data/warehouse');
    expect(runGuard('sh "my dir/w.sh"', dir).denied).toBe(true);
  });

  it('proves a direct-execution bypass genuinely performs the blocked action end-to-end', () => {
    mkdirSync(path.join(dir, 'data2', 'warehouse'), { recursive: true });
    writeFileSync(path.join(dir, 'exec-e2e.sh'), 'rm -rf data2/warehouse');
    execFileSync('sh', [path.join(dir, 'exec-e2e.sh')], { cwd: dir });
    expect(existsSync(path.join(dir, 'data2', 'warehouse'))).toBe(false);
  });
});

describe('bash-guard.mjs — adversarial-review round 2: in-script variable indirection', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bash-guard-vars-'));
    mkdirSync(path.join(dir, 'data', 'warehouse'), { recursive: true });
    mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('denies a verb built from a simple shell variable (V=rm; $V -rf path)', () => {
    writeFileSync(path.join(dir, 'v1.sh'), 'V=rm\n$V -rf data/warehouse\n');
    expect(runGuard('sh v1.sh', dir).denied).toBe(true);
  });

  it('denies a git subcommand+flag built from variables', () => {
    writeFileSync(
      path.join(dir, 'v2.sh'),
      'SUB=push\nFLAG=--force\ngit "$SUB" "$FLAG" origin main\n',
    );
    expect(runGuard('sh v2.sh', dir).denied).toBe(true);
  });

  it('denies a guard-path write where the target is built via a variable on an earlier line', () => {
    writeFileSync(path.join(dir, 'v3.sh'), 'F=.claude/hooks/evil.mjs\necho pwned >> "$F"\n');
    expect(runGuard('sh v3.sh', dir).denied).toBe(true);
  });

  it('denies a value built via two-level variable concatenation (P1=sql; P2=ite3; CMD=$P1$P2)', () => {
    writeFileSync(
      path.join(dir, 'v4.sh'),
      'P1=sql\nP2=ite3\nCMD="$P1$P2"\n$CMD data/warehouse/finance.sqlite "DELETE FROM users"\n',
    );
    expect(runGuard('sh v4.sh', dir).denied).toBe(true);
  });

  it('does NOT flag a benign script with ordinary variable usage', () => {
    writeFileSync(path.join(dir, 'v5.sh'), 'NAME=world\necho "hello $NAME"\n');
    expect(runGuard('sh v5.sh', dir).denied).toBe(false);
  });

  it('proves the variable-built verb genuinely performs the blocked action end-to-end', () => {
    mkdirSync(path.join(dir, 'data3', 'warehouse'), { recursive: true });
    writeFileSync(path.join(dir, 'v1-e2e.sh'), 'V=rm\n$V -rf data3/warehouse\n');
    execFileSync('sh', [path.join(dir, 'v1-e2e.sh')], { cwd: dir });
    expect(existsSync(path.join(dir, 'data3', 'warehouse'))).toBe(false);
  });
});

describe('bash-guard.mjs — adversarial-review round 2: performance/DoS regressions', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'bash-guard-perf-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('a chain of self-referential/mutually-referencing git aliases resolves in well under a second (was 4-8s+)', () => {
    // Mirrors the adversarial-review reproduction: each leaf alias invokes several
    // sibling leaves, and the root alias invokes all of them - MAX_ALIAS_LOOKUPS
    // must bound total subprocess spawns regardless of branching factor.
    const leaves = ['leaf1', 'leaf2', 'leaf3', 'leaf4', 'leaf5'];
    for (const leaf of leaves) {
      const others = leaves.filter((l) => l !== leaf).map((l) => `git ${l}`).join(' && ');
      execFileSync('git', ['config', `alias.${leaf}`, `!${others || 'true'}`], { cwd: repo });
    }
    execFileSync(
      'git',
      ['config', 'alias.bomb0', `!${leaves.map((l) => `git ${l}`).join(' && ')}`],
      { cwd: repo },
    );
    const start = Date.now();
    runGuard('git bomb0', repo);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('an inline -c alias override with a long unterminated quote resolves in well under a second (was ~10s)', () => {
    const junk = 'c'.repeat(3000);
    const command = Array.from(
      { length: 100 },
      (_, i) => `git -c alias.a${i}="${junk}`,
    ).join(' ; ');
    const start = Date.now();
    runGuard(command, repo);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
