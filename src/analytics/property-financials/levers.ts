// src/analytics/property-financials/levers.ts
//
// "Value of a point": the Rent & NOI levers sensitivity table (reference artifact LEVERS block,
// tests/fixtures/property-financials/reference-artifact.html). Each lever is rate x a base read from
// the dataset; the lever definitions (label template, rate, unit, base period, category) live in ONE
// config object, LEVERS, so a test can prove that moving a parameter moves the value and the label.
//
// No firm number lives here. The one lease-level input (7658 Fishel's square footage) is read from
// dataset.leases and the lease source is cited in the basis; a lease without SF is n/m, never 0.
//
// Sensitivities are arithmetic, not forecasts. Pure TypeScript.
import {
  PF_MONTHLY_ENTITY_IDS,
  type OpexCategory,
  type PfDataset,
  type PfLease,
  type PfMonthlyEntityId,
  type PfPeriodFigures,
  type StandardPeriodId,
} from '@contracts/property-financials';
import { notMeaningful, ok, partialReason, periodLabel, type MetricResult } from './periods';
import { pctChange, recoveryPool } from './metrics';
import { pctLevel, usd } from './format';

export type LeverCategory = 'Rent' | 'Recovery' | 'Cost';

/** How `rate` reads in a label: 0.1 'pct' = 10%, 0.1 'points' = 10 points, 0.005 'bps' = 50 bps, 1 'usdPerSf' = $1.00/SF. */
export type LeverUnit = 'pct' | 'points' | 'bps' | 'usdPerSf';

export type LeverBase =
  /** Sum of one period field over every PM-reported (monthly) asset. */
  | { readonly kind: 'pmField'; readonly field: 'base_rent' | 'revenue'; readonly period: StandardPeriodId; readonly shareOf?: OpexCategory }
  /** Sum of one opex category over every PM-reported asset. */
  | { readonly kind: 'pmOpex'; readonly category: OpexCategory; readonly period: StandardPeriodId }
  /** One asset's recoverable cost pool (tax + insurance + utilities + grounds + R&M). */
  | { readonly kind: 'recoveryPool'; readonly entity: PfMonthlyEntityId; readonly period: StandardPeriodId }
  /** A lease's square footage from dataset.leases (matched on the property's leading words). */
  | { readonly kind: 'leaseSf'; readonly property: string };

export interface LeverDef {
  readonly id: string;
  readonly category: LeverCategory;
  /** `{rate}` is replaced by describeLeverRate; `{sf}` by the lease SF (leaseSf levers). */
  readonly label: string;
  readonly rate: number;
  readonly unit: LeverUnit;
  readonly base: LeverBase;
}

