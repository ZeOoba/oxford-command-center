import type { PortfolioSnapshot, DataQualityFlag } from '../src/contracts/index';
import { isInvestmentProperty } from '../src/analytics/property-basis';
import { findDuplicateDealRows, keyDigest } from './sources/deal-name';
import { DEBT_BASIS_FIELD, investmentLoanBalance, isAffiliateBorrowerLoan, isAffiliateNoteProperty } from '../src/analytics/debt-basis';
import { buildLoanPropertyMap } from './warehouse/property-crosswalk';


/**
 * In-process reconciliation (Phase 6, §10). Runs on every brain.refresh() and verifies the
 * snapshot's internal invariants — no second workbook read. Any breach becomes a DataQualityFlag
 * on the snapshot so the UI can show a degraded state and downgrade provenance, rather than
 * silently serving inconsistent numbers. The workbook-total-cell cross-checks (NOI/value/rent) ARE
 * covered here too, at zero extra I/O cost: parse.ts captures those cells into
 * snapshot.workbookTotals during its single read, so this only compares numbers already on the
 * snapshot. scripts/reconcile.ts (the CI gate) still does its own fully independent second read of
 * the raw workbook as a from-scratch cross-check — deliberate defense in depth, not redundant dead
 * code; the two are allowed to diverge in *how* they source the workbook total without either one
 * being wrong.
 */
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// Materiality threshold for the unresolved-lease-rent check below: a RELATIVE share, unlike the
// small absolute-dollar tolerances the other reconciliation checks in this file use for
// float-rounding noise -- deliberately, since this aggregates missing rows rather than rounding
// drift and a fixed dollar amount wouldn't scale with portfolio size.
const UNRESOLVED_RENT_SHARE_THRESHOLD = 0.01;

/**
 * True when a snapshot carries an error-severity reconciliation flag — i.e. it is internally
 * inconsistent and must not be PUBLISHED, whatever it is safe to serve in memory.
 *
 * Lives here, beside checkSnapshot, because there are FOUR publication paths and PR #252 wired the
 * policy into only two of them (the CLI writers) by inlining a severity filter. Brain.persist and
 * scripts/bake-mirror.ts were left ungated, so every live-server refresh republished exactly the
 * inconsistencies those writers refuse, to a git-tracked mirror that is auto-committed and pushed
 * off-machine. One exported predicate so a fifth writer cannot quietly disagree about what
 * "publishable" means. (Catch-up sweep 2026-07-28..08-04, H2.)
 */
export function hasReconciliationError(flags: readonly DataQualityFlag[]): boolean {
  return flags.some((f) => f.severity === 'error' && f.entity === 'reconciliation');
}

// Absolute-dollar rounding tolerance shared by every cash check in this file (float noise between
// the workbook's summary cells and its own history matrix), matching the totalCash check below.
const CASH_TOLERANCE = 2;
// Estimated-history-row heuristic (see checkCashInvariants): at least this many changed balances,
// and at least half of them, sitting on a whole multiple of this unit.
const ESTIMATE_ROUND_UNIT = 500;
const ESTIMATE_MIN_ROUND = 3;

/**
 * Date-aware and value-level cash invariants (2026-09-14 financial-code sweep). Exported on its
 * own, and called from checkSnapshot below, because scripts/reconcile.ts (the workbook-backed CI
 * gate) prints these as its own PASS/WARN/FAIL rows -- it re-reads the workbook for the dollar
 * totals it cross-checks, but these assertions are about the SNAPSHOT's own history array and
 * entity fields, which only exist parsed, so a second implementation there would just be a copy
 * that can drift. One detector, two reachable call sites (same doctrine as findDuplicateDealRows).
 *
 * What it closes, found live in the committed snapshot:
 *  - cash.asOf read 2026-09-10 while cash.history's last row was 2026-07-10, and that July slot's
 *    total was bit-identical to the September headline -- a clobbered history slot. The only
 *    history check then in force ("latest point = current total") PASSED on exactly that shape,
 *    because the clobber is what made them equal. The two missing rows (08-10, 09-10) are a
 *    workbook problem for a human; nothing here backfills them.
 *  - two entities carried a percent whose sign contradicted its own dollar figure (deltaDollar
 *    -REDACTED-AMT beside deltaPct +4.1%; growth12Dollar +REDACTED-AMT beside growth12Pct -1186%), because the
 *    workbook's percent cell divides by a NEGATIVE prior/12-month balance. parse.ts now recomputes
 *    both and emits null over a wrong-signed number; this is the backstop over whatever actually
 *    sits on the snapshot (a legacy bake, a hand-edit, a future parser regression).
 *  - an entity's maxAllTime sat below its own currentBalance (a stale summary cell). Warn only --
 *    recomputing min/max from the history matrix was ruled out of scope for this fix.
 *
 * Severity: 'error' ONLY for cash.asOf later than meta.generatedAt, which is a structural
 * impossibility (data cannot be as-of a date after the snapshot that carries it was built), never a
 * business event. Everything else is 'warn' -- each has a legitimate, if unlikely, explanation, and
 * the house style (see server/anomaly-floor.ts) is to report a plausible business event, not refuse it.
 * Null-tolerant on every field: legacy fixtures and older bakes may lack history, asOf, or meta.
 */
