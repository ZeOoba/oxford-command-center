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

export function loadTerms(homeDirOverride?: string): string[];

export function scanDiffForConfidential(
  addedLines: AddedLine[],
  terms: string[],
): ConfidentialHit[];

export function parseAddedLines(diffText: string): AddedLine[];
