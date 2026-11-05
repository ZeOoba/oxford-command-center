// src/modules/overview/landlord-cost-caveat.ts
//
// Design review 2026-10-31 finding 6: headline figures carried no marker for the NNN-not-absolute
// properties whose expenses read $0. parse.ts flagLandlordCostsNotSourced sets the `landlordCosts`
// flag on them (ruling 2026-10-30): landlord-paid roof, structure and paving costs are not sourced,
// so their NOI, and anything built on it (weighted cap rate, DSCR), is overstated by those costs.
// The Portfolio NOI cell and the property page already label the property; this labels the
// portfolio figures the same way. Labels only: no value is restated, ruling 2026-10-30.
import { isInvestmentProperty, landlordCostsNotSourced } from '@analytics/property-basis';
import type { Property } from '@contracts/index';

export interface LandlordCostCaveat {
  /** Investment properties in the population that carry the landlordCosts flag, in input order. */
  flagged: readonly Pick<Property, 'id' | 'name'>[];
  /** Size of the investment population the count is out of. */
  of: number;
  /** Short chip text, e.g. "LL costs not sourced · 6 of 13". */
  text: string;
  /** Full explanation for the tooltip: what is overstated, that nothing is restated, and which properties. */
  title: string;
}

/**
 * The caveat for a figure built over `population` (investment rows only; any other row is ignored),
 * or null when no property in it carries the flag. `measure` names the figure for the tooltip
 * ("this DSCR"); pass `plural` when it names more than one ("this NOI and the weighted cap rate").
 */
export function landlordCostCaveat(
  population: readonly Property[],
  { measure, plural = false }: { measure: string; plural?: boolean },
): LandlordCostCaveat | null {
  const investment = population.filter(isInvestmentProperty);
  const flagged = investment.filter(landlordCostsNotSourced).map((p) => ({ id: p.id, name: p.name }));
  if (flagged.length === 0) return null;
  const n = flagged.length;
  const of = investment.length;
  const title =
    `${n} of ${of} ${of === 1 ? 'property' : 'properties'} ${n === 1 ? 'is' : 'are'} NNN but not absolute with $0 or blank expenses: ` +
    `landlord-paid roof, structure and paving costs are not sourced, so ${measure} ${plural ? 'are' : 'is'} overstated by them. ` +
    `Values are not restated until a PCA schedule supplies the costs. ${flagged.map((p) => p.name).join(', ')}.`;
  return { flagged, of, text: `LL costs not sourced · ${n} of ${of}`, title };
}