export function checkCashInvariants(s: Pick<PortfolioSnapshot, 'cash' | 'meta'>): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  const flag = (field: string, issue: string, severity: DataQualityFlag['severity'] = 'warn') =>
    flags.push({ entity: 'reconciliation', field, issue, severity });

  // generatedAt is a full ISO timestamp; asOf may be a bare YYYY-MM-DD. Compare on the date portion
  // only, so a bare date is never read as "midnight, before the timestamp on the same day".
  const asOf = s.cash?.asOf;
  const generatedAt = s.meta?.generatedAt;
  if (asOf && generatedAt && asOf.slice(0, 10) > generatedAt.slice(0, 10)) {
    flag('cash.asOf', `cash as-of ${asOf.slice(0, 10)} is later than the snapshot's own generatedAt ${generatedAt.slice(0, 10)}`, 'error');
  }

  const history = s.cash?.history ?? [];
  const latest = history.at(-1);
  if (asOf && latest?.date !== undefined && latest.date !== asOf) {
    flag('cash.history.date', `latest history row is dated ${latest.date} but cash as-of is ${asOf} — the history matrix is missing the rows between, or the as-of dateline outran it`);
  }
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const cur = history[i]!;
    if (prev.total === cur.total) {
      flag('cash.history.total', `history rows ${prev.date} and ${cur.date} carry the identical total ${Math.round(cur.total)} — a clobbered slot reads exactly like this`);
    }
    // Estimated-row signature (2026-09-25): a 2026-07-10 row was keyed from estimates, most changed
    // balances whole multiples of $500 (4,500,000 / 1,500,000 / 220,000 ...). Bank-statement balances
    // almost never land there. Only CHANGED entities count: a dormant account carried forward is normal.
    const prevBal = prev.balances;
    const curBal = cur.balances;
    if (prevBal && curBal) {
      const changed = Object.keys(curBal).filter((k) => curBal[k] !== prevBal[k]);
      const round = changed.filter((k) => curBal[k]! !== 0 && curBal[k]! % ESTIMATE_ROUND_UNIT === 0);
      if (round.length >= ESTIMATE_MIN_ROUND && round.length * 2 >= changed.length) {
        flag('cash.history.estimated', `history row ${cur.date}: ${round.length} of ${changed.length} changed balances are whole multiples of $${ESTIMATE_ROUND_UNIT} (${round.join(', ')}) — looks estimated, not statement balances`);
      }
    }
  }

  for (const e of s.cash?.entities ?? []) {
    // A dollar move and its own percent must not point in opposite directions. A zero on either side
    // has no sign to disagree with, and a null percent is the parser's "verified null" -- both silent.
    const signMismatch = (dollar: number | null | undefined, pct: number | null | undefined) =>
      dollar != null && pct != null && dollar !== 0 && pct !== 0 && Math.sign(dollar) !== Math.sign(pct);
    if (signMismatch(e.deltaDollar, e.deltaPct)) {
      flag('cash.entities.deltaPct', `${e.id}: deltaDollar ${Math.round(e.deltaDollar!)} and deltaPct ${e.deltaPct} disagree in sign`);
    }
    if (signMismatch(e.growth12Dollar, e.growth12Pct)) {
      flag('cash.entities.growth12Pct', `${e.id}: growth12Dollar ${Math.round(e.growth12Dollar!)} and growth12Pct ${e.growth12Pct} disagree in sign`);
    }
    if (e.maxAllTime != null && e.maxAllTime < e.currentBalance - CASH_TOLERANCE) {
      flag('cash.entities.maxAllTime', `${e.id}: maxAllTime ${Math.round(e.maxAllTime)} is below the current balance ${Math.round(e.currentBalance)} — the all-time summary cell is stale`);
    }
    if (e.minAllTime != null && e.minAllTime > e.currentBalance + CASH_TOLERANCE) {
      flag('cash.entities.minAllTime', `${e.id}: minAllTime ${Math.round(e.minAllTime)} is above the current balance ${Math.round(e.currentBalance)} — the all-time summary cell is stale`);
    }
  }

  return flags;
}

