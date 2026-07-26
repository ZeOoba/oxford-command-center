import type { Database } from 'better-sqlite3';
import type { Loan } from '../../src/contracts/index';

export interface DebtSnapshotResult {
  written: number;
  errors: string[];
  /** True iff the shrinkage guard declined the whole/majority-book supersede this call (either
   *  the H2a empty-set trigger or the partial-wipe majority trigger — see the REFUSED branch
   *  below). A typed field, not a prose-parsed sentinel — callers (POST /snapshot, the backfill
   *  CLI) need this signal to be robust to the errors[] message text changing; string-matching
   *  would silently break both consumers on a wording edit. */
  refusedEmptySupersede: boolean;
  /** Count of loans whose per-loan insert FAILED this write (round 10) — each such loan's prior
   *  row may already have been superseded, so the book may have lost rows. >0 sets the DEGRADED
   *  marker. Typed so the reload path can route a degraded write to its failure-level log
   *  branch instead of the generic warning. */
  degradedRows: number;
  /** True when THIS write was clean (not refused, zero insert losses) but a standing DEGRADED
   *  marker was retained because the trusted book has not recovered (round 13 — ninth-pass LOW:
   *  such writes previously returned a fully-quiet result, so the unattended reload logged
   *  nothing for the entire damaged window after damage day). */
  staleMarkerHeld: boolean;
}

/**
 * Absolute floor (row count) below which the partial-wipe shrinkage guard never fires, even at
 * 100% relative shrinkage. A single loan disappearing — paid off, or refinanced and re-keyed
 * under a new id — is completely ordinary business and must never become guard noise, in a book
 * of any size. The pre-existing H2a rule (fully empty incoming set, any book size) already
 * covers the case where that one loan IS the entire book; this floor exists so the NEW
 * partial-wipe rule below doesn't re-litigate that same single-loan case at, say, a 2-loan book
 * (1 gone = 50% shrinkage, which would otherwise cross the percentage threshold below).
 */
export const MIN_SUPERSEDED_ROWS_FOR_SHRINKAGE_GUARD = 2;

/**
 * Fraction of the current active book that may be superseded-without-replacement in one
 * snapshot before the write is refused pending explicit confirmation (2026-07-24, follow-up to
 * H2a — flagged post-sweep: the original guard caught only a FULLY empty incoming set, missing
 * a subtler parse regression that leaves a non-empty but drastically shrunken set, e.g. 1 of 12
 * loans surviving).
 *
 * 0.5 (a clear majority) is chosen because normal book churn retires loans ONE AT A TIME —
 * a payoff, a single refinance — while a systematic parser regression (a status classifier
 * newly misreading a column, a workbook tab partially truncated) is structural and tends to
 * drop MOST or ALL rows in the same snapshot. A majority vanishing at once is presumptively
 * abnormal; anything under half is presumptively ordinary churn and proceeds without
 * confirmation.
 *
 * The comparison against this share is measured on NET shrinkage (see the netLoss computation
 * at the call site), not id-set overlap — a refinance or an id rename that keeps the total loan
 * count intact computes netLoss=0 regardless of how many ids changed, so it never reaches this
 * comparison at all. `>=` (INCLUSIVE, corrected in round 4 from an earlier `>` — this docstring
 * itself went stale for one round after that correction shipped, caught on a second independent
 * review; the code and its tests are the source of truth, always verify against them): once
 * ordinary refi/rename churn no longer touches this predicate under ANY circumstance, an EXACT
 * 50% net collapse with no replacement has no remaining legitimate interpretation and requires
 * confirmation exactly like anything strictly above it.
 */
export const MAX_SUPERSEDE_SHARE_WITHOUT_CONFIRMATION = 0.5;

/** warehouse_meta key for the persisted refusal marker (migration 026). */
const REFUSAL_MARKER_KEY = 'debt_snapshot.last_write_refused';

export interface SnapshotRefusalMarker {
  /** The full REFUSED:/DEGRADED: reason string recorded at marker time. */
  reason: string;
  /** SQLite datetime('now') at the moment the marker was set (UTC, 'YYYY-MM-DD HH:MM:SS'). */
  refusedAt: string;
  /**
   * Round 10 (sixth adversarial pass — all three lenses converged): the two marker classes have
   * DIFFERENT data-trust semantics and consumers must not conflate them.
   *   'refused'  — the write was declined wholesale; the active rows are UNTOUCHED and genuinely
   *                are the last trusted book (a breach computed from them is real and survives).
   *   'degraded' — per-loan inserts failed after their prior rows were retired; the active rows
   *                are a POST-DAMAGE REMNANT the marker itself distrusts (a verdict computed
   *                from them — in EITHER direction — is fabricated; reviewers reproduced a
   *                genuinely-clearing book minting a phantom breach off its 0.55-LTV remnant).
   * Round 11: kind reflects the book's TRUST HISTORY, not merely the last attempt — a refusal
   * (which touches zero rows) can never upgrade a standing 'degraded' back to 'refused'.
   */
  kind: 'refused' | 'degraded';
  /**
   * Round 11 (seventh adversarial pass, HIGH — the "ratchet" false clearance): the row count of
   * the last TRUSTED/VETTED book, captured when the marker first latched from a clean state and
   * carried forward across subsequent refusals/degradations. Round 12 (eighth pass, two HIGHs):
   * on a degraded-from-clean latch this is max(pre-write active count, the guard-vetted INTENDED
   * book size) — the pre-write count alone let growth-direction damage (new financing rows lost
   * to insert failures) latch a stale baseline the remnant trivially matched, and a first-ever
   * snapshot latched baseline 0, which auto-cleared everything. A degraded marker clears ONLY on
   * FULL recovery to this baseline or explicit human opt-in — no churn floor: the eighth pass
   * reproduced a $9M loan lost to one poisoned cell auto-clearing under the >=2-row floor.
   * Null only for legacy/unparseable marker values (which can never auto-clear).
   */
  baselineCount: number | null;
  /** The FIRST damage/refusal message, captured at latch time and carried forward VERBATIM
   *  (round 12 — the round-11 recursive slice reduced it to boilerplate within two failed-clear
   *  cycles, destroying the resolver's breadcrumb). Null only for legacy values. */
  originalReason: string | null;
  /** ISO timestamp of the FIRST latch (the damage/refusal moment) — refusedAt tracks the latest
   *  re-upsert instead, which is the wrong time to show a resolver. Null only for legacy. */
  latchedAt: string | null;
  /**
   * Round 13 (ninth adversarial pass — two lenses reproduced count-grain HIGHs): the trusted
   * book as an id SET, not a count. baselineCount alone let (a) a refused→degraded chain carry a
   * stale smaller count, and (b) an unrelated NEW financing substitute for a destroyed loan —
   * both minting clearances with real debt off-book. A degraded marker now clears only when
   * EVERY id in this set is freshly re-written by a clean write (or a human opts in); growth
   * beyond the set is fine; count-padding and substitution are structurally impossible. Null
   * only for legacy values (which can never auto-clear).
   */
  trustedIds: string[] | null;
}

