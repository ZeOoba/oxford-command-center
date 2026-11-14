// server/property-financials/insurance-ledger.ts
//
// Insurance tracker (snapshot.insurance) vs the PF cash-basis ledger (dataset.monthly[entity][month]
// .opex_by.Insurance). Two checks a manual review of the per-property reports performed by hand and nothing
// in the repo computes (server/warehouse/insurance-conditions.ts compares tracker to warehouse DATES only,
// never to ledger postings):
//
//   stale-tracker  The tracker says Expired/Cancelled, but the ledger posted a premium-sized amount in or
//                  after the expiry month (a renewal lump), or keeps paying monthly installments after it.
//                  Likely renewed and not logged. This is a COMPANION info alert: it never suppresses the
//                  critical lapse alert, which stays until a binder is on file.
//   excess-ledger  Trailing-12-month ledger insurance is >= 1.5x the tracker's total annual premium and
//                  >= $2K over (for example two identical annual postings in one window).
//
// Guards:
//   - A lapsed line that a LATER-expiring non-lapsed line of the same coverage family at the same location
//     replaces is skipped (a carrier swap, not a stale tracker).
//   - The excess denominator is the tracker total across ALL lines at the location, lapsed included, so a
//     mid-year swap with two policies in one window is not read as a double payment.
//   - Locations with no PF monthly ledger (annual-only entities, or locations not in the PF dataset) return
//     n/m with a reason - never silently clean.
//   - Stale-tracker evidence is the UNEXPLAINED remainder: postings a live line accounts for (premium/12 a month
//     at a location that already pays monthly; otherwise its premium once per payment window in the span) and
//     renewals paid in advance of the next term are subtracted first. Both branches use that remainder.
//   - Advance renewals (excess check). The rule depends on how many DISTINCT expiry months the live, premium-
//     bearing lines ahead of the ledger have:
//     A future-effective renewal row logged early beside the current row, or any successor version of a
//     same-family line, is collapsed into that line first and adds no term (see liveTermsAhead).
//       0 or 1 (a single line, or every line on one term): a renewal paid in the 1-2 months before that expiry
//         month belongs to the next term and is excluded, capped at the pooled premium of that month; at a
//         monthly payer only the amount above the location's monthly run rate. A finding is a 'warning' with
//         its dollar excess.
//       2 or more (staggered terms): nothing is excluded. If the ratio still crosses the threshold the finding
//         is 'info' for review and carries NO dollar impact.
//     Known limit: at a staggered-term location an early renewal and a true duplicate cannot be told apart
//     from a per-location cash ledger, so those findings are info for review rather than a warning.
//   - A $0-premium line (evidence-of-insurance for a tenant-insured building) has nothing to test against.
//
// Cash basis: premium timing is lumpy; every finding is a "confirm", never a conclusion. Read-only.
import type { Insight } from '../../src/analytics/types';
import type { PfDataset } from '../../src/contracts/property-financials';
import { resolveInsuranceProperty } from '../warehouse/insurance-property-map';
import { CROSSCHECK_THRESHOLDS } from './crosscheck-config';
import { ENTITY_TO_CANONICAL } from './mapping';

const EPS = 1e-9;
/** Installment pattern: at least this many of the entity's last 12 ledger months carry an insurance posting. */
const INSTALLMENT_MIN_MONTHS = 6;
/** ...and at least this many separate months of postings must follow the expiry month (one is a final payment in arrears). */
const INSTALLMENT_MIN_AFTER = 2;

export interface LedgerPolicy {
  id: string;
  coverage: string;
  status: string;
  effective: string | null;
  /** ISO date (YYYY-MM-DD); null when the tracker cell is blank (the contract allows it). */
  expires: string | null;
  premium: number | null;
}

type Cube = Pick<PfDataset, 'monthly'>['monthly'];
type Thresholds = Pick<typeof CROSSCHECK_THRESHOLDS, 'insuranceDoublePayRatio' | 'insuranceMinExcessUsd' | 'insuranceRenewalShare'>;

export type InsuranceLedgerKind = 'stale-tracker' | 'excess-ledger' | 'ok' | 'n/m';