const STALE_LEASE_ROW_DAYS = 365;

/**
 * Flags a workbook lease row whose status never got updated: any row NOT marked Expired whose
 * leaseEnd passed more than STALE_LEASE_ROW_DAYS ago (as of meta.asOf). Such a row keeps inflating
 * Calendar + Renewals long after the tenancy actually ended. Rows already marked Expired are skipped
 * — the workbook is right about those. Warn so a human fixes the workbook; nothing here edits or
 * hides the row.
 *
 * entity is 'lease', deliberately NOT 'reconciliation': src/analytics/conditions.ts fires a
 * CRITICAL "Reconciliation failure" insight and HealthModule turns the Reconciliation badge red for
 * ANY entity==='reconciliation' flag regardless of severity. This is a warn-level data-quality
 * hint, so it belongs in the Data Quality card only (which lists every flag) — 2026-09-23 PR-1 review.
 */
export function checkStaleLeaseRows(s: Pick<PortfolioSnapshot, 'leases' | 'meta'>): DataQualityFlag[] {
  const asOf = s.meta?.asOf;
  if (!asOf) return [];
  const asOfMs = Date.parse(asOf.slice(0, 10));
  const out: DataQualityFlag[] = [];
  for (const l of s.leases ?? []) {
    if (l.status === 'Expired' || !l.leaseEnd) continue;
    // Date-only on both sides: a time component on leaseEnd would otherwise shift the parsed
    // instant relative to the date-only asOf and move the rounded day count by one.
    const days = Math.round((asOfMs - Date.parse(l.leaseEnd.slice(0, 10))) / 86_400_000);
    if (days > STALE_LEASE_ROW_DAYS) {
      out.push({
        entity: 'lease',
        field: `lease.${l.id}.leaseEnd`,
        issue: `${l.tenantName} ended ${l.leaseEnd} (${days}d ago) but is still "${l.status}" — retire the row in the workbook or record the renewal`,
        severity: 'warn',
      });
    }
  }
  return out;
}

// Absolute-dollar tolerance PER ROW for the debt-basis cross-check below. Two independently-typed
// workbook figures for the same loan can differ by a few dollars of accrual timing; anything past
// this is a share-basis difference or a loan present in one source and not the other.
const DEBT_BASIS_TOLERANCE = 1000;