/** The artifact's eleven levers, in its order. Edit a rate here and both value and label move. */
export const LEVERS: readonly LeverDef[] = [
  { id: 'rentGrowth', category: 'Rent', label: '+{rate} of annual rent growth, all PM assets', rate: 0.01, unit: 'points', base: { kind: 'pmField', field: 'base_rent', period: 'TTM26' } },
  { id: 'fishelPerSf', category: 'Rent', label: 'Fishel: each {rate} NNN on {sf}', rate: 1, unit: 'usdPerSf', base: { kind: 'leaseSf', property: '7658 Fishel' } },
  { id: 'recoveryFvc', category: 'Recovery', label: 'FVC: +{rate} of recovery on the cost pool', rate: 0.1, unit: 'points', base: { kind: 'recoveryPool', entity: 'FVC', period: 'FY2025' } },
  { id: 'recovery9620', category: 'Recovery', label: '9620: +{rate} of recovery on the cost pool', rate: 0.1, unit: 'points', base: { kind: 'recoveryPool', entity: '9620 State 350', period: 'TTM26' } },
  { id: 'recoveryRarig', category: 'Recovery', label: 'Rarig: +{rate} of recovery on the cost pool', rate: 0.1, unit: 'points', base: { kind: 'recoveryPool', entity: '1100 Rarig', period: 'FY2025' } },
  { id: 'reTaxAppeal', category: 'Cost', label: 'Real estate tax: {rate} reduction through appeals', rate: 0.05, unit: 'pct', base: { kind: 'pmOpex', category: 'Real estate & property tax', period: 'FY2025' } },
  { id: 'utilities', category: 'Cost', label: 'Utilities: {rate} reduction (supply bid, submeters, leaks)', rate: 0.1, unit: 'pct', base: { kind: 'pmOpex', category: 'Utilities', period: 'TTM26' } },
  { id: 'grounds', category: 'Cost', label: 'Grounds and snow: {rate} through one RFP per metro', rate: 0.1, unit: 'pct', base: { kind: 'pmOpex', category: 'Grounds / snow / lot', period: 'TTM26' } },
  { id: 'repairs', category: 'Cost', label: 'Repairs and maintenance: {rate} through vendor consolidation', rate: 0.1, unit: 'pct', base: { kind: 'pmOpex', category: 'Repairs & maintenance', period: 'TTM26' } },
  { id: 'mgmtFee', category: 'Cost', label: 'Management fee: {rate} on revenue', rate: 0.005, unit: 'bps', base: { kind: 'pmField', field: 'revenue', period: 'TTM26', shareOf: 'Management fees' } },
  { id: 'insurance', category: 'Cost', label: 'Insurance: {rate} through one blanket program', rate: 0.08, unit: 'pct', base: { kind: 'pmOpex', category: 'Insurance', period: 'TTM26' } },
];

const trim = (n: number, digits: number): string => String(Number(n.toFixed(digits)));

/** The rate as a label fragment: '10%', '1 point', '10 points', '50 bps', '$1.00/SF'. */
export function describeLeverRate(l: Pick<LeverDef, 'rate' | 'unit'>): string {
  switch (l.unit) {
    case 'pct':
      return `${trim(l.rate * 100, 2)}%`;
    case 'points': {
      const pts = trim(l.rate * 100, 2);
      return `${pts} ${pts === '1' ? 'point' : 'points'}`;
    }
    case 'bps':
      return `${trim(l.rate * 10_000, 1)} bps`;
    case 'usdPerSf':
      return `$${l.rate.toFixed(2)}/SF`;
  }
}

/** Short basis label of a category ('utilities', 'tax', ...): the artifact's Basis wording. */
const CATEGORY_BASIS: Readonly<Partial<Record<OpexCategory, string>>> = {
  'Real estate & property tax': 'tax',
  Utilities: 'utilities',
  Insurance: 'premiums',
  'Management fees': 'Fees',
};

export interface LeverResult {
  readonly id: string;
  readonly category: LeverCategory;
  readonly label: string;
  readonly rate: number;
  /** The base the rate applies to, or null when it could not be read. */
  readonly base: number | null;
  /** Annual value, or n/m with the reason. */
  readonly value: MetricResult;
  /** Where the base comes from, with the figure. */
  readonly basis: string;
}

function pmSum(d: PfDataset, period: StandardPeriodId, pick: (f: PfPeriodFigures) => number): { total: number; partial: string[] } {
  let total = 0;
  const partial: string[] = [];
  for (const id of PF_MONTHLY_ENTITY_IDS) {
    const p = d.properties[id];
    if (p.kind !== 'monthly') continue;
    const f = p.periods[period];
    total += pick(f);
    if (partialReason(period, f.n_months) !== null) partial.push(`${id} ${f.n_months} of 12 months`);
  }
  return { total, partial };
}

const partialNote = (partial: readonly string[]): string => (partial.length ? `; includes ${partial.join(', ')}` : '');

function leaseFor(leases: readonly PfLease[], property: string): PfLease | null {
  return leases.find((l) => l.property === property || l.property.startsWith(`${property} `) || l.property.startsWith(`${property}(`)) ?? null;
}

