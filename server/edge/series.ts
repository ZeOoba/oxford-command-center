// server/edge/series.ts
//
// Series vocabulary for the Edge server modules. EDGE_SERIES and SERIES_UNITS are declared once in
// src/contracts/edge.ts (the client needs them too, and src/** may not import server/**); they are
// re-exported here so server code has one local import point.
import type { EdgeMarket } from '../../src/contracts/edge';

export { EDGE_SERIES, SERIES_UNITS } from '../../src/contracts/edge';

/** Market types that make up the 21-market buy-box set (20 named + indianapolis_south). */
export const BUY_BOX_TYPES: ReadonlySet<EdgeMarket['type']> = new Set<EdgeMarket['type']>(['named', 'named_custom']);