/**
 * The persisted stale-book marker, or null when the last write attempt was clean (obs-3 /
 * PR #233 residual #2 — both adversarial reviews flagged that a refusal on the unattended
 * reload path was invisible downstream, leaving a stale book to keep reporting a governor
 * clearance). Set by a shrinkage-guard REFUSAL and (round 9) by a DEGRADED write — one whose
 * per-loan inserts failed after their prior rows were superseded, silently losing rows without
 * ever tripping the guard. Cleared only by a clean write (not refused, zero insert losses), so
 * it always reflects the LATEST write attempt — self-healing, no manual reset. Set/cleared
 * INSIDE the write transaction, so (book, marker) commit atomically even across the documented
 * dev-server + backfill-CLI concurrency. Consumer: computePortfolioAggregateLtv withholds a
 * would-be clearance while this is set (a would-be BREACH survives — see the round-9 precedence
 * note there).
 */
export function readLastSnapshotRefusal(db: Database): SnapshotRefusalMarker | null {
  const row = db
    .prepare('SELECT value, updated_at FROM warehouse_meta WHERE key = ?')
    .get(REFUSAL_MARKER_KEY) as { value: string; updated_at: string } | undefined;
  if (row === undefined) return null;
  // Round 11: the value is structured JSON {kind, reason, baselineCount}. Anything that fails
  // to parse (a legacy plain-string marker, or a future writer forgetting the contract)
  // classifies as 'degraded' with an unknown baseline — the MOST conservative reading: a
  // degraded marker never lets a verdict through in either direction, and an unknown baseline
  // never auto-clears (only a human confirmation can).
  try {
    const parsed = JSON.parse(row.value) as {
      kind?: unknown;
      reason?: unknown;
      baselineCount?: unknown;
      originalReason?: unknown;
      latchedAt?: unknown;
      trustedIds?: unknown;
    };
    const kind: SnapshotRefusalMarker['kind'] = parsed.kind === 'refused' ? 'refused' : 'degraded';
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : row.value,
      refusedAt: row.updated_at,
      kind,
      baselineCount:
        typeof parsed.baselineCount === 'number' && Number.isFinite(parsed.baselineCount)
          ? parsed.baselineCount
          : null,
      originalReason: typeof parsed.originalReason === 'string' ? parsed.originalReason : null,
      latchedAt: typeof parsed.latchedAt === 'string' ? parsed.latchedAt : null,
      trustedIds:
        Array.isArray(parsed.trustedIds) && parsed.trustedIds.every((x) => typeof x === 'string')
          ? (parsed.trustedIds as string[])
          : null,
    };
  } catch {
    return {
      reason: row.value,
      refusedAt: row.updated_at,
      kind: 'degraded',
      baselineCount: null,
      originalReason: null,
      latchedAt: null,
      trustedIds: null,
    };
  }
}

/** Serialize a marker value for warehouse_meta (rounds 11-13 — structured, not prefix-parsed). */
function markerValue(
  kind: SnapshotRefusalMarker['kind'],
  reason: string,
  originalReason: string,
  latchedAt: string,
  trustedIds: string[] | null,
): string {
  return JSON.stringify({
    kind,
    reason,
    baselineCount: trustedIds !== null ? trustedIds.length : null,
    originalReason,
    latchedAt,
    trustedIds,
  });
}