/**
 * Overview "Total Debt" (property loan balances, Property NOI sheet) vs Capital › Debt "External
 * Debt" (third-party borrower loans, loan schedule), compared ROW BY ROW (item 14, 2026-09-24) so
 * the Data Quality card names the property or loan that disagrees instead of one unexplained net
 * gap (round 1 showed "$REDACTED-AMT" with no row to fix).
 *
 * Same basis as both surfaces, by construction:
 *  - investment rows only (the residence is other holdings — isInvestmentProperty);
 *  - Oxford-affiliate notes excluded on BOTH sides (src/analytics/debt-basis.ts — ratified
 *    2026-09-24): a property row whose lender is an affiliate contributes 0, an affiliate
 *    borrower loan is skipped; a loan collateralised by a non-investment row (the residence) is
 *    counted in Capital › Debt External Debt (engine.ts debtSummary sums every third-party borrower
 *    loan) but NOT in Overview Total Debt — it is disclosed as its own `.loan.<id>` flag rather than
 *    silently dropped (refute wf_2b574580-61b).
 * Loans are attributed with the SAME resolver the warehouse snapshot writer uses
 * (buildLoanPropertyMap: exact normalized name → slug → alias; ambiguous/blank = unresolved, never
 * guessed). Loan-schedule rows sharing an id are flagged once and excluded from attribution, sums
 * and the unresolved loop (no last-writer-wins). Integer cents per loan so the $1,000 boundary is
 * order-independent (refute wf_fb49dbb9-c91).
 *
 * Bound: the per-row tolerance can mask at most rows × tolerance of net gap; that residue is caught
 * in aggregate by one root flag (field exactly DEBT_BASIS_FIELD) when |Σ property − Σ schedule|
 * over investment rows exceeds the tolerance without any single row doing so.
 *
 * Affiliate totals (ratified 2026-09-26): the property-row affiliate sum (PortfolioKpis.affiliateDebt)
 * and the loan-schedule affiliate sum (DebtSummary.affiliateDebt) come from different spines and
 * legitimately differ on live data (1100 Rarig's note to Oxford Capital sits only on the property
 * row; "3883 from Oxford (50%)" sits only on the loan schedule). Both disclosures stay as built; the
 * gap is surfaced as ONE extra warn flag (`debt.basis.affiliate`) past the same tolerance.
 *
 * entity is 'debt', deliberately NOT 'reconciliation' — see checkStaleLeaseRows: an
 * entity==='reconciliation' flag is a reconciliation failure. These are warn-level basis notes; the
 * Health Reconciliation card lists them via isDebtBasisFlag (src/modules/health/reconciliation-card.ts).
 */
