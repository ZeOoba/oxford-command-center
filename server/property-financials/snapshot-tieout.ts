// server/property-financials/snapshot-tieout.ts
//
// Snapshot (workbook model, Spine A) vs the Property Financials dataset. PF is a deliberate third NOI
// basis (src/contracts/property-financials.ts header: never aggregate it with either spine without
// explicit basis-matching), and until now NOTHING read it outside the PF module. A review of the per-property
// reports found real gaps between the two (NOI basis, missing entities, LTV basis), so this is the tie-out. The NOI check CALLS server/warehouse/reconcile-noi.ts classifyNoiReconciliation (same pct band,
// capped dollar band, sign-conflict and zero guards), so it cannot drift from the existing spine A-B tie-out,
// and is WARN-ONLY: model NOI vs TTM actuals legitimately differ, so a
// hard fail would be noise until each gap is triaged. Printed, counted, never gating.
//
// Checks
//   noi  snapshot properties[].noi (Oxford share) vs PF TTM26 NOI x oxfordOwnPct (PF is 100% basis).
//   sf   snapshot properties[].sf vs PF sf. Any difference is a finding (square footage is a fact, not an estimate).
//   ltv  properties[].ltv vs the loans[] row that collateralizes it, ONLY when exactly one borrower loan
//        maps to the property. It compares two REPORTED LTVs to each other; it never compares an LTV to a
//        governor and uses no governor literal (Hard Invariant 4; governance-check's literal-coupling rule).
//        Balance tie-out is already server/reconcile-runtime.ts checkDebtBasis.
//
// NOTE: governance-check's literal-coupling rule scans server/warehouse and server/insights only; this directory is
// covered by tests/unit/pf-snapshot-tieout.test.ts (no governor literal under server/property-financials).
//
// Not meaningful (always with a reason, never silently clean): annual-only PF entities (no TTM), snapshot
// properties with no PF entity (excluded from the dataset, or no P&L on file), PF entities absent from the
// snapshot, null LTVs, several loans. An entity whose mapping.ts method is 'inferred' carries that caveat on
// its NOI row.
//
// Rollover is deliberately NOT here: PF holds a handful of curated lease rows and no rent roll, so a rollover
// tie-out would be a fiction. It needs a rent roll in scope.
import type { Loan, PortfolioSnapshot } from '../../src/contracts/index';
import type { PfDataset } from '../../src/contracts/property-financials';
import { buildLoanPropertyMap } from '../warehouse/property-crosswalk';
import { classifyNoiReconciliation } from '../warehouse/reconcile-noi';
import { CROSSCHECK_THRESHOLDS } from './crosscheck-config';
import { ENTITY_TO_CANONICAL } from './mapping';

export type TieOutSnapshot = Pick<PortfolioSnapshot, 'properties' | 'loans'>;
export type TieOutPf = Pick<PfDataset, 'properties' | 'sf' | 'meta'>;

export type TieOutCheck = 'noi' | 'sf' | 'ltv';
export type TieOutStatus = 'match' | 'in-tolerance' | 'drift' | 'large-drift' | 'n/m';

export interface TieOutRow {
  check: TieOutCheck;
  propertyId: string;
  name: string;
  /** PF entity label when one maps to this property. */
  entity: string | null;
  status: TieOutStatus;
  /** 'warn' for drift / large-drift, 'info' otherwise. Never 'error': this tie-out does not gate. */
  severity: 'info' | 'warn';
  snapshotValue: number | null;
  pfValue: number | null;
  /** snapshot - pf (for ltv: property LTV - loan-row LTV). */
  delta: number | null;
  /** |delta| / max(|snapshot|, |pf|). */
  deltaPct: number | null;
  reason: string | null;
}

const EPS = 1e-9;
const idToEntity = new Map(Object.entries(ENTITY_TO_CANONICAL).map(([entity, v]) => [v.id, entity] as const));
const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

function nm(check: TieOutCheck, propertyId: string, name: string, entity: string | null, reason: string): TieOutRow {
  return { check, propertyId, name, entity, status: 'n/m', severity: 'info', snapshotValue: null, pfValue: null, delta: null, deltaPct: null, reason };
}

