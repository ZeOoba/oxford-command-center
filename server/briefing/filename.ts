// server/briefing/filename.ts
//
// The attachment filename for a streamed briefing: ORA_Briefing_<Subject>_<YYYYMMDD>.pdf.
// Pure + deterministic (the date comes from the model's injected generatedDate). The subject is
// sanitized to a filesystem/header-safe token (no spaces, slashes, or commas) so the
// Content-Disposition header is always valid.
import type { BriefingModel } from '../../src/contracts/briefing';

/**
 * Converts a string into a filesystem and header-safe token.
 *
 * @param name - The subject string to normalize
 * @returns A normalized token containing only alphanumerics and underscores, or 'Briefing' if normalization results in an empty string
 */
export function subjectToken(name: string): string {
  return (
    name
      .replace(/&/g, ' and ')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Briefing'
  );
}

/**
 * Constructs the filename for a streamed briefing PDF attachment.
 *
 * @returns The filename for the briefing PDF, formatted as `ORA_Briefing_<subject>_<YYYYMMDD>.pdf`
 */
export function briefingFilename(model: BriefingModel): string {
  // Both kinds expose subject.name; kept as one read so a future third kind must opt in explicitly.
  const subject = model.subject.name;
  const ymd = model.meta.generatedDate.replace(/-/g, ''); // YYYY-MM-DD → YYYYMMDD
  return `ORA_Briefing_${subjectToken(subject)}_${ymd}.pdf`;
}
