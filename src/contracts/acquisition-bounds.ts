// src/contracts/acquisition-bounds.ts
//
// Domain bounds for the DSCR-floor inputs, shared by the AcquisitionInput contract (zod) and the DSCR-floor governor
// (server/warehouse/acq-governor-proxy.ts). Both are DECIMAL rates (0.075 = 7.50%). The bound is a unit guard: a
// percent-scale value (7.5 for 7.50%) must never reach the governor, where an exit cap of 7.5 would clear the DSCR
// floor at ~145x. The contract rejects it at parse time and the governor independently treats it as out of domain
// (indeterminate, never cleared), so loosening either layer alone cannot fail open (PR 585 merge gate F-009/F-010).
//
// Dependency-free on purpose: the proxy is bundled into the edge Pages Function, which must not pull in zod through
// this import.

/** Highest market exit cap accepted, as a decimal (25%). */
export const EXIT_CAP_MAX = 0.25;

/** Highest 10-yr UST accepted, as a decimal (20%). */
export const UST10YR_MAX = 0.2;

/**
 * Lowest 10-yr UST accepted, as a decimal (0.50%; the 2020 low was ~0.52%). The guard on the OTHER side of the unit:
 * a decimal typed into the Workbench's percent field ("0.043" for 4.30%) is divided by 100 again and arrives as
 * 0.00043, which cuts the refi rate to ~2% and overstates the DSCR ~56% (a 6.0% exit cap: ~1.81x vs ~1.16x at a
 * 4.30% UST) — enough to clear a deal that fails at the intended UST. Ratified by Gabriel 2026-11-18 (PR 585 merge gate F-012, "Add a 0.5% UST floor").
 */
export const UST10YR_MIN = 0.005;
