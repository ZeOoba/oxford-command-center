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
