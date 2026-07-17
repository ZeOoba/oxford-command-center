#!/usr/bin/env node
/**
 * bash-guard.mjs - PreToolUse hook for the Bash tool.
 *
 * Blocks the always-wrong command classes named in CLAUDE.md:
 *   (a) git add -A / --all / bare '.' pathspec        (CLAUDE.md 2 - explicit paths only)
 *   (b) git commit --no-verify / -n                   (CLAUDE.md 9 - never bypass the gate)
 *   (c) git push --force / -f / --no-verify           (CLAUDE.md 8 - escalate to Gabriel)
 *   (d) git config touching core.hooksPath            (hook-tampering)
 *   (e) sqlite3 write DDL/DML against the live warehouse (CLAUDE.md 9)
 *   (f) rm/unlink of data/warehouse or data/overlay.json (CLAUDE.md 9)
 *   (g) writes to .claude/settings*.json / .claude/hooks/ (guardrail self-protection)
 *
 * There is NO override sentinel for these - they are always wrong per doctrine.
 *
 * FAIL-OPEN by design (EOS doctrine: process gates fail open): any stdin/JSON
 * error exits 0 silently. A deny is emitted as PreToolUse hookSpecificOutput
 * JSON on stdout with exit 0.
 *
 * Zero dependencies (node:fs/node:child_process/node:path are Node builtins).
 * Node >= 20. Runs identically on Windows and Linux.
 *
 * INDIRECTION (OI-010, 2026-07-17): a stateless per-invocation text scanner is
 * structurally blind to a command that merely NAMES something whose real,
 * disk-persisted definition contains a blocked pattern - a git alias
 * (`git config alias.qa "add -A"` then `git qa`) or a wrapper script
 * (`printf 'rm -rf "$1"' > w.sh` then `sh w.sh data/warehouse`). Neither step's
 * own command text contains the trigger substring, so no amount of narrowing
 * the existing regexes closes it - the checks below now run against an
 * EXPANDED text that resolves both indirection layers before scanning, so a
 * blocked pattern hidden behind either one is scanned exactly as if it had
 * been typed literally. This works whether the two steps are combined in one
 * command or genuinely split across separate Bash tool calls, since the
 * bridge is disk state (.git/config, a script file), not shell state.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/** Index of `sub` appearing after a `git` token in the token list, or -1. */
function gitSubcommandIndex(tokens, sub) {
  const gi = tokens.indexOf('git');
  if (gi === -1) return -1;
  return tokens.indexOf(sub, gi + 1);
}

/**
 * True when a `cp` invocation in `rawTokens` writes INTO a path matching
 * `guardPathRe` (destination argument only - `cp` sourced FROM that path is
 * a pure read/backup and must not trip this). Destination is the argument to
 * -t/--target-directory= when present (that form puts the destination
 * first), otherwise the last non-flag argument. Quote-unaware, matching this
 * file's existing tokenization elsewhere.
 */
function cpGuardWrite(rawTokens, guardPathRe) {
  const cpIdx = rawTokens.findIndex((t) => t === 'cp' || t.endsWith('/cp'));
  if (cpIdx === -1) return false;
  const args = rawTokens.slice(cpIdx + 1);
  // GNU cp accepts any unambiguous prefix of a long option, and accepts a
  // long option's argument either `=`-attached OR as the next token (e.g.
  // `--target-directory DIR` works identically to `--target-directory=DIR`
  // and to the `-t DIR` short form). Adversarial-review finds: matching only
  // the literal full `--target-directory=` spelling let `--target-dir=` (an
  // abbreviation) through, and matching only the `=`-attached form let the
  // space-separated `--target-directory DIR` form through. No other GNU cp
  // long option starts with `target-`, so any `--target-d...` prefix
  // unambiguously means this form regardless of which shape supplies DIR.
  const nextTokenFlagIdx = args.findIndex(
    (t) => t === '-t' || /^--target-d[a-z]*$/i.test(t),
  );
  const tdFlag = args.find((t) => /^--target-d[a-z]*=/i.test(t));
  let destArg;
  if (nextTokenFlagIdx !== -1) {
    destArg = args[nextTokenFlagIdx + 1];
  } else if (tdFlag) {
    destArg = tdFlag.slice(tdFlag.indexOf('=') + 1);
  } else {
    const nonFlagArgs = args.filter((t) => !t.startsWith('-'));
    destArg = nonFlagArgs[nonFlagArgs.length - 1];
  }
  return destArg ? new RegExp(guardPathRe, 'i').test(destArg) : false;
}