// Loan.status (src/contracts/loan.ts) is free-form workbook text, not a fixed enum — the real
// Loan Index tab uses descriptive values like "Amortizing", "Interest Only", "Balloon Due Feb-27",
// never the literal string "Active". An allowlist requiring status === 'Active' therefore matches
// nothing real and silently excludes every genuine active loan (confirmed empirically 2026-07-10:
// 0 of 5 real borrower loans matched, leaving debt_positions permanently empty).
//
// TWO rounds of mandatory adversarial review (2026-07-10, refute-financial-change workflow) each
// independently broke a plain denylist-of-terminal-terms approach on this free-form field:
//   Round 1: bare "closed" false-positive-matched "Closed-End" (a loan-STRUCTURE term, not a
//     payoff signal); "paid off" (two words) missed the single-word "Payoff".
//   Round 2: the round-1 fix was ITSELF broken from both directions — "payoff" (added in round 1)
//     collides with THIS repo's OWN active-loan vocabulary (src/analytics/conditions.ts:218
//     "Prepare refinance or payoff" describes a LIVE balloon, not a completed payoff) and with
//     in-process states ("Payoff Pending/Scheduled/Requested" — still outstanding debt); the
//     closed(?![\s-]?end) lookahead only tolerated a single ASCII hyphen/space, so ORA's own
//     em-dash house style ("Closed—End") still slipped through; "terminated" collided with hedge
//     notes ("Swap Terminated" on a live loan); "closed" collided with "Closed to Prepayment"
//     (a live lockout period) and "Undisclosed"; and the denylist was missing standard
//     commercial-mortgage terminal vocabulary (Satisfied, Paid in Full/PIF, Released, Refinanced,
//     Repaid, Defeased, Extinguished, Cancelled, Assumed) — a real "Refinanced" old-loan row would
//     have DOUBLE-COUNTED debt against its own replacement loan.
//
// A substring denylist on genuinely free text has an unbounded tail of collisions in BOTH
// directions and cannot converge by adding more terms — every fix in round 1 became a new bug in
// round 2. Final design: three buckets, never a binary guess —
//   1. KNOWN_ACTIVE_PREFIXES — loan-TYPE language checked FIRST (so a terminal-sounding word
//      appended as a trailing note, e.g. "Amortizing; swap terminated 2025" or "Interest Only;
//      payoff at balloon Feb-27", can never override a genuinely active loan's own type prefix).
//   2. KNOWN_TERMINAL_TOKENS — the loan obligation itself has ended; word-boundaried (so it can't
//      match mid-word, e.g. "Undisclosed") and restricted to terms with no known active-vocabulary
//      collision (bare "closed"/"payoff"/"terminated" were each demonstrated to collide and are
//      deliberately NOT included — "closed end" is instead a KNOWN_ACTIVE_PREFIX).
//   3. Anything matching NEITHER is UNRECOGNIZED — kept active (the safer default for a
//      balloon/maturity/LTV alerting system: a visible-but-flagged loan can be checked by a human;
//      a silently-dropped one cannot) but surfaced in the returned errors[] so it is never silent.
// All matching is done on text with dash variants (-, em/en dash) and repeated whitespace
// normalized to a single space FIRST, so "Closed-End" / "Closed—End" / "Closed  End" all resolve
// identically regardless of which separator glyph the workbook cell happens to use.
function normalizeLoanStatusText(status: string): string {
  return status.trim().toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ');
}

const KNOWN_ACTIVE_PREFIXES = [
  'active', 'amortizing', 'interest only', 'io', 'balloon', 'closed end', 'construction', 'bridge', 'demand',
];