export interface InsuranceLedgerRow {
  /** PF entity label when resolved, else the policy-key stem. */
  entity: string;
  kind: InsuranceLedgerKind;
  reason: string | null;
  /** stale-tracker */
  evidence: 'renewal-lump' | 'installments' | null;
  lapsedExpires: string | null;
  lapsedPremium: number | null;
  posted: number | null;
  postedMonths: string[];
  /** excess-ledger */
  ledgerT12: number | null;
  trackerPremium: number | null;
  ratio: number | null;
  excess: number | null;
  /** excess-ledger: two or more live expiry months ahead of the ledger, so no advance renewal was excluded and
   *  the finding is info for review with no dollar impact. */
  staggeredTerms: boolean;
}

const blank = (entity: string, kind: InsuranceLedgerKind, reason: string | null = null): InsuranceLedgerRow => ({
  entity, kind, reason, evidence: null, lapsedExpires: null, lapsedPremium: null, posted: null, postedMonths: [],
  ledgerT12: null, trackerPremium: null, ratio: null, excess: null, staggeredTerms: false,
});

const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const isLapsed = (status: string) => /^(expired|cancell?ed)$/i.test(status.trim());
/** Liability-type lines (GL, BCL, umbrella, EPLI) vs property/package lines: a replacement must be the same family. */
const coverageFamily = (coverage: string | null | undefined): 'liability' | 'property' =>
  /umbrella|\bexcess\b(?!\s+(?:flood|of\s+loss))|epli|liabil|\bgl\b(?!\))|\bbcl\b|catastrophe/i.test(coverage ?? '') ? 'liability' : 'property';
const stemOf = (id: string) => /^ins-([a-z0-9]+)-/.exec(id)?.[1] ?? id;