/** True when token is a single-dash short-option cluster containing letter `ch`. */
function shortClusterHas(token, ch) {
  return (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    /^-[a-zA-Z]+$/.test(token) &&
    token.includes(ch)
  );
}

/**
 * Normalize a raw token for flag matching: strip surrounding quotes and remove
 * backslash escapes that precede a dash. This defeats quoting/escaping bypasses
 * like `git add "-A"` and `git add \-A`.
 */
function normalizeToken(t) {
  return t
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    .replace(/\\(?=-)/g, '');
}

/** True when a token list is a `git add` that stages -A / --all / bare '.'. */
function gitAddAll(tokens) {
  const ai = gitSubcommandIndex(tokens, 'add');
  if (ai === -1) return false;
  const rest = tokens.slice(ai + 1).map(normalizeToken);
  return rest.some((t) => t === '--all' || t === '.' || shortClusterHas(t, 'A'));
}

/**
 * Extract executable payloads that hide commands from a naive token scan:
 *   - `sh -c "..."` / `bash -c '...'`   (the quoted script is executed)
 *   - `$( ... )` command substitution
 *   - `` ` ... ` `` backtick substitution
 * Run against the FULL command (not per-segment) because the segment splitter
 * is quote-unaware and would tear a quoted payload apart. A quoted string that
 * is a mere argument (e.g. `rg "git add -A"`) is intentionally NOT extracted.
 * Each lazy match is length-bounded (`{0,4096}?`) - this function is now also
 * called against script content OI-010 inlines (up to 64KB), and adversarial
 * review 2026-07-17 found this exact unbounded-lazy-quantifier-plus-delimiter
 * shape costs seconds of wall-clock time per occurrence on a large input
 * containing an unterminated quote/paren/backtick. No legitimate payload is
 * anywhere near 4096 characters.
 */
function extractExecPayloads(command) {
  const out = [];
  let m;
  const shc = /\b(?:sh|bash)\s+-c\s+(['"])([\s\S]{0,4096}?)\1/g;
  while ((m = shc.exec(command)) !== null) out.push(m[2]);
  const sub = /\$\(([\s\S]{0,4096}?)\)/g;
  while ((m = sub.exec(command)) !== null) out.push(m[1]);
  const bt = /`([\s\S]{0,4096}?)`/g;
  while ((m = bt.exec(command)) !== null) out.push(m[1]);
  return out;
}

// Known git builtin subcommands. Alias resolution below is skipped for these -
// git itself never lets a configured alias shadow an actual builtin name, so
// skipping them is both correct (matches real git behavior) and keeps this
// hook from shelling out to `git config --get` on the vast majority of git
// invocations. An incomplete list only costs one harmless extra subprocess
// call for an omitted builtin, never a missed detection.
const GIT_BUILTIN_SUBCOMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch',
  'bundle', 'cat-file', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'config', 'describe', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'fsck',
  'gc', 'grep', 'help', 'index-pack', 'init', 'log', 'ls-files', 'ls-tree',
  'merge', 'merge-base', 'mv', 'name-rev', 'notes', 'pack-objects', 'pull',
  'push', 'rebase', 'reflog', 'remote', 'request-pull', 'reset', 'restore',
  'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-ref', 'stash',
  'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index',
  'verify-pack', 'whatchanged', 'worktree',
]);

const MAX_ALIAS_DEPTH = 4;
// Segment delimiters, matched consistently everywhere a command/expansion
// needs to be scoped to "this one clause" (mirrors the main segment split).
const SEGMENT_SPLIT = /(?:\|\||&&|[;|\n])/;

// git global options that take a SEPARATE following argument token (e.g.
// `-C .`, `--git-dir .git`) - both this token and its value must be skipped
// when hunting for the actual subcommand/alias name. Options with an
// attached value (`--git-dir=.git`) are detected via the `=` check below
// instead, so only the bare option name needs to be listed here.
const GIT_GLOBAL_OPTS_WITH_ARG = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
  '--exec-path', '--config-env', '--list-cmds', '--attr-source',
]);