function compare(
  check: TieOutCheck, propertyId: string, name: string, entity: string | null,
  snapshotValue: number, pfValue: number, status: TieOutStatus, reason: string | null,
): TieOutRow {
  const delta = snapshotValue - pfValue;
  const denom = Math.max(Math.abs(snapshotValue), Math.abs(pfValue));
  return {
    check, propertyId, name, entity, status,
    severity: status === 'drift' || status === 'large-drift' ? 'warn' : 'info',
    snapshotValue, pfValue, delta, deltaPct: denom > 0 ? Math.abs(delta) / denom : 0, reason,
  };
}

/**
 * NOI classification delegates to reconcile-noi.ts so the two tie-outs share ONE rule set. The warehouse-only
 * evidence (acqDate / recent tenancy / period year) is deliberately withheld, so a large gap is reported as
 * a large-drift WARN and never downgraded to a structural-mismatch on evidence PF cannot supply. 'error'
 * severity is mapped to 'warn': this tie-out never gates.
 */
function classifyNoi(
  propertyId: string, name: string, snapshotNoi: number, pfShareNoi: number,
  t: typeof CROSSCHECK_THRESHOLDS.tieOut,
): { status: TieOutStatus; reason: string | null } {
  const row = classifyNoiReconciliation(
    {
      propertyId, propertyName: name, workbookOxfordNoi: snapshotNoi, warehouseOxfordNoi: pfShareNoi,
      warehousePeriod: null, warehouseBasis: 'cash', isLeaseRun: false, isResidence: false, acqDate: null, recentTenancyAnnualRent: null,
    },
    { pctBand: t.pctBand, absBandUsd: t.absBandUsd, largeDriftPct: t.largeDriftPct },
  );
  if (row.status === 'match' || row.status === 'in-tolerance' || row.status === 'drift' || row.status === 'large-drift') {
    return { status: row.status, reason: row.status === 'drift' || row.status === 'large-drift' ? row.reason : null };
  }
  // missing-from-warehouse here means PF NOI is $0 against a non-zero snapshot NOI. Any other status is not a
  // tie-out result this check can express, so it is surfaced as n/m with the classifier's own reason.
  if (row.status === 'missing-from-warehouse') {
    return { status: 'n/m', reason: 'PF reports $0 NOI against a non-zero snapshot NOI, so there is no like-for-like figure to tie' };
  }
  return { status: 'n/m', reason: `the NOI classifier returned '${row.status}', which this tie-out does not interpret${row.reason ? `: ${row.reason}` : ''}` };
}

