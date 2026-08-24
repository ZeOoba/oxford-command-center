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