const KNOWN_TERMINAL_TOKENS = [
  'paid off', 'paidoff', 'paid in full', 'pif',
  'satisfied', 'released', 'refinanced', 'repaid',
  'defeased', 'extinguished', 'cancelled', 'canceled',
  'assumed', 'retired', 'inactive', 'discharged',
];
const KNOWN_TERMINAL_PATTERN = new RegExp(
  `\\b(${KNOWN_TERMINAL_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
);

/** See the three-bucket design note above. */
function classifyLoanStatus(status: string): 'active' | 'terminal' | 'unrecognized' {
  const normalized = normalizeLoanStatusText(status);
  if (KNOWN_ACTIVE_PREFIXES.some((p) => normalized.startsWith(p))) return 'active';
  if (KNOWN_TERMINAL_PATTERN.test(normalized)) return 'terminal';
  return 'unrecognized';
}

/**
 * Writes a snapshot of ORA borrower-side debt positions to the warehouse.
 * Filters to direction === 'borrower' and active loans only (null status, or classifyLoanStatus()
 * resolving to 'active'/'unrecognized' — see the three-bucket design note above). A loan id that
 * collides with another loan's id in the same batch is excluded from the write entirely (see
 * F-collision below) rather than silently overwritten.
 * On conflict (same id): updates the existing row (upsert).
 * Prior rows for the same loan id with a different snapshot_date are marked 'superseded'.
 *
 * F-stale fix: after upserting the current borrower set, any debt_positions row with
 * direction-borrower status='active' whose loan id is NOT in the incoming set is
 * superseded (so paid-off / removed loans leave the active set cleanly).
 *
 * F-FK-safe fix: property_id is validated against property_master before insert.
 * An id not in property_master is written as NULL + recorded in errors. This prevents
 * an FK constraint from silently swallowing a row.
 *
 * NOTE: The Loan contract has no propertyId field — ownership is via collateralProperty.
 * Pass loanPropertyMap to associate loans with properties at snapshot time (keyed by loan.id).
 *
 * LENDER COLUMN NOTE: lender is stored in the DB for internal PM use but is intentionally
 * excluded from the DebtPosition Zod type so it never reaches client-facing surfaces.
 */
export function writeDebtSnapshot(
  db: Database,
  loans: Loan[],
  snapshotDate: string,
  loanPropertyMap?: ReadonlyMap<string, string>,
  opts?: { allowEmptySupersede?: boolean },
): DebtSnapshotResult {
  const errors: string[] = [];
  let written = 0;
  let degradedRows = 0;
  let staleMarkerHeld = false;
  const writtenIds = new Set<string>(); // ids whose insert SUCCEEDED this write (round 13)

  // Filter: borrower-side only, active — null status, or classifyLoanStatus() resolves to
  // 'active' or 'unrecognized' (see the three-bucket design note above). An 'unrecognized' status
  // is deliberately KEPT active but flagged, never silently dropped.
  const borrowerLoansAll = loans.filter((l) => {
    if (l.direction !== 'borrower') return false;
    if (l.status === null) return true;
    const classification = classifyLoanStatus(l.status);
    if (classification === 'unrecognized') {
      errors.push(
        `loan ${l.id}: unrecognized status '${l.status}' — kept active but unverified; add to KNOWN_ACTIVE_PREFIXES or KNOWN_TERMINAL_TOKENS in debt-snapshot.ts once confirmed`,
      );
    }
    return classification !== 'terminal';
  });

  // F-collision: parseLoans (server/workbook/parse.ts) has no id-disambiguation for loans (unlike
  // properties, which go through disambiguatePropertyIds) — two distinct loans whose names
  // normalize to the same slug SHARE an id. Caught on adversarial review (2026-07-10, determinism
  // lens): this was LATENT before the status-filter fix above, because the old allowlist matched 0
  // real loans, so borrowerLoans was always empty and this collision path never ran. Rather than
  // let the upsert's ON CONFLICT(id, snapshot_date) last-write-wins silently pick one loan and
  // drop the other — with the surviving row's balance/LTV/maturity then depending on workbook/
  // iteration order — detect any id appearing more than once in the incoming batch and exclude
  // ALL of them from the write: a colliding pair's figures are untrustworthy until the id
  // collision itself is resolved (rename one loan in the workbook so its slug differs, or add id
  // disambiguation to parseLoans the way properties already have). The colliding id is still
  // included in the F-stale incoming-id set below, so a previously-written row for it is preserved
  // rather than superseded — we are not confident enough to touch it in either direction.
  const idCounts = new Map<string, number>();
  for (const loan of borrowerLoansAll) idCounts.set(loan.id, (idCounts.get(loan.id) ?? 0) + 1);
  const collidingIds = new Set([...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  for (const id of collidingIds) {
    const names = borrowerLoansAll.filter((l) => l.id === id).map((l) => l.name).join(' | ');
    errors.push(
      `loan id '${id}' collides across ${idCounts.get(id)} distinct loans (${names}) — none written this snapshot; rename in the workbook to disambiguate`,
    );
  }
  const borrowerLoans = borrowerLoansAll.filter((l) => !collidingIds.has(l.id));

  // F-FK-safe: load the valid property_master id set ONCE before the transaction.
  // Any loanPropertyMap value not in this set is coerced to null + surfaced as an error.
  const validPropertyIds = new Set(
    (db.prepare('SELECT id FROM property_master').all() as Array<{ id: string }>).map((r) => r.id),
  );

  const supersede = db.prepare(
    `UPDATE debt_positions
     SET status = 'superseded'
     WHERE id = ? AND snapshot_date != ? AND status = 'active'`,
  );

  // F-stale: supersede any previously-active borrower loan NOT in the current incoming set.
  const supersedeStale = db.prepare(
    `UPDATE debt_positions
     SET status = 'superseded'
     WHERE status = 'active'
       AND id NOT IN (SELECT value FROM json_each(?))`,
  );

  const upsert = db.prepare(
    `INSERT INTO debt_positions
       (id, snapshot_date, property_id, loan_name, lender, original_principal, current_balance, rate,
        loan_type, monthly_pmt, annual_interest, annual_principal, is_demand,
        maturity_date, months_to_maturity, ltv, balloon, status)
     VALUES
       (@id, @snapshot_date, @property_id, @loan_name, @lender, @original_principal, @current_balance, @rate,
        @loan_type, @monthly_pmt, @annual_interest, @annual_principal, @is_demand,
        @maturity_date, @months_to_maturity, @ltv, @balloon, 'active')
     ON CONFLICT(id, snapshot_date) DO UPDATE SET
       property_id        = excluded.property_id,
       loan_name          = excluded.loan_name,
       lender             = excluded.lender,
       original_principal = excluded.original_principal,
       current_balance    = excluded.current_balance,
       rate               = excluded.rate,
       loan_type          = excluded.loan_type,
       monthly_pmt        = excluded.monthly_pmt,
       annual_interest    = excluded.annual_interest,
       annual_principal   = excluded.annual_principal,
       is_demand          = excluded.is_demand,
       maturity_date      = excluded.maturity_date,
       months_to_maturity = excluded.months_to_maturity,
       ltv                = excluded.ltv,
       balloon            = excluded.balloon,
       status             = 'active'`,
  );

  // H2a (2026-07-24 integrity sweep, edges lens): an EMPTY incoming borrower set makes the
  // F-stale clause below supersede EVERY active row in one statement — retiring the entire debt
  // book. Downstream, computePortfolioAggregateLtv then saw a zero-row cohort. An empty borrower
  // set is far more likely to mean an upstream failure (the workbook's direction column moved,
  // the Loan Index tab was renamed, a caller POSTed `loans: []`) than a genuinely debt-free
  // portfolio, and the two are indistinguishable once the rows are gone. So: never wipe the book
  // on emptiness alone. A caller that has genuinely verified a zero-debt state opts in explicitly.
  //
  // KNOWN TRADEOFF, considered not accidental: borrowerLoansAll is empty both when the RAW
  // incoming loans array is empty (the bug case above) AND when a borrower's LAST remaining
  // active loan is present in the payload but classifies as 'terminal' (a genuine full payoff).
  // The two are indistinguishable from this signal alone — the function has no way to tell
  // "the parser broke" from "you just paid off your last loan" — so both require the same
  // explicit allowEmptySupersede opt-in. The consequence of guessing wrong is asymmetric: on a
  // real payoff, the paid-off loan stays visibly 'active' (a stale-but-honest dashboard state,
  // surfaced via errors[] for a human/caller to confirm and re-run with the opt-in) rather than
  // risking a silent false governor clearance on a parser bug. Same conservative posture as
  // F-collision above: an ambiguous signal is never silently resolved by guessing.
  // Round 6: fetch the actual active id LIST (not just a count) — the corrected netLoss formula
  // below needs to intersect it against the incoming set, matching exactly what F-stale itself
  // preserves vs. supersedes, not merely how many rows there were.
  const activeIds = (
    db.prepare("SELECT id FROM debt_positions WHERE status = 'active'").all() as Array<{ id: string }>
  ).map((r) => r.id);
  const activeRowCount = activeIds.length;

  // Partial-wipe shrinkage guard (2026-07-24, follow-up to H2a above). NET shrinkage, NOT
  // id-set overlap: this measures whether the BOOK COUNT is collapsing, not how many
  // previously-active ids individually survive into the incoming set.
  //
  // CONTRACT CORRECTION (round 4, adversarial-review finding, HIGH severity): the first version
  // of this guard counted supersededCount = active ids absent from the incoming set. That
  // conflates a genuine parse regression with completely ordinary portfolio activity — a
  // refinance that retires old loan ids and replaces them with NEW ids at the same total count,
  // or a rename applied for this codebase's own documented slug-collision remedy (F-collision
  // above: "rename in the workbook to disambiguate"). Both retire a majority of old ids while
  // the book's real size is UNCHANGED, and the old id-overlap rule refused them exactly as hard
  // as a genuine regression. Demonstrated (adversarial review, reproduced against the real
  // function): a 12-loan book refinances 7 loans under new ids — 12 in, 12 out, zero net
  // shrinkage — and the old rule refused the entire write. Because round 3 also made a refusal
  // abort the whole write (not just the supersede), the refi's new loans never landed, and the
  // now-STALE pre-refi aggregate LTV kept reporting `clearedConservatively: true` on every
  // subsequent automated reload, since nothing downstream distinguishes "refused" from
  // "healthy" — a governor false clearance the fix itself introduced.
  //
  // netLoss = how many MORE active rows there were than are incoming, floored at 0. A refi or
  // rename that keeps the total count intact (however many ids changed) computes netLoss = 0 and
  // never trips this guard; a genuine collapse in row count still does, regardless of whether it
  // happened via id churn or a bare drop.
  //
  // CONTRACT CORRECTION (round 5, SECOND independent adversarial-review pass, HIGH severity):
  // this must count DISTINCT ids in `borrowerLoans` (the F-collision-filtered, actually-writable
  // set) — NOT `borrowerLoansAll.length` (the raw incoming count, computed BEFORE F-collision
  // filtering runs above). A parse regression that makes many loans slug to the same id (a
  // name-column drift is F-collision's own documented threat model, two paragraphs up) inflates
  // the raw count without producing any written or preserved-as-new rows — every colliding id is
  // excluded from the write entirely. Using the raw count let a mass collision compute netLoss=0
  // while the real active book collapsed underneath.
  //
  // CONTRACT CORRECTION (round 6, THIRD independent adversarial-review pass, MEDIUM severity):
  // counting distinct ids in `borrowerLoans` ALONE over-corrected. F-collision excludes a
  // colliding id from being freshly WRITTEN, but F-stale separately PRESERVES that id's prior
  // row (it is still present in borrowerLoansAll's incoming set, so it is never superseded — see
  // the F-collision comment above: "a previously-written row for it is preserved rather than
  // superseded"). Counting only borrowerLoans treated every preserved-but-colliding id as a
  // LOSS too, over-triggering the guard whenever a collision cluster happened to reuse an id
  // that was ALREADY active — demonstrated at 12 loans / 3 such clusters: the guard refused at a
  // claimed "6 of 12 lost" when the true post-write book would have been 9 of 12 (a genuine loss
  // of only 3, from loans genuinely absent from the payload — unrelated to the collisions).
  //
  // The book's actual post-write id set is the union of (ids freshly written this run) and
  // (previously-active ids that survive F-stale's exclusion, i.e. present in the incoming set
  // regardless of whether they end up freshly written or merely preserved-as-colliding).
  const survivingOrWrittenIds = new Set<string>(borrowerLoans.map((l) => l.id));
  const incomingIdSetForGuard = new Set(borrowerLoansAll.map((l) => l.id));
  for (const id of activeIds) {
    if (incomingIdSetForGuard.has(id)) survivingOrWrittenIds.add(id);
  }
  const netLoss = Math.max(activeRowCount - survivingOrWrittenIds.size, 0);
  const wouldTotallyEmpty = borrowerLoansAll.length === 0 && activeRowCount > 0;
  // `>=` (not `>`, corrected alongside this fix): once ordinary refi/rename churn no longer
  // touches this predicate at all (it computes netLoss=0), an EXACT 50% net collapse has no
  // remaining legitimate interpretation and should also require confirmation.
  const wouldMajorityShrink =
    activeRowCount > 0 &&
    netLoss >= MIN_SUPERSEDED_ROWS_FOR_SHRINKAGE_GUARD &&
    netLoss / activeRowCount >= MAX_SUPERSEDE_SHARE_WITHOUT_CONFIRMATION;
  const refuseEmptySupersede =
    (wouldTotallyEmpty || wouldMajorityShrink) && opts?.allowEmptySupersede !== true;

  let refusalMessage: string | null = null;
  if (refuseEmptySupersede) {
    const reason = wouldTotallyEmpty
      ? `empty borrower set would have superseded all ${activeRowCount} active debt_positions row(s)`
      : `borrower set would net-shrink the active debt_positions book from ${activeRowCount} to ` +
        `${activeRowCount - netLoss} row(s) (${netLoss} of ${activeRowCount} lost with no replacement, ` +
        `${Math.round((netLoss / activeRowCount) * 100)}%) — a majority shrinkage in one snapshot`;
    refusalMessage =
      `REFUSED: ${reason} — refusing to shrink the debt book on an unexplained loss (likely an upstream ` +
      'parse/payload failure, not genuine portfolio churn — a refinance or id rename that keeps the total ' +
      'loan count intact is NOT affected by this guard). Existing rows left untouched. Confirm and pass ' +
      '{ allowEmptySupersede: true } if this net loss is verified.';
    errors.push(refusalMessage);
  }

  // Refusal/degraded marker statements (obs-3 / round 9). Prepared here, executed INSIDE the
  // transaction below — round-9 correction (fifth adversarial pass, determinism lens): the
  // round-8 version ran the marker upsert/delete AFTER the transaction, so the documented
  // dev-server + backfill-CLI concurrency (db.ts busy_timeout note) could interleave one
  // process's book commit between another's commit and marker write, leaving the marker
  // describing the WRONG attempt. Inside the transaction, (book, marker) commit atomically:
  // a mid-write throw rolls both back together, preserving the previous marker state (a crash
  // still never silently clears a standing refusal).
  const upsertMarker = db.prepare(
    `INSERT INTO warehouse_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );
  const deleteMarker = db.prepare('DELETE FROM warehouse_meta WHERE key = ?');

  const runAll = db.transaction(() => {
    // Round 11: the standing marker is read INSIDE the transaction — the trust decision below
    // depends on the book's history, and it must be the same snapshot the write acts on.
    const standing = readLastSnapshotRefusal(db);

    // Shrinkage guard: when refused, skip the write ENTIRELY — not just the F-stale supersede.
    // A snapshot we don't trust enough to retire the missing rows also isn't trustworthy for the
    // rows it DID include: the same parse regression that dropped 11 of 12 loans could just as
    // easily have corrupted a field (balance, ltv) on the 1 that came through. Writing that one
    // row while refusing the rest would be a half-measure — the caller sees `written: 1` and may
    // reasonably read that as "the snapshot was fine", masking the REFUSED signal in errors[].
    // All-or-nothing matches the rest of this function's "never guess" posture.
    if (refuseEmptySupersede) {
      // Round 11 (seventh adversarial pass, MEDIUM — reproduced): a refusal touches ZERO rows,
      // so it can never UPGRADE trust. If the standing marker says the rows are a damaged
      // remnant ('degraded'), they still are — overwriting kind to 'refused' laundered the
      // remnant into "the last trusted book" and resurrected the fabricated-BREACH defect via
      // the degrade-then-refuse ordering. Kind ratchets: degraded stays degraded until a clean,
      // fully-recovered write clears the marker entirely.
      const kind: SnapshotRefusalMarker['kind'] = standing?.kind === 'degraded' ? 'degraded' : 'refused';
      const originalReason = standing?.originalReason ?? standing?.reason ?? refusalMessage!;
      const latchedAt = standing?.latchedAt ?? standing?.refusedAt ?? new Date().toISOString();
      // Trusted ids: carried from the standing marker; on a refused-from-clean latch, the
      // UNTOUCHED active book is the trusted set (a refusal changes no rows).
      const trustedIds = standing !== null ? standing.trustedIds : activeIds;
      const reason =
        kind === 'degraded'
          ? `DEGRADED (standing) — latest attempt also REFUSED: ${refusalMessage!} Original damage (${latchedAt}): ${originalReason.slice(0, 300)}`
          : refusalMessage!;
      upsertMarker.run(REFUSAL_MARKER_KEY, markerValue(kind, reason, originalReason, latchedAt, trustedIds));
      return;
    }

    // F-stale: supersede all previously-active rows whose id is not in the incoming set. Uses
    // borrowerLoansAll (not the collision-filtered borrowerLoans) so a colliding id's PRIOR row is
    // preserved rather than superseded — we are not confident enough to touch it either direction.
    const incomingIds = JSON.stringify(borrowerLoansAll.map((l) => l.id));
    supersedeStale.run(incomingIds);

    for (const loan of borrowerLoans) {
      try {
        // Supersede any prior rows for this loan id with a different snapshotDate
        supersede.run(loan.id, snapshotDate);

        // F-FK-safe: validate the mapped property_id before insert
        const mappedPropertyId = loanPropertyMap?.get(loan.id) ?? null;
        let propertyId: string | null = null;
        if (mappedPropertyId !== null) {
          if (validPropertyIds.has(mappedPropertyId)) {
            propertyId = mappedPropertyId;
          } else {
            // Not in property_master — write null + surface the error
            errors.push(
              `loan ${loan.id}: property_id '${mappedPropertyId}' not in property_master — written as null`,
            );
            propertyId = null;
          }
        }

        upsert.run({
          id: loan.id,
          property_id: propertyId,
          loan_name: loan.name,
          lender: loan.lender ?? null,
          original_principal: loan.originalPrincipal ?? null,
          current_balance: loan.absBalance,  // Always positive magnitude; never signed currentBalance (see conditions.ts sign convention)
          rate: loan.rate ?? null,
          loan_type: loan.loanType ?? null,
          monthly_pmt: loan.monthlyPmt ?? null,
          annual_interest: loan.annualInterest ?? null,
          annual_principal: loan.annualPrincipal ?? null,
          is_demand: loan.isDemand ? 1 : 0,
          maturity_date: loan.maturity ?? null,
          months_to_maturity: loan.monthsToMaturity ?? null,
          ltv: loan.ltv ?? null,
          balloon: loan.balloon ? 1 : 0,
          snapshot_date: snapshotDate,
        });
        written++;
        writtenIds.add(loan.id); // round 13 — identity-grain recovery tracking
      } catch (e) {
        errors.push(`loan ${loan.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Marker lifecycle, non-refused branch (round-9 correction — fifth adversarial pass, edges
    // lens, REPRODUCED): "not refused" does NOT mean "healthy". The shrinkage guard judges the
    // INCOMING id set before any write outcome is known, but the per-loan sequence above is
    // supersede-prior-row THEN insert, with insert failures swallowed by the per-loan catch —
    // a failed insert therefore LOSES a row (prior superseded, replacement never landed). The
    // round-8 rule cleared a standing marker on any non-refused write, so a write that shrank
    // the book 3→1 through insert failures both destroyed rows AND released the staleness latch,
    // restoring a false clearance (reproduced end-to-end by the reviewer: NaN balance → SQL NULL
    // → NOT NULL constraint → book 3→1, marker gone, clearedConservatively=true at the
    // remnant's own LTV). Every loop iteration either increments `written` or pushes to the
    // catch, so borrowerLoans.length − written counts exactly the insert-failure losses.
    const lostRows = borrowerLoans.length - written;
    degradedRows = lostRows;

    // Round 17 (adversarial refute, two HIGH findings, reproduced independently): rounds 15-16's
    // "unexplained supersession" check lived ONLY in the lostRows===0 branch as a transient gate
    // on the clear decision — it never latched anything, so (a) the identical loss reaching a
    // clear via the lostRows>0 branch instead (the supersession co-occurring with an unrelated
    // insert failure one write earlier) bypassed it entirely, and (b) even when it correctly
    // held, the flagged loan's row was ALREADY superseded in that same transaction, so the very
    // next write — with the loan already gone from activeIds — recomputed nothing amiss and
    // cleared anyway with zero human confirmation. Computing this ONCE here, before either
    // branch, and UNIONING the result into trustedIds itself (exactly like failedIdsThisWrite)
    // fixes both: it now applies uniformly regardless of which branch this write takes, and once
    // latched an id stays part of the durable recovery obligation across every future write until
    // it actually returns or a human passes allowEmptySupersede — not just until the next tick.
    //
    // Round 18 (adversarial refute, HIGH — reproduced): gating on standing.kind==='degraded'
    // left the FIRST-LATCH write itself uncovered — a loan silently absent from the very payload
    // that ALSO reveals an unrelated insert failure (the same parser regression plausibly causing
    // both) was never captured, because survivingOrWrittenIds below is built purely from this
    // write's own incoming set and has no notion of what was active immediately before it. Gate
    // is now "standing is null (nothing trusted yet — trustedSetSoFar is simply empty) OR
    // standing.trustedIds is a real array" — skipping only a legacy marker with a genuinely
    // unknown (null) trusted set.
    //
    // Round 18 also excludes ids the RAW payload itself explains as terminal (Paid in Full,
    // Refinanced, etc. — classifyLoanStatus, the same three-bucket classifier that produced
    // borrowerLoansAll): a documented payoff is not a silent vanish, and borrowerLoansAll has
    // already stripped it out before incomingIdSet ever sees it, so without this exclusion a
    // fully healthy, self-documenting payoff would latch forever (the only escape being a
    // blanket allowEmptySupersede that also waives any genuinely-unresolved original damage).
    const explainedTerminalIds = new Set(
      loans
        .filter(
          (l) => l.direction === 'borrower' && l.status !== null && classifyLoanStatus(l.status) === 'terminal',
        )
        .map((l) => l.id),
    );
    let unexplainedSupersededIds: string[] = [];
    if (standing === null || standing.trustedIds !== null) {
      const trustedSetSoFar = new Set(standing?.trustedIds ?? []);
      const activeIdSet = new Set(activeIds);
      const incomingIdSet = new Set(borrowerLoansAll.map((l) => l.id));
      const nonTrustedActiveBefore = activeIds.filter((id) => !trustedSetSoFar.has(id));
      const supersededNonTrusted = nonTrustedActiveBefore.filter(
        (id) => !incomingIdSet.has(id) && !explainedTerminalIds.has(id),
      );
      // Round 16 (adversarial refute, HIGH — reproduced twice independently): an F-collision id
      // (two distinct loans sharing a slug) sits in incomingIdSet but lands ZERO rows (excluded
      // from borrowerLoans entirely, line ~331) — writtenIds.has(id) is required so a phantom
      // collision id can never count as the "replacement" that explains a real disappearance.
      const netNewNonTrusted = [...incomingIdSet].filter(
        (id) => !activeIdSet.has(id) && !trustedSetSoFar.has(id) && writtenIds.has(id),
      );
      if (supersededNonTrusted.length > netNewNonTrusted.length) {
        // Shortfall: more non-trusted active loans vanished than genuinely-new ids explain. The
        // count-based comparison can't say WHICH specific disappearance was "explained" by which
        // specific replacement, so — consistent with this whole function's never-guess posture —
        // ALL superseded non-trusted ids join the obligation, not just the unexplained excess.
        unexplainedSupersededIds = supersededNonTrusted;
      }
    }

    if (lostRows > 0) {
      // Wording (round-10 nit): a failed insert LOSES a row only when that loan HAD a prior
      // active row (the per-loan supersede retired it before the insert failed) — a net-new
      // loan's failed insert just never lands. Both cases are untrusted-write territory, so
      // both latch the marker; the message claims "may have lost", never "did lose".
      //
      // Round-13 trusted-set latch (ninth pass, HIGH ×2 — reproduced): the trusted book is an
      // id SET, not a count. When damage starts now (no standing marker, or a standing pure
      // REFUSAL — which touched zero rows), the trusted set is this write's guard-vetted
      // intended book (survivingOrWrittenIds: written ∪ preserved ∪ failed — the failed ids ARE
      // in it, which is exactly what forces their return for recovery), unioned with any
      // standing refusal's trusted set (a refusal's set can only describe the same untouched
      // book; the union closes the refused→degraded stale-carry hole where a transient refusal
      // collapsed the growth latch back to the smaller pre-growth count). A standing DEGRADED
      // marker carries its earliest trusted set unchanged — a remnant-vetted payload proves
      // nothing about the pre-damage book.
      const damageStartsNow = standing === null || standing.kind === 'refused';
      // Round 14 (order-dependence defect, hostile_repro_r13 + adversarial refute finding #1):
      // continuing damage while ALREADY degraded must still admit any id that fails THIS write,
      // even one that was never part of the original latch (e.g. a loan that landed clean in an
      // earlier held write, then fails here) — otherwise its later destruction goes untracked and
      // a subsequent clean write can clear the marker with that loan's debt permanently off-book.
      // Deliberately NOT survivingOrWrittenIds here (unlike the damageStartsNow branch, which
      // legitimately captures the WHOLE first-latch write, successes included, per rounds 1-13):
      // adversarial refute finding #2 showed that admitting mere SUCCESSES on a continuing write
      // over-latches ordinary refinance/rename churn (a loan merely observed during a degraded
      // window, later renamed to a new id with no insert failure, would otherwise never be
      // allowed to leave the recovery obligation). Only an actual failed insert is unambiguous
      // evidence of damage; a loan's later absence from a payload — with no failed attempt — is
      // exactly the shrinkage guard's own job to police, not this set's.
      const failedIdsThisWrite = borrowerLoans.filter((l) => !writtenIds.has(l.id)).map((l) => l.id);
      const trustedIds = damageStartsNow
        ? [...new Set([...(standing?.trustedIds ?? []), ...survivingOrWrittenIds, ...unexplainedSupersededIds])]
        : standing.trustedIds === null
          ? null
          : [...new Set([...standing.trustedIds, ...failedIdsThisWrite, ...unexplainedSupersededIds])];
      const degradedMsg =
        `DEGRADED: ${lostRows} of ${borrowerLoans.length} loan upsert(s) failed this write — any such loan ` +
        'with a prior active row had that row superseded before its replacement failed, so the active ' +
        'debt book may have silently lost rows. The surviving rows are NOT a trusted book state. ' +
        'Treated as stale (no aggregate-LTV verdict in either direction) until a clean write re-lands ' +
        'every trusted loan. See errors[] on the triggering writeDebtSnapshot result.';
      upsertMarker.run(
        REFUSAL_MARKER_KEY,
        markerValue(
          'degraded',
          degradedMsg,
          damageStartsNow ? degradedMsg : (standing.originalReason ?? standing.reason),
          damageStartsNow ? new Date().toISOString() : (standing.latchedAt ?? standing.refusedAt),
          trustedIds,
        ),
      );
    } else if (standing === null || opts?.allowEmptySupersede === true || standing.kind === 'refused') {
      // Clean write with no standing marker (routine no-op delete); a human explicitly
      // confirmed this book state via the opt-in; or the standing marker was a pure REFUSAL —
      // the rows were never damaged, this write passed the per-write shrinkage guard against
      // that trusted book, so the fresh book is trusted. Clear.
      deleteMarker.run(REFUSAL_MARKER_KEY);
    } else {
      // Rounds 11-13 (three consecutive adversarial passes, each a reproduced HIGH): a clean
      // write clears a standing DEGRADED marker ONLY when EVERY id in the trusted set was
      // freshly RE-WRITTEN by this write. The predicate's history, each version reproduced as a
      // false clearance: round 11 used the churn-floor thresholds (single-row damage of any
      // dollar size auto-cleared — a $9M loan); round 12 used a count baseline (an unrelated
      // NEW financing substituted for the destroyed loan; a transient refusal carried a stale
      // smaller count). Identity ×freshly-written closes the whole class: substitution is
      // impossible (the destroyed id itself must return), count-padding is impossible, and a
      // collision-PRESERVED remnant row does not count as recovered (it was never re-vetted —
      // only an actual successful insert this write counts). Growth beyond the trusted set is
      // fine. A genuine payoff of a trusted loan during the damaged window is resolved with one
      // explicit opt-in run. A legacy marker without a trusted set can never auto-clear.
      // Round 17: unexplainedSupersededIds (computed once, above, before either branch) is
      // folded directly into the trusted set here — durably, not as a one-shot gate — before the
      // fullyRecovered check runs. A newly-latched id was never written THIS round (it merely
      // vanished), so fullyRecovered against the EXPANDED set correctly evaluates false on its
      // own, with no separate boolean needed; and because it is now genuinely part of trustedIds,
      // it stays part of the recovery obligation on every subsequent write until it actually
      // returns or a human passes allowEmptySupersede — closing round 15/16's one-shot gap.
      const trustedIds =
        standing.trustedIds === null
          ? null
          : unexplainedSupersededIds.length > 0
            ? [...new Set([...standing.trustedIds, ...unexplainedSupersededIds])]
            : standing.trustedIds;
      const fullyRecovered = trustedIds !== null && trustedIds.every((id) => writtenIds.has(id));
      if (fullyRecovered) {
        deleteMarker.run(REFUSAL_MARKER_KEY);
      } else {
        staleMarkerHeld = true;
        const originalReason = standing.originalReason ?? standing.reason;
        const latchedAt = standing.latchedAt ?? standing.refusedAt;
        const missing =
          trustedIds === null
            ? 'UNKNOWN (legacy marker without a trusted id set)'
            : trustedIds.filter((id) => !writtenIds.has(id)).join(', ');
        upsertMarker.run(
          REFUSAL_MARKER_KEY,
          markerValue(
            'degraded',
            `DEGRADED: trusted loan(s) still missing or not re-verified this write: ${missing}. The book ` +
              'remains untrusted until a clean write re-lands every trusted loan (or the loss is confirmed ' +
              `via allowEmptySupersede). Original damage (${latchedAt}): ${originalReason.slice(0, 300)}`,
            originalReason,
            latchedAt,
            trustedIds,
          ),
        );
      }
    }
  });

  runAll();
  return { written, errors, refusedEmptySupersede: refuseEmptySupersede, degradedRows, staleMarkerHeld };
}
