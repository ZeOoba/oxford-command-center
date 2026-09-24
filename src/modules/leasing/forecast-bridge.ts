// src/modules/leasing/forecast-bridge.ts
//
// Rent-bridge inputs for the Waterfall chart under the forecast result: in-place rent → rent rolling
// off in the horizon → re-leased / renewed rent → projected rent. A pure re-expression of fields the
// engine already returns — no forecast computation lives here.
import type { RentForecastResult } from '@contracts/lease-forecast';

/**
 * Two-driver rent bridge: expiring rent leaves, the scenario's re-lease value returns.
 *
 * The second driver is derived from the endpoints (projected − (in-place − expiring)) rather than
 * from `deltaUsd`, so start + Σdrivers = end holds by construction. The two agree whenever
 * `deltaUsd === projected − inPlace`; they differ only where the engine clamps `projectedAnnualRent`
 * at 0 but leaves `deltaUsd` unclamped (renew_at_market), and the bridge must land on the displayed
 * projected figure. That divergence is unreachable while `Lease.annualRent >= 0` and
 * `vacancyPct <= 1` hold, but the bridge is derived from the endpoints rather than from
 * `deltaUsd` anyway, so closure doesn't depend on that invariant holding. `|| 0` normalizes the
 * -0 that `-expiring` yields when nothing expires (engine idiom).
 */
export function forecastBridge(r: RentForecastResult) {
  const rollingOff = -r.expiringRentInHorizon || 0;
  const reLeased = r.projectedAnnualRent - (r.inPlaceAnnualRent + rollingOff) || 0;
  return {
    startValue: r.inPlaceAnnualRent,
    drivers: [
      { category: 'Rent rolling off', delta: rollingOff },
      { category: 'Re-leased / renewed', delta: reLeased },
    ],
    endValue: r.projectedAnnualRent,
  };
}
