export interface AddedLine {
  file: string;
  lineNo: number;
  text: string;
}

export interface ConfidentialHit {
  term: string;
  line: number;
  text: string;
  file: string;
}

export interface ContextGroup {
  dealKey: string;
  contextTerms: string[];
  requiresAny: string[];
}

export interface TermRoster {
  alwaysTerms: string[];
  contextGroups: ContextGroup[];
}

export function loadTerms(homeDirOverride?: string): TermRoster;

/** Hit from the `confidential: true` payload scanner. Carries no `term` -- the flag itself is the
 *  match, not a roster entry, so it is a distinct shape from ConfidentialHit. */
export interface ConfidentialFlagHit {
  line: number;
  text: string;
  file: string;
}

/** Repo name derived from `git rev-parse --git-common-dir` (NOT --show-toplevel, so it is correct
 *  from inside a linked worktree). Returns '' outside any git repo. */
export function currentRepoName(cwdOverride?: string): string;

export function isRegisteredConfidentialRepo(
  repoName: string,
  homeDirOverride?: string,
): boolean;

/** Non-optional `addedLines` on purpose: tests assert the null case behind @ts-expect-error, which
 *  only stays "used" while a nullable argument is a type error here. */
export function scanDiffForConfidentialFlag(addedLines: AddedLine[]): ConfidentialFlagHit[];

export function scanDiffForConfidential(
  addedLines: AddedLine[],
  terms: string[],
): ConfidentialHit[];

export function scanDiffForContextTerms(
  addedLines: AddedLine[],
  contextGroups: ContextGroup[],
): ConfidentialHit[];

export function parseAddedLines(diffText: string): AddedLine[];

/**
 * A `confidential: true` payload-shape hit. Distinct from ConfidentialHit: this scanner
 * fires on the JSON/object-literal key shape rather than a roster term, so there is no
 * `term` to report.
 */
export interface ConfidentialFlagHit {
  line: number;
  text: string;
  file: string;
}

export function currentRepoName(cwdOverride?: string): string;

export function isRegisteredConfidentialRepo(
  repoName: string,
  homeDirOverride?: string,
): boolean;

export function scanDiffForConfidentialFlag(
  addedLines: AddedLine[],
): ConfidentialFlagHit[];