/** Fixed rent steps of a lease schedule when every step is the same percentage; null otherwise. */
function uniformStep(lease: PfLease): number | null {
  const amts = (lease.rent_schedule_monthly ?? []).map((r) => r[2]);
  if (amts.length < 2) return null;
  const steps: number[] = [];
  for (let i = 1; i < amts.length; i++) {
    const s = pctChange(amts[i - 1], amts[i]).value;
    if (s === null) return null;
    steps.push(s);
  }
  return steps.every((s) => Math.abs(s - steps[0]!) < 0.0005) ? steps[0]! : null;
}

function leverValue(def: LeverDef, d: PfDataset): { base: number | null; value: MetricResult; basis: string; sf: number | null } {
  const b = def.base;
  const per = (p: StandardPeriodId) => periodLabel(p);
  switch (b.kind) {
    case 'pmField': {
      const { total, partial } = pmSum(d, b.period, (f) => f[b.field]);
      let basis = `${b.field === 'base_rent' ? 'Base rent' : 'Revenue'} ${per(b.period)} ${usd(total)}`;
      if (b.shareOf) {
        const share = pmSum(d, b.period, (f) => f.opex_by[b.shareOf!]).total;
        const name = CATEGORY_BASIS[b.shareOf] ?? b.shareOf;
        basis = `${name} ${per(b.period)} ${usd(share)} (${total > 0 ? pctLevel(share / total, 1) : 'n/m'} of revenue)`;
      }
      return { base: total, value: ok(total * def.rate), basis: basis + partialNote(partial), sf: null };
    }
    case 'pmOpex': {
      const { total, partial } = pmSum(d, b.period, (f) => f.opex_by[b.category]);
      const name = CATEGORY_BASIS[b.category];
      const basis = name ? `${per(b.period)} ${name} ${usd(total)}` : `${per(b.period)} ${usd(total)}`;
      return { base: total, value: ok(total * def.rate), basis: basis + partialNote(partial), sf: null };
    }
    case 'recoveryPool': {
      const p = d.properties[b.entity];
      if (p.kind !== 'monthly') return { base: null, value: notMeaningful('no monthly detail for this entity'), basis: '', sf: null };
      const f = (p.periods as Record<StandardPeriodId, PfPeriodFigures>)[b.period];
      const pool = recoveryPool(f.opex_by);
      const basis = `${per(b.period)} pool ${usd(pool)}`;
      const partial = partialReason(b.period, f.n_months);
      if (partial !== null) return { base: pool, value: notMeaningful(partial), basis, sf: null };
      return { base: pool, value: ok(pool * def.rate), basis, sf: null };
    }
    case 'leaseSf': {
      const lease = leaseFor(d.leases, b.property);
      if (!lease) return { base: null, value: notMeaningful(`no lease on file for ${b.property}`), basis: `No ${b.property} lease in the dataset`, sf: null };
      const src = `${lease.source}, ${lease.confidence}`;
      if (lease.sf === null || !(lease.sf > 0)) {
        return { base: null, value: notMeaningful('no square footage on the lease abstract'), basis: `Lease (${src}) carries no SF`, sf: null };
      }
      const step = uniformStep(lease);
      const steps = step === null ? '' : `; schedule fixes the rent with ${step >= 0 ? '+' : ''}${(step * 100).toFixed(1)}%/yr steps`;
      return {
        base: lease.sf,
        value: ok(lease.sf * def.rate),
        basis: `${lease.sf.toLocaleString('en-US')} SF per lease (${src})${steps}`,
        sf: lease.sf,
      };
    }
  }
}

/** Every lever's value on the dataset. `levers` defaults to the shipped config. */
export function computeLevers(d: PfDataset, levers: readonly LeverDef[] = LEVERS): LeverResult[] {
  return levers.map((def) => {
    const { base, value, basis, sf } = leverValue(def, d);
    const label = def.label.replace('{rate}', describeLeverRate(def)).replace('{sf}', sf === null ? 'the lease SF' : `${sf.toLocaleString('en-US')} SF`);
    return { id: def.id, category: def.category, label, rate: def.rate, base, value, basis };
  });
}