/** The 12 calendar months ending at `last` (YYYY-MM), oldest first. */
function trailingMonths(last: string, n = 12): string[] {
  const [y, m] = last.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const t = y * 12 + (m - 1) - (n - 1 - i);
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

const monthIdx = (ym: string): number => Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
const idxMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/** Monthly payer: at least 4 of the 6 months before `month` (YYYY-MM) carry an insurance posting. */
function paysMonthlyBefore(month: string, ins: (m: string) => number): boolean {
  const before6 = Array.from({ length: 6 }, (_, i) => idxMonth(monthIdx(month) - 1 - i));
  return before6.filter((m) => ins(m) > 0).length >= 4;
}

/**
 * Pooled premium of the live, premium-bearing lines per expiry month (YYYY-MM) still ahead of the ledger
 * (month granularity, so same-month/different-day expiries are one term). Two or more keys = staggered terms.
 *
 * Successor versions are collapsed first, so a renewal row logged early beside the current row does not make a
 * single policy look like staggered terms:
 *   - a line whose effective month is after the last ledger month (a future-effective renewal row) is ignored;
 *   - a line is the next term of another counted line of the same coverage family when that line's expiry month
 *     is at or before this line's effective month, and adds no term of its own.
 */
function liveTermsAhead(live: readonly LedgerPolicy[], lastLedger: string): Map<string, number> {
  const ym = (d: string | null) => (typeof d === 'string' && d.length >= 7 ? d.slice(0, 7) : null);
  const ahead = live.filter((l) => {
    const em = ym(l.expires);
    const eff = ym(l.effective);
    return (l.premium ?? 0) > 0 && em !== null && em > lastLedger && !(eff !== null && eff > lastLedger);
  });
  const terms = new Map<string, number>();
  for (const l of ahead) {
    const eff = ym(l.effective);
    const successor =
      eff !== null &&
      ahead.some((c) => c !== l && coverageFamily(c.coverage) === coverageFamily(l.coverage) && ym(c.expires)! <= eff);
    if (successor) continue;
    const em = ym(l.expires)!;
    terms.set(em, (terms.get(em) ?? 0) + (l.premium ?? 0));
  }
  return terms;
}

/**
 * Advance renewal for a SINGLE live expiry month `em` (never called at staggered-term locations): a renewal
 * paid in [em-2, em-1] belongs to the NEXT term, so up to `cap` (the pooled premium of that month) is not
 * counted against this term's tracker premium. A second renewal-sized posting (a genuine duplicate) is beyond
 * the cap and still counts.
 *
 * Monthly payers: where the location pays monthly before `em` (the same >= 4-of-6 test as the stale-tracker
 * branch), only the part of a window month ABOVE the location's monthly run rate is excludable, so the
 * installments always stay in the trailing 12 and a genuine monthly over-payment is still flagged. The run rate
 * is the LOWER median of the non-zero postings in the window: lump months sit above it, so up to half the
 * posting months may carry lumps without inflating it.
 */
function advanceExclusion(em: string, cap: number, window: readonly string[], ins: (m: string) => number): number {
  const inWindow = new Set(window);
  const nonZero = window.map(ins).filter((v) => v > 0).sort((a, b) => a - b);
  const runRate = nonZero.length > 0 ? nonZero[Math.floor((nonZero.length - 1) / 2)]! : 0;
  const floor = paysMonthlyBefore(em, ins) ? runRate : 0;
  let excludable = 0;
  for (const back of [1, 2]) {
    const m = idxMonth(monthIdx(em) - back);
    if (inWindow.has(m)) excludable += Math.max(0, ins(m) - floor);
  }
  return Math.min(excludable, cap);
}

/**
 * Postings a LIVE line accounts for inside [from, to] (YYYY-MM), so only the remainder counts as evidence
 * about a lapsed line. A location that already pays monthly (>= 4 of the 6 months before the lapse posted)
 * spreads each live premium over the months (premium / 12 a month); an annual payer is credited its premium once
 * per payment window (the effective month, up to 2 months earlier, then every 12 months) that falls in the span.
 * A live line with no effective date is credited nothing: an annual premium paid before the lapse month
 * must not be charged against a later posting.
 */
function liveExplained(live: readonly LedgerPolicy[], from: string, to: string, paysMonthly: boolean, ins: (m: string) => number): number {
  const lo = monthIdx(from);
  const hi = monthIdx(to);
  const span = hi - lo + 1;
  let total = 0;
  for (const l of live) {
    const prem = l.premium ?? 0;
    if (prem <= 0) continue;
    if (paysMonthly) {
      total += (prem / 12) * span;
      continue;
    }
    if (typeof l.effective !== 'string' || l.effective.length < 7) continue;
    const eff = monthIdx(l.effective.slice(0, 7));
    for (let k = -3; k <= 3 + Math.ceil(span / 12); k++) {
      const end = eff + 12 * k;
      if (end < lo || end - 2 > hi) continue;
      // The part of this payment that was already posted BEFORE the span is not in the post-lapse postings.
      let before = 0;
      for (let m = end - 2; m < lo; m++) before += ins(idxMonth(m));
      total += Math.max(0, prem - before);
    }
  }
  return total;
}

/** Policy key -> PF entity label, via the ratified stem table and ENTITY_TO_CANONICAL (reversed). */
export function policyEntityResolver(): (policyId: string) => string | null {
  const names = new Map(Object.values(ENTITY_TO_CANONICAL).map((v) => [v.id, v.id] as const));
  const reverse = new Map(Object.entries(ENTITY_TO_CANONICAL).map(([entity, v]) => [v.id, entity] as const));
  return (policyId) => {
    const { propertyId } = resolveInsuranceProperty(policyId, names);
    return propertyId ? (reverse.get(propertyId) ?? null) : null;
  };
}

export function insuranceLedgerRows(
  policies: readonly LedgerPolicy[],
  monthly: Cube,
  resolveEntity: (policyId: string) => string | null,
  t: Thresholds = CROSSCHECK_THRESHOLDS,
): InsuranceLedgerRow[] {
  const groups = new Map<string, { entity: string | null; lines: LedgerPolicy[] }>();
  for (const p of policies) {
    const entity = resolveEntity(p.id);
    const key = entity ?? `~${stemOf(p.id)}`;
    const g = groups.get(key) ?? { entity, lines: [] };
    g.lines.push(p);
    groups.set(key, g);
  }

  const rows: InsuranceLedgerRow[] = [];
  for (const key of [...groups.keys()].sort()) {
    const { entity, lines } = groups.get(key)!;
    const label = entity ?? key.slice(1);
    const ledger = entity ? (monthly as Record<string, Record<string, { opex_by: { Insurance: number } }> | undefined>)[entity] : undefined;
    if (!entity || !ledger) {
      rows.push(blank(label, 'n/m', 'no PF monthly ledger for this location (annual-only or not in the PF dataset), so tracker premiums cannot be tied to postings'));
      continue;
    }
    const monthKeys = Object.keys(ledger).sort();
    if (monthKeys.length === 0) {
      rows.push(blank(label, 'n/m', 'the PF monthly ledger for this location holds no months'));
      continue;
    }
    const ins = (m: string) => ledger[m]?.opex_by.Insurance ?? 0;
    const found: InsuranceLedgerRow[] = [];

    // --- stale tracker ---------------------------------------------------
    const live = lines.filter((l) => !isLapsed(l.status));
    // A lapsed line with no expiry date cannot be placed in time, so it is left to the existing lapse alert.
    const lapsed = lines
      .filter((l) => isLapsed(l.status) && typeof l.expires === 'string' && l.expires.length >= 7)
      .filter((l) => !live.some((c) => typeof c.expires === 'string' && c.expires > l.expires! && coverageFamily(c.coverage) === coverageFamily(l.coverage)));
    if (lapsed.length > 0) {
      const expiryMonth = lapsed.map((l) => l.expires!.slice(0, 7)).sort()[0]!;
      const lapsedPremium = lapsed.reduce((s, l) => s + (l.premium ?? 0), 0);
      const lastMonth = monthKeys[monthKeys.length - 1]!;
      const onOrAfter = monthKeys.filter((m) => m >= expiryMonth && ins(m) > 0);
      const after = monthKeys.filter((m) => m > expiryMonth && ins(m) > 0);
      const posted = onOrAfter.reduce((s, m) => s + ins(m), 0);
      // Calendar window, like the excess check: the last 12 ledger months, not the last 12 that happen to exist.
      const last12 = trailingMonths(lastMonth);
      const paysMonthly = paysMonthlyBefore(expiryMonth, ins);
      const explained = liveExplained(live, expiryMonth, lastMonth, paysMonthly, ins);
      const residual = Math.max(0, posted - explained);
      // At a monthly payer, finance charges on a live line's installments leave a small remainder: it only counts
      // when it is most of what posts after the lapse.
      // Renewal premiums differ a few percent from the tracker's, so the remainder must also clear 10% of what the
      // live lines explain; and at a monthly payer it must be most of what posts after the lapse.
      const material = residual > 0.1 * explained + EPS && (!paysMonthly || residual >= 0.5 * posted - EPS);
      const enough = material && lapsedPremium > 0 && residual >= t.insuranceRenewalShare * lapsedPremium - EPS;
      // An installment pattern is sustained smaller postings: it needs most of what posts after the lapse to be
      // unexplained (finance charges on a live line's installments are not a stale tracker), not a lump.
      const installments =
        material && residual >= 0.5 * posted - EPS &&
        last12.filter((m) => ins(m) > 0).length >= INSTALLMENT_MIN_MONTHS && after.length >= INSTALLMENT_MIN_AFTER;
      const lump = enough && !installments;
      if (lump || installments) {
        found.push({
          ...blank(label, 'stale-tracker'),
          evidence: lump ? 'renewal-lump' : 'installments',
          lapsedExpires: lapsed.map((l) => l.expires!).sort()[0]!,
          lapsedPremium,
          posted: residual,
          postedMonths: lump ? onOrAfter : after,
        });
      }
    }

    // --- ledger excess ---------------------------------------------------
    // The window is 12 CALENDAR months ending at the latest ledger month. A month that is absent from the
    // cube AFTER the series starts is a gap in the data, not a $0 month: summing the 12 months that happen
    // to be present would stretch the window over 13+ months and read one annual premium paid twice.
    const trackerPremium = lines.reduce((s, l) => s + (l.premium ?? 0), 0);
    let excessSkipped: string | null = null;
    if (trackerPremium > 0) {
      const window = trailingMonths(monthKeys[monthKeys.length - 1]!);
      const first = monthKeys[0]!;
      const gaps = window.filter((m) => m > first && !(m in ledger));
      if (gaps.length > 0) {
        excessSkipped = `the PF ledger is missing month(s) ${gaps.join(', ')} inside the trailing 12, so ledger insurance cannot be totalled against the tracker premium`;
      } else {
        // One live expiry month: exclude its advance renewal (see advanceExclusion). Staggered terms (two or
        // more live expiry months): exclude nothing; any finding is info for review with no dollar impact,
        // because an early renewal of one line and a duplicate of another cannot be told apart. Known limit at
        // a single-expiry location: one duplicate of the current-term premium that lands inside the advance
        // window is indistinguishable from an advance renewal.
        const terms = [...liveTermsAhead(live, window[window.length - 1]!)];
        const staggeredTerms = terms.length >= 2;
        const excluded = terms.length === 1 ? advanceExclusion(terms[0]![0], terms[0]![1], window, ins) : 0;
        const ledgerT12 = window.reduce((s, m) => s + ins(m), 0) - excluded;
        const ratio = ledgerT12 / trackerPremium;
        const excess = ledgerT12 - trackerPremium;
        if (ratio >= t.insuranceDoublePayRatio - EPS && excess >= t.insuranceMinExcessUsd - EPS) {
          found.push({ ...blank(label, 'excess-ledger'), ledgerT12, trackerPremium, ratio, excess, staggeredTerms });
        }
      }
    }

    rows.push(...found);
    // Never silently clean: a skipped excess check is reported even when a stale-tracker finding coexists.
    if (excessSkipped) rows.push(blank(label, 'n/m', excessSkipped));
    else if (found.length === 0) rows.push(blank(label, 'ok'));
  }
  return rows;
}

/**
 * Insights for the findings only. `toCanonicalId` maps a PF entity label to the property id; an entity
 * with no canonical id is dropped rather than emitted unattributed.
 */
export function insuranceLedgerInsights(
  rows: readonly InsuranceLedgerRow[],
  toCanonicalId: (entity: string) => string | null,
  nameOf: (entityId: string, entity: string) => string = (_id, entity) => entity,
  ownOf: (entityId: string) => number = () => 1,
): Insight[] {
  const out: Insight[] = [];
  for (const r of rows) {
    if (r.kind !== 'stale-tracker' && r.kind !== 'excess-ledger') continue;
    const id = toCanonicalId(r.entity);
    if (!id) continue;
    const name = nameOf(id, r.entity);
    // PF is a 100%-basis dataset. Dollars shown and carried in impactAnnualUsd are the ORA share.
    const own = ownOf(id);
    const shareNote = own !== 1 ? ` (ORA share, ${(own * 100).toFixed(0)}% of the 100%-basis ledger)` : '';
    if (r.kind === 'stale-tracker') {
      const how =
        r.evidence === 'renewal-lump'
          ? `${usd(r.posted! * own)} of insurance posted in ${r.postedMonths.join(', ')} (${Math.round((r.posted! / r.lapsedPremium!) * 100)}% of the lapsed premium)${shareNote}`
          : `monthly insurance postings continue after the lapse (${usd(r.posted! * own)} in ${r.postedMonths.join(', ')})${shareNote}`;
      out.push({
        id: `pf-ins-stale-tracker-${id}`,
        severity: 'info',
        category: 'insurance',
        title: `Tracker says lapsed, ledger still paying — ${name}`,
        detail: `Tracker shows the policy lapsed ${r.lapsedExpires}, but the PF ledger shows ${how}. Likely renewed and not logged in the tracker. Confirm the binder and update the tracker; until then the lapse alert stands and the asset is not confirmed covered.`,
        entityType: 'property',
        entityId: id,
        action: { label: 'Confirm binder', kind: 'review' },
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
    } else if (r.staggeredTerms) {
      // Ambiguous by construction: no dollar figure in the title, detail or impact.
      out.push({
        id: `pf-ins-ledger-excess-${id}`,
        severity: 'info',
        category: 'insurance',
        title: `Ledger insurance ${r.ratio!.toFixed(1)}x the policy, needs review (staggered policy terms) — ${name}`,
        detail: `Trailing-12-month insurance booked in the ledger is ${r.ratio!.toFixed(1)}x the annual premium on the tracker. The live policies at this location renew in different months, so an early renewal of one policy and a duplicate payment of another look the same in the ledger. Review the payments against the binders; no dollar impact is stated until they are matched.`,
        metric: `${r.ratio!.toFixed(1)}x`,
        entityType: 'property',
        entityId: id,
        action: { label: 'Review premium payments', kind: 'review' },
        impactAnnualUsd: null,
        spine: 'B',
        provenance: 'derived',
      });
    } else {
      out.push({
        id: `pf-ins-ledger-excess-${id}`,
        severity: 'warning',
        category: 'insurance',
        title: `Ledger insurance ${r.ratio!.toFixed(1)}x the policy — ${name}`,
        detail: `Trailing-12-month insurance booked in the ledger is ${usd(r.ledgerT12! * own)} against ${usd(r.trackerPremium! * own)} of annual premium on the tracker (${usd(r.excess! * own)} over)${shareNote}. Check for a duplicate payment, two renewal payments in one window, or a premium the tracker is missing.`,
        metric: `${r.ratio!.toFixed(1)}x`,
        entityType: 'property',
        entityId: id,
        action: { label: 'Reconcile premium payments', kind: 'review' },
        impactAnnualUsd: r.excess! * own,
        spine: 'B',
        provenance: 'derived',
      });
    }
  }
  // Code-point order, not localeCompare: the order must not depend on the host's ICU locale.
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