/**
 * Index of the first token after `gitIdx` that is the actual subcommand/alias
 * name - i.e. not `git` itself and not one of git's own global options
 * (`-c`, `-C`, `--git-dir=`, `-p`, `--no-pager`, etc., which may legitimately
 * precede the subcommand and would otherwise make the very next token look
 * like "not a candidate" and cause resolution to be skipped entirely, real
 * bypass found and fixed via adversarial review 2026-07-17). Returns -1 if
 * every remaining token is itself an option (or empty).
 */
function findGitCandidateIndex(tokens, gitIdx) {
  let i = gitIdx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t || !t.startsWith('-')) return t ? i : -1;
    const bareOpt = t.split('=')[0];
    if (GIT_GLOBAL_OPTS_WITH_ARG.has(bareOpt) && !t.includes('=')) {
      i += 2; // option token + its separate value token
    } else {
      i += 1; // boolean flag, or an attached =value form
    }
  }
  return -1;
}

// Hard cap on TOTAL `git config --get` subprocess spawns across one hook
// invocation (all depths, all segments combined) - adversarial review
// 2026-07-17 found MAX_ALIAS_DEPTH bounds recursion DEPTH but not BREADTH:
// a handful of chained/self-referential aliases (an entirely plausible
// .gitconfig pattern, not just a deliberate attack) multiplies spawns as
// depth^branching, producing 4-8+ second stalls on a hook that fires on
// every Bash call. This budget is shared across the whole resolveGitAliases
// call and bounds worst-case wall-clock to roughly this many spawns
// regardless of how the aliases branch or chain.
const MAX_ALIAS_LOOKUPS = 16;

/**
 * One pass over `text`, segment-scoped: resolve every `git <candidate>` that
 * names a configured alias. Trailing tokens after the candidate (within the
 * SAME segment) are appended to the resolved expansion - a bang-alias whose
 * value is just the verb (`!rm -rf`) still needs its invocation's own trailing
 * argument (`data/warehouse`) to co-occur with it for the checks below to see
 * the real, executed command rather than just the verb alone. `budget` is a
 * shared `{ remaining }` counter - see MAX_ALIAS_LOOKUPS above.
 */
function resolveGitAliasesOnce(text, budget) {
  const resolved = [];
  for (const seg of text.split(SEGMENT_SPLIT)) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (budget.remaining <= 0) return resolved;
      if (tokens[i] !== 'git') continue;
      const ci = findGitCandidateIndex(tokens, i);
      if (ci === -1) continue;
      const candidate = normalizeToken(tokens[ci]);
      if (!candidate || GIT_BUILTIN_SUBCOMMANDS.has(candidate)) continue;
      budget.remaining--;
      try {
        const value = execFileSync('git', ['config', '--get', `alias.${candidate}`], {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!value) continue;
        // Non-bang aliases run as `git <value>`; a leading `!` means the value
        // is itself a raw shell command, run as-is.
        const expansion = value.startsWith('!') ? value.slice(1) : `git ${value}`;
        const trailingArgs = tokens.slice(ci + 1).join(' ');
        resolved.push(trailingArgs ? `${expansion} ${trailingArgs}` : expansion);
      } catch {
        // Not an alias / git unavailable / not a repo - fail open, skip.
      }
    }
  }
  return resolved;
}

/**
 * Resolve git aliases recursively (a resolved alias can itself invoke another
 * alias), depth-capped AND lookup-budget-capped (MAX_ALIAS_LOOKUPS) so neither
 * a self-referential alias nor a wide fan-out of chained aliases can hang the
 * hook.
 */