export function checkDebtBasis(s: Pick<PortfolioSnapshot, 'properties' | 'loans'>): DataQualityFlag[] {
  const allProps = s.properties ?? [];
  const allLoans = s.loans ?? [];
  const investment = allProps.filter(isInvestmentProperty);
  const investmentIds = new Set(investment.map((p) => p.id));
  const thirdPartyAll = allLoans.filter((l) => l.direction === 'borrower' && !isAffiliateBorrowerLoan(l));

  const cents = (n: number): number => Math.round(n * 100);
  const tol = DEBT_BASIS_TOLERANCE * 100;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`; // pinned: CI's ICU default may not group

  const flags: DataQualityFlag[] = [];

  // Duplicate ids: buildLoanPropertyMap keys by loan id, so two rows sharing one would collapse to
  // whichever came last. Flag once, exclude all rows carrying that id, keep the output order-free.
  const idCount = new Map<string, number>();
  for (const l of thirdPartyAll) idCount.set(l.id, (idCount.get(l.id) ?? 0) + 1);
  for (const [id, n] of [...idCount].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (n < 2) continue;
    flags.push({ entity: 'debt', field: `${DEBT_BASIS_FIELD}.loan.${id}`, issue: `${n} loan-schedule rows share id ${id} — not compared`, severity: 'warn' });
  }
  const thirdParty = thirdPartyAll.filter((l) => idCount.get(l.id) === 1);
  const { map, unresolved } = buildLoanPropertyMap(thirdParty, allProps, new Set(allProps.map((p) => p.id)));
  const propById = new Map(allProps.map((p) => [p.id, p]));

  const loanCents = new Map<string, number>();
  const loanNames = new Map<string, string[]>();
  for (const l of thirdParty) {
    const pid = map.get(l.id);
    if (pid === undefined) continue; // unresolved — listed below
    if (!investmentIds.has(pid)) {
      // Other-holdings collateral: inside External Debt, outside Overview Total Debt.
      flags.push({
        entity: 'debt',
        field: `${DEBT_BASIS_FIELD}.loan.${l.id}`,
        issue:
          `${l.name}: ${usd(l.absBalance ?? 0)} on the loan schedule is counted in Capital › Debt External Debt ` +
          `but outside Overview Total Debt (other holding: ${propById.get(pid)?.name ?? pid})`,
        severity: 'warn',
      });
      continue;
    }
    loanCents.set(pid, (loanCents.get(pid) ?? 0) + cents(l.absBalance ?? 0));
    loanNames.set(pid, [...(loanNames.get(pid) ?? []), l.name]);
  }

  let sumPropCents = 0;
  let sumSchedCents = 0;
  let rowFlagged = false;
  for (const p of investment) {
    const propCents = cents(investmentLoanBalance(p));
    const schedCents = loanCents.get(p.id) ?? 0;
    sumPropCents += propCents;
    sumSchedCents += schedCents;
    const gap = propCents - schedCents;
    if (Math.abs(gap) <= tol) continue;
    rowFlagged = true;
    const names = loanNames.get(p.id);
    flags.push({
      entity: 'debt',
      field: `${DEBT_BASIS_FIELD}.property.${p.id}`,
      issue:
        `${p.name}: Property NOI sheet loan balance ${usd(propCents / 100)} vs loan schedule ${usd(schedCents / 100)} ` +
        `${names ? `(${names.join(', ')})` : '(no third-party loan attributed)'} — gap ${usd(Math.abs(gap) / 100)}`,
      severity: 'warn',
    });
  }
  const byId = new Map(thirdParty.map((l) => [l.id, l]));
  for (const id of unresolved) {
    const l = byId.get(id);
    if (!l || cents(l.absBalance ?? 0) <= tol) continue;
    flags.push({
      entity: 'debt',
      field: `${DEBT_BASIS_FIELD}.loan.${l.id}`,
      issue: `${l.name}: ${usd(l.absBalance)} on the loan schedule is not attributed to any property row (collateral ${l.collateralProperty ? `"${l.collateralProperty}"` : 'blank'})`,
      severity: 'warn',
    });
  }

  // Aggregate guard: sub-tolerance residues across rows can add up past the tolerance. Only when no
  // row was flagged — a flagged row already names the gap, and a second flag would double-count it.
  const aggGap = sumPropCents - sumSchedCents;
  if (!rowFlagged && Math.abs(aggGap) > tol) {
    flags.push({
      entity: 'debt',
      field: DEBT_BASIS_FIELD,
      issue:
        `Overview Total Debt (Σ investment-row loan balances, Property NOI sheet) ${usd(sumPropCents / 100)} vs ` +
        `Σ attributed third-party loans (loan schedule) ${usd(sumSchedCents / 100)} — gap ${usd(Math.abs(aggGap) / 100)} ` +
        `(no single row exceeds the ${usd(DEBT_BASIS_TOLERANCE)} per-row tolerance)`,
      severity: 'warn',
    });
  }

  // Affiliate totals, same sums as engine.ts portfolioKpis.affiliateDebt / debtSummary.affiliateDebt.
  let affPropCents = 0;
  for (const p of investment) if (isAffiliateNoteProperty(p)) affPropCents += cents(p.loanBalance ?? 0);
  let affLoanCents = 0;
  for (const l of allLoans) if (isAffiliateBorrowerLoan(l)) affLoanCents += cents(l.absBalance ?? 0);
  const affGap = affPropCents - affLoanCents;
  if (Math.abs(affGap) > tol) {
    flags.push({
      entity: 'debt',
      field: `${DEBT_BASIS_FIELD}.affiliate`,
      issue:
        `Affiliate notes: Property NOI sheet ${usd(affPropCents / 100)} (rows with an Oxford-affiliate lender) ` +
        `vs loan schedule ${usd(affLoanCents / 100)} (affiliate borrower loans) — gap ${usd(Math.abs(affGap) / 100)}`,
      severity: 'warn',
    });
  }
  return flags;
}

export function checkSnapshot(s: PortfolioSnapshot): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  const flag = (field: string, issue: string, severity: DataQualityFlag['severity'] = 'error') =>
    flags.push({ entity: 'reconciliation', field, issue, severity });

  // Cash total must equal the sum of entity balances.
  const cashSum = sum(s.cash.entities.map((e) => e.currentBalance));
  if (Math.abs(cashSum - s.cash.totalCash) > CASH_TOLERANCE) {
    flag('cash.totalCash', `total ${Math.round(s.cash.totalCash)} ≠ Σ entities ${Math.round(cashSum)}`);
  }

  // Annualized rent must equal Σ(monthly × 12).
  const annual = sum(s.leases.map((l) => l.annualRent));
  const monthlyX12 = sum(s.leases.map((l) => l.monthlyRent * 12));
  if (Math.abs(annual - monthlyX12) > 5) {
    flag('leases.annualRent', `Σ annual ${Math.round(annual)} ≠ Σ(monthly×12) ${Math.round(monthlyX12)}`, 'warn');
  }

  // Cash history's own latest snapshot must agree with the current total (a stale/misordered
  // history array would otherwise show a chart that silently disagrees with the headline number).
  const cashHistoryLatest = s.cash.history?.at(-1)?.total;
  if (cashHistoryLatest !== undefined && Math.abs(cashHistoryLatest - s.cash.totalCash) > CASH_TOLERANCE) {
    flag(
      'cash.history',
      `latest history point ${Math.round(cashHistoryLatest)} ≠ current total ${Math.round(s.cash.totalCash)}`,
    );
  }
  // The check above is value-only and is satisfied by the exact failure it should catch: a history
  // slot clobbered with the current total agrees with the headline BECAUSE it was clobbered. The
  // date-aware and per-entity companions live in checkCashInvariants (see its doc comment).
  flags.push(...checkCashInvariants(s));
  flags.push(...checkStaleLeaseRows(s));
  flags.push(...checkDebtBasis(s));

  // Derived totals must agree with the workbook's own declared "Portfolio Total" row (per-field:
  // null means the workbook had no such row, e.g. a legacy fixture -- skip rather than false-flag).
  const wt = s.workbookTotals;
  if (wt?.noi != null) {
    const noiSum = sum(s.properties.map((p) => p.noi));
    if (Math.abs(wt.noi - noiSum) > 1) {
      flag('properties.noi', `Σ property NOI ${Math.round(noiSum)} ≠ workbook total ${Math.round(wt.noi)}`);
    }
  }
  if (wt?.value != null) {
    const valueSum = sum(s.properties.map((p) => p.oxfordValue));
    if (Math.abs(wt.value - valueSum) > 1) {
      flag('properties.oxfordValue', `Σ Oxford value ${Math.round(valueSum)} ≠ workbook total ${Math.round(wt.value)}`);
    }
  }
  if (wt?.rent != null) {
    if (Math.abs(wt.rent - annual) > 1) {
      flag('leases.annualRent', `Σ annual rent ${Math.round(annual)} ≠ workbook total ${Math.round(wt.rent)}`);
    }
  }

  // Leases that never resolved to a property (parse.ts flags each row individually at 'warn')
  // are excluded from every per-property leasing metric — WALT, the expiration schedule,
  // Capital Allocation's leasing-risk component — with propertyId:null reading identically to
  // "no data" rather than "unresolved data". A single stray row is a curiosity; a MATERIAL
  // share of total rent going unresolved means a whole property's leasing input is silently
  // empty (reproduced: 41/138 leases, $1.14M — the largest-NOI property resolved zero leases).
  // 1% catches that class while tolerating the handful of legitimately-unmapped rows a live
  // workbook can carry without false-flagging every routine snapshot.
  if (wt?.rent != null && wt.rent > 0) {
    const unresolvedRent = sum(
      s.leases.filter((l) => l.propertyId === null).map((l) => l.annualRent),
    );
    const unresolvedShare = unresolvedRent / wt.rent;
    if (unresolvedShare > UNRESOLVED_RENT_SHARE_THRESHOLD) {
      flag(
        'leases.propertyId',
        `${(unresolvedShare * 100).toFixed(1)}% of rent ($${Math.round(unresolvedRent).toLocaleString()}) is on leases that never resolved to a property — excluded from every per-property leasing metric`,
      );
    }
  }

  // Core entity sets must be non-empty (a parse that silently emptied a sheet).
  if (s.properties.length === 0) flag('properties', 'no properties parsed');
  if (s.leases.length === 0) flag('leases', 'no leases parsed');

  // Property.id is the join key for capital-allocation, debt-scoring, and the warehouse
  // crosswalk — duplicates would silently shadow a property in any id-keyed Map/Set.
  // parse.ts disambiguates at parse time; this is the always-on backstop.
  const propIds = s.properties.map((p) => p.id);
  if (new Set(propIds).size !== propIds.length) {
    const dupes = [...new Set(propIds.filter((id, i) => propIds.indexOf(id) !== i))];
    flag('properties.id', `duplicate property id(s): ${dupes.join(', ')}`);
  }

  // Deal.notionDealId must not repeat — same shape as properties.id above, and cheap: Notion's
  // Unique ID cannot duplicate at the source, so a repeat here means the seed mirror, a merge
  // conflict, or a hand-edit is wrong, not that two live rows collided.
  const dealIds = s.deals.map((d) => d.notionDealId).filter((id): id is string => id !== null);
  if (new Set(dealIds).size !== dealIds.length) {
    const dupes = [...new Set(dealIds.filter((id, i) => dealIds.indexOf(id) !== i))];
    flag('deals.notionDealId', `duplicate deal Deal ID(s): ${dupes.join(', ')}`);
  }

  // Deal rows must not near-duplicate each other by NAME either — restored 2026-08-13 (code
  // review). This stood here as findNearDuplicateNames until 2026-08-12, when it was retired on
  // the argument that mergeDeals' migration tripwire replaced it. That argument covered the
  // WRONG PATH: checkSnapshot also runs over the COMMITTED snapshot via
  // scripts/reconcile-snapshot.ts's `npm run gate:ci` — zero Notion I/O, zero call into
  // mergeDeals — which exists PRECISELY to catch corruption independent of how the file was
  // produced (its own header cites the 2026-08-03 phantom-vacancy-lease incident that shipped
  // under an identical blind spot). A merge conflict or a hand-edit introducing two rows for one
  // deal is invisible to mergeDeals because it never runs, and was invisible here too until this
  // line. findDuplicateDealRows is the SAME function mergeDeals calls over its own output
  // (server/sources/deal-name.ts) — one detector, two reachable call sites, so "same deal" is
  // judged identically in both rather than by two implementations that can drift.
  //
  // NAMES NEVER APPEAR IN THE FLAG TEXT — this function has no console.warn to log them to
  // locally (unlike mergeDeals, checkSnapshot is a pure function), and these flags reach the same
  // unswept public payload. Reference rows by Deal ID (opaque, already published elsewhere) where
  // one exists; keyDigest covers the case where it doesn't.
  for (const { key, rows } of findDuplicateDealRows(s.deals)) {
    // The CI path's primary target is a merge conflict or hand-edit duplicating a row VERBATIM —
    // same or both-null Deal ID — where "carry different Deal IDs" would be false and the
    // locality-tail remedy inapplicable (there is nothing to distinguish; the snapshot itself is
    // corrupted). Distinguish that case explicitly rather than asserting distinctness this check
    // never verified. (Code review, 2026-08-13 — the edge lens caught this in the text I'd just
    // written for the restoration above.)
    const ids = rows.map((r) => r.notionDealId ?? keyDigest(r.id));
    const distinctIds = new Set(ids).size > 1;
    flag(
      'deals.name',
      `${rows.length} deal row(s) share one normalized name` +
        (distinctIds
          ? ` but carry different Deal IDs — ${ids.join(', ')} (name digest ${keyDigest(key)}). One ` +
            `deal may be presented twice with disagreeing economics or redaction; if these are ` +
            `genuinely different assets sharing a bare street name, give each a "— City, ST" ` +
            `locality tail naming a DIFFERENT STATE in Notion — same-state tails do not distinguish ` +
            `them here.`
          : ` and the SAME Deal ID (${ids[0]}, name digest ${keyDigest(key)}) — this looks like the ` +
            `same row duplicated verbatim, not two deals. The likely cause is a merge conflict or a ` +
            `hand-edit to the committed snapshot; restore it from the last good bake rather than ` +
            `editing Notion.`),
    );
  }

  // Relationship-graph edges must resolve to real nodes.
  const ids = {
    property: new Set(s.properties.map((p) => p.id)),
    loan: new Set(s.loans.map((l) => l.id)),
    deal: new Set(s.deals.map((d) => d.id)),
    insurance: new Set(s.insurance.map((i) => i.id)),
  };
  let dangling = 0;
  for (const cp of s.counterparties) {
    dangling += cp.links.properties.filter((id) => !ids.property.has(id)).length;
    dangling += cp.links.loans.filter((id) => !ids.loan.has(id)).length;
    dangling += cp.links.deals.filter((id) => !ids.deal.has(id)).length;
    dangling += cp.links.insurance.filter((id) => !ids.insurance.has(id)).length;
  }
  if (dangling > 0) flag('counterparties.links', `${dangling} dangling relationship edge(s)`, 'warn');

  return flags;
}
