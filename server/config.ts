import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The master workbook IS the company brain and the primary live data source.
 * Override with WORKBOOK_PATH env if the file moves.
 *
 * Resolved at CALL time (not module load) — mirrors server/overlay.ts's overlayPath(). A
 * top-level `const` here would freeze in whatever process.env held when config.ts was first
 * imported, which happens (per ES module import evaluation order) before any importing
 * module's own loadEnvFile() call runs — silently discarding every .env override. Confirmed
 * empirically 2026-07-08: see docs/superpowers/plans/2026-07-08-workbook-path-dual-library-
 * and-env-loading-fix-plan.md.
 */
export function workbookPath(): string {
  return (
    process.env.WORKBOOK_PATH ??
    join(
      homedir(),
      'OneDrive - Oxford Capital Partners',
      'eric spreadsheets',
      'Master Excel Template Company Wide -- Oxford.xlsx',
    )
  );
}

export const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? join(process.cwd(), 'data', 'snapshots', 'portfolio.json');

/** Default max age before a persisted portfolio.json is treated as stale rather than current. */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

export function snapshotAgeMs(nowMs: number, generatedAtIso: string): number {
  return nowMs - new Date(generatedAtIso).getTime();
}

/** Fails loud (treats as stale) on an unparseable generatedAt rather than silently trusting it. */
export function isSnapshotStale(
  nowMs: number,
  generatedAtIso: string,
  maxAgeMs: number = SNAPSHOT_MAX_AGE_MS,
): boolean {
  const age = snapshotAgeMs(nowMs, generatedAtIso);
  return !Number.isFinite(age) || age > maxAgeMs;
}

/**
 * Resolved at CALL time (not module load) — same rationale as workbookPath() above: a top-level
 * `const` freezes in whatever process.env held when config.ts was first imported, which happens
 * before any importing module's own .env-loading call runs. Confirmed empirically 2026-07-09 in
 * an isolated worktree: setting BRAIN_SERVER_PORT via .env was silently ineffective while setting
 * it as a real process-level env var worked — see docs/design-parity-audit-2026-07-06.md.
 */
export function serverPort(): number {
  return Number(process.env.BRAIN_SERVER_PORT ?? 8911);
}

/**
 * The workbook's stated DATA "As of" date for v1 (the file carries June 1, 2026).
 * This is the WORKBOOK-DATA date only: it selects the workbook data-month column
 * (parse.ts monthCol) and stamps macro asOf labels. Since OI-023 (2026-07-22) the snapshot's
 * provenance labels (meta.asOf, cash.asOf, assumptions.asOf) read the workbook's OWN "As of"
 * dateline (parse.ts sheetDataAsOf) — this constant is only their flagged fallback, so a
 * stale pin can no longer masquerade as current data. It is deliberately NOT the reference
 * for day-count math or the Daily Brief body's "As of" label — those track referenceDate()
 * below (frozen-dateline defect, 2026-07: this constant froze every "expires in Nd" and the
 * brief dateline at June 1).
 */
export const WORKBOOK_AS_OF = process.env.WORKBOOK_AS_OF ?? '2026-06-01';

/**
 * The report reference date (YYYY-MM-DD): "today" for day-count / relative-date math
 * (lease monthsToExpiry, critical-date "Nd" counts) and the Daily Brief body's "As of" label.
 * Distinct from WORKBOOK_AS_OF (above) by design — the workbook data-month column must stay
 * on the DATA date (early in a month the workbook may not carry the run month's column yet),
 * while day-counts must track the RUN date.
 *
 * Resolved at CALL time (same rationale as workbookPath()/serverPort() above).
 * Precedence: REPORT_DATE env (pin for deterministic tests) → caller-supplied fallback
 * (e.g. the brief's ET send date) → the current UTC date.
 */
export function referenceDate(fallbackIso?: string): string {
  return process.env.REPORT_DATE ?? fallbackIso ?? new Date().toISOString().slice(0, 10);
}