function resolveGitAliases(command) {
  const out = [];
  const budget = { remaining: MAX_ALIAS_LOOKUPS };
  let frontier = [command];
  for (let depth = 0; depth < MAX_ALIAS_DEPTH && frontier.length > 0 && budget.remaining > 0; depth++) {
    const next = [];
    for (const text of frontier) {
      if (budget.remaining <= 0) break;
      for (const found of resolveGitAliasesOnce(text, budget)) {
        out.push(found);
        next.push(found);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Detect `git config alias.<name> <value>` DEFINITIONS and surface the value
 * itself for scanning, so CREATING a dangerous alias is denied immediately -
 * not just its later invocation. Handles both a quoted value and a bare,
 * unquoted rest-of-clause value. The quoted-value match is length-bounded
 * (`{0,4096}?` instead of an unbounded `[\s\S]*?`) - adversarial review
 * 2026-07-17 found the equivalent unbounded pattern in a sibling function
 * costing seconds of wall-clock time per occurrence on a large command
 * containing an unterminated quote (the lazy quantifier scans all the way to
 * end-of-string looking for a closing quote that never comes). No legitimate
 * alias value is anywhere near 4096 characters.
 */
function resolveAliasDefinitions(command) {
  const out = [];
  const quoted = /\bgit\s+config\s+(?:--\S+\s+)*alias\.[\w.:-]+\s+(["'])([\s\S]{0,4096}?)\1/g;
  let m;
  while ((m = quoted.exec(command)) !== null) {
    out.push(m[2].startsWith('!') ? m[2].slice(1) : `git ${m[2]}`);
  }
  const bare = /\bgit\s+config\s+(?:--\S+\s+)*alias\.[\w.:-]+\s+(?!["'])([^\n;|&]+)/g;
  while ((m = bare.exec(command)) !== null) {
    const value = m[1].trim();
    if (!value) continue;
    out.push(value.startsWith('!') ? value.slice(1) : `git ${value}`);
  }
  return out;
}

/**
 * Detect INLINE `git -c alias.<name>=<value>` / `--config alias.<name>=<value>`
 * overrides - a transient alias valid only for the single invocation it is
 * part of, never written to `.git/config`, so `git config --get` (used by
 * resolveGitAliasesOnce above) cannot see it. This is a same-command trick,
 * not cross-call, but closes a real gap: `git -c alias.qz="add -A" qz`
 * defines and invokes a dangerous alias with neither `git config` nor a
 * persisted alias ever appearing. Surfaces the value itself, plus the rest of
 * the segment (which may carry a deferred verb's trailing argument, e.g. a
 * bang-alias `!rm -rf` invoked with a path token later in the same segment).
 * Length-bounded (`{0,4096}?`) for the same reason as resolveAliasDefinitions
 * above - confirmed by adversarial review to cost seconds of wall-clock time
 * per occurrence, unbounded, on a large command with an unterminated quote.
 */
function resolveInlineAliasOverrides(text) {
  const out = [];
  for (const seg of text.split(SEGMENT_SPLIT)) {
    const re = /(?:-c|--config)\s+alias\.[\w.:-]+=(["']?)([\s\S]{0,4096}?)\1(?=\s|$)/g;
    let m;
    while ((m = re.exec(seg)) !== null) {
      const value = m[2];
      const expansion = value.startsWith('!') ? value.slice(1) : `git ${value}`;
      const rest = seg.slice(re.lastIndex).trim();
      out.push(rest ? `${expansion} ${rest}` : expansion);
    }
  }
  return out;
}

const MAX_SCRIPT_READ_BYTES = 65536;
const MAX_SCRIPT_EXPAND_PASSES = 3;
const MAX_VAR_SUB_PASSES = 4;

/** Best-effort `$1`/`${1}`/`$@`/`$*` substitution using space-separated `argsText`. */
function substitutePositionalParams(scriptContent, argsText) {
  const args = argsText.trim().length ? argsText.trim().split(/\s+/) : [];
  const strip = (a) => a.replace(/^["']|["']$/g, '');
  return scriptContent
    .replace(/\$\{?@\}?|\$\*/g, args.map(strip).join(' '))
    .replace(/\$\{?(\d+)\}?/g, (_, n) => {
      const idx = parseInt(n, 10) - 1;
      return idx >= 0 && idx < args.length ? strip(args[idx]) : '';
    });
}

/**
 * Best-effort, iterative substitution of SIMPLE literal variable assignments
 * (`NAME=value` alone on its own line, no command substitution/arithmetic/
 * export) into later `$NAME`/`${NAME}` references in the same text - closes
 * the class of bypass where a wrapper script builds its verb, flag, or a
 * guard-path write target from a variable instead of a literal (adversarial
 * review 2026-07-17: `V=rm; $V -rf data/warehouse`, `P1=sql; P2=ite3;
 * CMD="$P1$P2"`, `F=.claude/settings.json; ... >> "$F"`). Iterated a few
 * passes so a variable built FROM another substituted variable still
 * resolves. This is intentionally NOT a shell interpreter: `$(...)` command
 * substitution, arithmetic `$((...))`, exported/imported/environment
 * variables, and control flow (loops/conditionals/arrays) are all still
 * accepted, documented limits of a text-scan process gate - closing those
 * for real needs the same architectural shift OI-007 used (verify the actual
 * outbound action/repo state, not more text patterns), not another regex.
 */
function substituteSimpleVariables(scriptContent) {
  let text = scriptContent;
  for (let pass = 0; pass < MAX_VAR_SUB_PASSES; pass++) {
    const assign = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(\S+)[ \t]*$/gm;
    const vars = new Map();
    let m;
    while ((m = assign.exec(text)) !== null) {
      vars.set(m[1], m[2].replace(/^["']|["']$/g, ''));
    }
    if (vars.size === 0) break;
    let changed = false;
    // Matches a quote-wrapped reference (`"$VAR"`) as ONE unit (opening quote,
    // reference, matching closing quote) as well as a bare reference. A real
    // shell CONSUMES the quotes around an expanded variable - they don't
    // survive into the resulting argv - so replacing only the `$VAR` part and
    // leaving the quote characters behind would make the substituted value
    // look like a quoted STRING LITERAL to the checks below (which blank
    // quoted text to avoid false-positiving on commit messages), hiding it
    // again right after this function un-hides it. Confirmed real bug via
    // adversarial review: `git "$SUB" "$FLAG"` with SUB=push/FLAG=--force
    // substituted to `git "push" "--force"`, which the push/force check could
    // no longer see because it was quote-blanked before ever being scanned.
    text = text.replace(
      /(["'])\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))\1|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, _q, qBraced, qBare, braced, bare) => {
        const name = qBraced || qBare || braced || bare;
        if (!vars.has(name)) return whole;
        changed = true;
        return vars.get(name);
      },
    );
    if (!changed) break;
  }
  return text;
}

/**
 * Interpreters/forms this hook will read a referenced script's content
 * through. Matched case-insensitively - a case variant still runs the real
 * interpreter. `-c "..."` is deliberately excluded (handled separately by
 * extractExecPayloads).
 */
const SCRIPT_INVOCATION_RE =
  /\b(?:sh|bash|zsh|dash|ksh|source)\s+(?!-c\b)(?:(["'])([^"']+)\1|([^\s"']+))((?:\s+[^\s;&|]+)*)/gi;
const DOT_INVOCATION_RE =
  /(?:^|[;&|\n]|&&|\|\|)\s*\.\s+(?:(["'])([^"']+)\1|([^\s"']+))((?:\s+[^\s;&|]+)*)/g;
const STDIN_REDIRECT_RE = /\b(?:sh|bash|zsh|dash|ksh)\s*<\s*(?:(["'])([^"']+)\1|([^\s"']+))/gi;

/** Read+substitute a script file at `scriptPath`, or return null if it can't/shouldn't be read. */
function readScriptForScan(scriptPath, trailingArgs) {
  try {
    const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.join(process.cwd(), scriptPath);
    if (!existsSync(resolved)) return null;
    const st = statSync(resolved);
    if (!st.isFile() || st.size > MAX_SCRIPT_READ_BYTES) return null;
    const content = readFileSync(resolved, 'utf8');
    const withPositional = substitutePositionalParams(content, trailingArgs || '');
    return substituteSimpleVariables(withPositional);
  } catch {
    return null;
  }
}

/**
 * Inline-expand every way this hook recognizes as "run a script file" - the
 * interpreter form (`sh`/`bash`/`zsh`/`dash`/`ksh`/`source <path>`, any case),
 * the `. <path>` dot form, `sh < path` stdin redirection, and a BARE direct
 * execution (`./script.sh args`, or any path-shaped first token of a segment
 * that resolves to an existing file) - by substituting the script's own
 * content, with its `$1`/`$@`/simple-variable placeholders best-effort filled
 * in, at the exact point the invocation appeared. The guard otherwise never
 * opens a file a command merely references by path, which is exactly what
 * lets a wrapper script hide a blocked verb (or write target) behind a
 * deferred argument or an in-script variable. Missing/unreadable/oversized
 * files are left untouched (fail open), and matches are bounded to the
 * current segment so trailing args from a LATER `&&`/`;` clause are never
 * pulled in. `direct execution` is intentionally bounded to first-tokens that
 * look like a path (contain `/` or `\`) so a plain command name (`ls`, `git`)
 * is never read as a file.
 */
function expandScriptInvocations(command) {
  let text = command;
  for (let pass = 0; pass < MAX_SCRIPT_EXPAND_PASSES; pass++) {
    let changed = false;

    text = text.replace(SCRIPT_INVOCATION_RE, (whole, _q, quotedPath, barePath, trailingArgs) => {
      const content = readScriptForScan(quotedPath || barePath, trailingArgs);
      if (content === null) return whole;
      changed = true;
      return `${content}${trailingArgs}`;
    });

    text = text.replace(DOT_INVOCATION_RE, (whole, _q, quotedPath, barePath, trailingArgs) => {
      const content = readScriptForScan(quotedPath || barePath, trailingArgs);
      if (content === null) return whole;
      changed = true;
      const prefix = whole.match(/^(?:[;&|\n]|&&|\|\|)*\s*/)[0];
      return `${prefix}${content}${trailingArgs}`;
    });

    text = text.replace(STDIN_REDIRECT_RE, (whole, _q, quotedPath, barePath) => {
      const content = readScriptForScan(quotedPath || barePath, '');
      if (content === null) return whole;
      changed = true;
      return content;
    });

    text = text
      .split(SEGMENT_SPLIT)
      .map((seg) => {
        const trimmed = seg.trim();
        const firstSpace = trimmed.search(/\s/);
        const firstTok = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
        const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace);
        if (!firstTok || !/[\\/]/.test(firstTok)) return seg;
        const content = readScriptForScan(firstTok, rest);
        if (content === null) return seg;
        changed = true;
        return `${content}${rest}`;
      })
      .join('\n');

    if (!changed) break;
  }
  return text;
}

const GIT_ADD_MSG =
  'git add -A/--all/. is blocked: commit with explicit paths only (CLAUDE.md 2). ' +
  'Uncommitted files you did not create are another writer in-progress work.';

// Guardrail files whose in-session mutation is blocked (task g). Matches
// .claude/settings.json, .claude/settings.local.json and anything under
// .claude/hooks/ (both / and \ separators for the Windows checkout).
const GUARD_PATH = '\\.claude[\\\\/](?:settings\\.json|settings\\.local\\.json|hooks)';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) process.exit(0);

  // Fully expanded text to scan: the command itself, plus every indirection
  // layer that could otherwise hide a blocked pattern from a literal-text
  // scan - $()/backtick substitution, sh -c/bash -c payloads, resolved git
  // aliases (both invocation and definition), and the contents of any script
  // a `sh`/`bash` invocation names by path (inlined first, so alias/payload
  // resolution also sees through a script that itself defines/invokes an
  // alias). Every check below runs against this EXPANDED text (a strict
  // superset of the raw command), not just the raw command, so an alias or
  // wrapper that defers the dangerous flag/verb/path to a separate,
  // innocuous-looking step is scanned as if it had been typed literally.
  const scriptsInlined = expandScriptInvocations(command);
  const expanded = [
    scriptsInlined,
    ...extractExecPayloads(scriptsInlined),
    ...resolveGitAliases(scriptsInlined),
    ...resolveAliasDefinitions(scriptsInlined),
    ...resolveInlineAliasOverrides(scriptsInlined),
  ].join('\n');

  // Best-effort compound-cd awareness: a leading `cd data` / `cd data/warehouse`
  // (optionally ./-prefixed) means a later BARE `finance.sqlite` / `warehouse`
  // token in the same command still refers to the live warehouse. This does not
  // track arbitrary cd state across every segment of every compound command
  // (e.g. a cd that is itself conditional), so it is best-effort only - the
  // residual limitation is accepted per the fail-open process-gate doctrine.
  const cdData = /\bcd\s+\.?[\\/]?data(?:[\\/]warehouse)?\b/i.test(expanded);

  // (e) live-warehouse write DDL/DML - checked on the FULL expanded text so
  // pipes (echo "DELETE ..." | sqlite3 data/warehouse/finance.sqlite) and
  // alias/wrapper indirection cannot split it.
  if (
    /\b(?:sqlite3|better-sqlite3)\b/.test(expanded) &&
    /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|VACUUM)\b/i.test(expanded) &&
    (/data[\\/]warehouse[\\/]finance\.sqlite/i.test(expanded) ||
      (cdData && /\bfinance\.sqlite\b/i.test(expanded)))
  ) {
    deny(
      'Write DDL/DML against the live warehouse (data/warehouse/finance.sqlite) is blocked (CLAUDE.md 9). Schema/data changes go through server/warehouse/migrations/ and npm run warehouse:backfill.',
    );
  }

  // Split compound commands (now including every extracted/resolved payload,
  // each on its own line) so checks (a)-(d)/(f)/(g) are scoped per invocation.
  const segments = expanded.split(/(?:\|\||&&|[;|\n])/);

  for (const rawSeg of segments) {
    // Blank out quoted strings so commit-message content etc. cannot false-positive
    // the token checks. Raw segment is kept for path/regex checks and for the
    // git-add scan (which must see through quoting/escaping bypasses).
    const strippedSeg = rawSeg
      .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
      .replace(/'[^']*'/g, " '' ");
    const tokens = strippedSeg.trim().split(/\s+/).filter(Boolean);
    const rawTokens = rawSeg.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 && rawTokens.length === 0) continue;

    // (a) git add -A / --all / bare '.' - scanned on RAW tokens (quotes and
    // backslash-escapes normalized per token) so `git add "-A"` / `git add \-A`
    // are caught. The commit -n false-positive is handled below on stripped
    // tokens, so the git-add scan does NOT need quote-blanking.
    if (gitAddAll(rawTokens)) deny(GIT_ADD_MSG);

    // (b) git commit --no-verify / -n (token-scoped to the commit invocation;
    // uses stripped tokens so a commit MESSAGE containing -n cannot false-positive)
    const ci = gitSubcommandIndex(tokens, 'commit');
    if (ci !== -1) {
      const rest = tokens.slice(ci + 1);
      if (rest.some((t) => t === '--no-verify' || shortClusterHas(t, 'n'))) {
        deny(
          'git commit --no-verify/-n is blocked: the gate must run on every commit (CLAUDE.md 9). Fix the failing step instead of bypassing it.',
        );
      }
    }

    // (c) git push --force / -f / --no-verify (--force-with-lease is allowed).
    // NOTE: for `git push`, -n means --dry-run (harmless), so -n is NOT treated
    // as no-verify here; only the long form --no-verify is denied.
    const pi = gitSubcommandIndex(tokens, 'push');
    if (pi !== -1) {
      const rest = tokens.slice(pi + 1);
      if (rest.some((t) => t === '--force' || shortClusterHas(t, 'f'))) {
        deny(
          'git push --force/-f is blocked (CLAUDE.md 8): never force-push; if a force-push is truly needed, use --force-with-lease on a feature branch or escalate to Gabriel.',
        );
      }
      if (rest.some((t) => t === '--no-verify')) {
        deny(
          'git push --no-verify is blocked: the pre-push hook runs a confidential-history scan before every push (CLAUDE.md confidentiality doctrine). Never bypass it - fix what it flags or escalate to Gabriel.',
        );
      }
    }

    // (d) git config / git -c touching core.hooksPath - MUTATIONS only. A pure
    // read (`--get`/`--get-all`/`--get-regexp`/`--get-urlmatch`, or a bare
    // `git config core.hooksPath` with no value argument) is not tampering
    // and must not be denied - only a form that actually sets/unsets the
    // value is (OI-011). Anything this can't positively identify as a
    // recognized read still denies, matching this hook's conservative
    // default elsewhere.
    if (tokens.includes('git') && /core\.hookspath/i.test(rawSeg)) {
      const inlineSet = /(?:^|\s)-c\s*["']?core\.hookspath\s*=/i.test(rawSeg);
      const cfgi = gitSubcommandIndex(tokens, 'config');
      const cfgRest = cfgi === -1 ? [] : tokens.slice(cfgi + 1);
      const isExplicitRead = cfgRest.some((t) => /^--get(-all|-regexp|-urlmatch)?$/i.test(t));
      const isExplicitMutate = cfgRest.some((t) => /^--(unset(-all)?|add|replace-all)$/i.test(t));
      // Find the key's position WITHOUT filtering out dash-prefixed tokens
      // first (adversarial-review find: `git config core.hooksPath
      // -evilhooks` is a fully valid git SET with no `--` needed - filtering
      // dash-prefixed tokens before this search made the value invisible and
      // let it through as a "bare read"). Any token positioned after the key
      // at all means a value is present - EXCEPT for an explicit --get*/
      // regexp read, where a single trailing token is git's own
      // value-PATTERN filter argument, not a value being set.
      const keyIdx = cfgRest.findIndex((t) => /^core\.hookspath$/i.test(t));
      const hasTrailingToken = keyIdx !== -1 && keyIdx < cfgRest.length - 1;
      const hasValueArg = hasTrailingToken && !isExplicitRead;
      const isRecognizedRead =
        cfgi !== -1 &&
        !isExplicitMutate &&
        !hasValueArg &&
        (isExplicitRead || keyIdx !== -1);

      if (inlineSet || !isRecognizedRead) {
        deny(
          'Changing core.hooksPath is blocked: git hook-path tampering disables the repo safety hooks (CLAUDE.md 9).',
        );
      }
    }

    // (f) rm/unlink of the live warehouse or overlay. With a preceding `cd data`
    // the bare `warehouse` / `overlay.json` token still refers to live state.
    const isRm = tokens.some(
      (t) => t === 'rm' || t === 'unlink' || t.endsWith('/rm') || t.endsWith('/unlink'),
    );
    if (
      isRm &&
      (/data[\\/](?:warehouse|overlay\.json)/i.test(rawSeg) ||
        (cdData && /(?:\bwarehouse\b|overlay\.json)/i.test(rawSeg)))
    ) {
      deny(
        'Deleting data/warehouse or data/overlay.json is blocked (CLAUDE.md 9): live warehouse and user overlay are irreplaceable local state.',
      );
    }

    // (g) writes to the guardrail files themselves (redirection, tee, sed -i,
    // mv/cp onto them, rm/unlink of them). Reads (e.g. `cat .claude/settings.json`)
    // are NOT blocked - only mutations. Best-effort; process gate, fail-open.
    if (new RegExp(GUARD_PATH, 'i').test(rawSeg)) {
      const guardWrite =
        // redirect target: `> .claude/settings.json`, `>>.claude/hooks/x`
        new RegExp('>>?\\s*["\']?[^\\s"\'<>|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // tee into the path
        new RegExp('\\btee\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // in-place sed edit of the path
        new RegExp('\\bsed\\b[^|;&]*\\s-i\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // mv: guard path anywhere (source or destination) is a mutation - as
        // source it removes/neutralizes the file (same severity as rm), as
        // destination it overwrites. Unlike cp, mv has no pure-read form.
        new RegExp('\\bmv\\b[^|;&]*' + GUARD_PATH, 'i').test(rawSeg) ||
        // cp: only the DESTINATION argument is a mutation - copying FROM a
        // guardrail file (e.g. a backup) is a pure read and must not be
        // denied (OI-011). Destination is the last non-flag argument, or the
        // argument to -t/--target-directory= when that form is used.
        cpGuardWrite(rawTokens, GUARD_PATH) ||
        // rm/unlink of the path
        isRm;
      if (guardWrite) {
        deny(
          'Writing to .claude/settings*.json or .claude/hooks/ from inside a session is blocked: guardrails are edited only via a reviewed PR, never mutated from within a session.',
        );
      }
    }
  }

  process.exit(0);
} catch {
  // FAIL-OPEN: process gate - never block on a broken hook
  process.exit(0);
}