export function tieOutSnapshotToPf(
  snapshot: TieOutSnapshot,
  pf: TieOutPf,
  t: typeof CROSSCHECK_THRESHOLDS.tieOut = CROSSCHECK_THRESHOLDS.tieOut,
): TieOutRow[] {
  const rows: TieOutRow[] = [];
  // 'TTM' + the two-digit year of the dataset as-of date (2026-09-30 -> TTM26); never a hard-coded year.
  const ttmKey = `TTM${pf.meta.as_of.slice(2, 4)}`;
  const pfProps = pf.properties as Record<string, { kind: string; periods: Record<string, { noi?: number; n_months?: number } | undefined> } | undefined>;
  const pfSf = pf.sf as Record<string, { sf: number | null } | undefined>;
  const seen = new Set<string>();

  for (const p of snapshot.properties) {
    seen.add(p.id);
    const entity = idToEntity.get(p.id) ?? null;
    const prop = entity ? pfProps[entity] : undefined;

    // --- NOI ---
    if (!entity || !prop) {
      rows.push(nm('noi', p.id, p.name, entity, 'not in the PF dataset (excluded from it, or no P&L on file)'));
    } else if (prop.kind !== 'monthly') {
      rows.push(nm('noi', p.id, p.name, entity, 'PF holds annual statements only for this entity (no TTM), so there is no like-for-like period'));
    } else if (typeof prop.periods[ttmKey]?.noi !== 'number') {
      rows.push(nm('noi', p.id, p.name, entity, `PF has no ${ttmKey} NOI for this entity`));
    } else if ((prop.periods[ttmKey]?.n_months ?? 12) < 12) {
      rows.push(nm('noi', p.id, p.name, entity, `PF ${ttmKey} covers only ${prop.periods[ttmKey]!.n_months} months (partial period; never annualized), so there is no like-for-like figure`));
    } else if (typeof p.noi !== 'number') {
      rows.push(nm('noi', p.id, p.name, entity, 'the snapshot reports no NOI for this property'));
    } else {
      const own = p.oxfordOwnPct ?? 1;
      const pfShare = prop.periods[ttmKey]!.noi! * own;
      const { status, reason: nmReason } = classifyNoi(p.id, p.name, p.noi, pfShare, t);
      const classifierNote = status === 'n/m' ? null : nmReason;
      const notes = [
        classifierNote,
        own !== 1 ? `PF ${ttmKey} ${usd(prop.periods[ttmKey]!.noi!)} at 100% x ${(own * 100).toFixed(0)}% ORA share` : null,
        ENTITY_TO_CANONICAL[entity]?.method === 'inferred'
          ? 'the entity-to-property mapping is inferred (mapping.ts), not property-level; the PF figure may be an aggregate'
          : null,
      ].filter((x): x is string => x !== null);
      rows.push(
        status === 'n/m'
          ? nm('noi', p.id, p.name, entity, nmReason!)
          : compare('noi', p.id, p.name, entity, p.noi, pfShare, status, notes.length ? notes.join('; ') : null),
      );
    }

    // --- SF ---
    const sfPf = entity ? pfSf[entity]?.sf ?? null : null;
    if (sfPf === null || sfPf === undefined) {
      rows.push(nm('sf', p.id, p.name, entity, entity ? 'PF has no square footage for this entity' : 'not in the PF dataset'));
    } else {
      // Any difference is a finding (same rule as mapping.ts SF_MISMATCH): square footage is a fact, not an estimate.
      const status: TieOutStatus = p.sf === sfPf ? 'match' : 'drift';
      rows.push(compare('sf', p.id, p.name, entity, p.sf, sfPf, status, null));
    }
  }

  // PF entities whose canonical id is not a snapshot property.
  for (const [entity, v] of Object.entries(ENTITY_TO_CANONICAL)) {
    if (seen.has(v.id) || !(entity in pfProps)) continue;
    rows.push(nm('noi', v.id, entity, entity, 'PF entity has no matching property in the snapshot'));
  }

  // --- LTV ---
  const named = snapshot.properties.map((p) => ({ id: p.id, name: p.name }));
  const { map } = buildLoanPropertyMap(snapshot.loans as Loan[], named, new Set(named.map((n) => n.id)));
  const loansByProperty = new Map<string, Loan[]>();
  for (const loan of snapshot.loans as Loan[]) {
    const pid = map.get(loan.id);
    if (!pid) continue;
    loansByProperty.set(pid, [...(loansByProperty.get(pid) ?? []), loan]);
  }
  for (const p of snapshot.properties) {
    const loans = loansByProperty.get(p.id);
    const entity = idToEntity.get(p.id) ?? null;
    if (!loans || loans.length === 0) {
      if (typeof p.ltv === 'number') rows.push(nm('ltv', p.id, p.name, entity, 'the property reports an LTV but no borrower loan row maps to it, so there is nothing to tie it to'));
      continue;
    }
    if (loans.length > 1) {
      rows.push(nm('ltv', p.id, p.name, entity, `${loans.length} borrower loans map to this property; a single loan-row LTV is not comparable`));
      continue;
    }
    const loanLtv = loans[0]!.ltv;
    if (p.ltv === null || p.ltv === undefined || loanLtv === null || loanLtv === undefined) {
      rows.push(nm('ltv', p.id, p.name, entity, 'LTV is not reported on one side'));
      continue;
    }
    const gap = Math.abs(p.ltv - loanLtv);
    const status: TieOutStatus = gap < 1e-6 ? 'match' : gap <= t.ltvGapPoints + EPS ? 'in-tolerance' : 'drift';
    rows.push({
      ...compare('ltv', p.id, p.name, entity, p.ltv, loanLtv, status,
        status === 'drift' ? 'the property row and the loan row use different value bases; confirm which is the model value before relying on either' : null),
      deltaPct: gap,
    });
  }

  return rows.sort((a, b) => {
    const ka = `${a.check}|${a.propertyId}`;
    const kb = `${b.check}|${b.propertyId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
