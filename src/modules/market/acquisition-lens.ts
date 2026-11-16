// src/modules/market/acquisition-lens.ts
//
// Market › Acquisition Lens figures. Pure so it is unit-tested. When the portfolio weighted cap rate
// is incomplete (a blank workbook NOI is summed as $0), the cap rate is marked incomplete and the
// spread over the 10Y is WITHHELD: a spread built on an incomplete cap would read as a confident
// relative-value signal (follow-up to audit 2026-11-12 HIGH #2).
import { fmtPct } from '@analytics/index';

export interface AcquisitionLens {
  capText: string;
  spreadText: string;
  note: string | null;
}

/** `wtdCap` is a fraction (0.08), `tenY` a percent (4.2). `noiGap` = blank-NOI row names. */
export function acquisitionLens(wtdCap: number | null, tenY: number | null, noiGap: readonly string[]): AcquisitionLens {
  if (wtdCap === null) return { capText: '—', spreadText: '—', note: null };
  if (noiGap.length > 0) {
    return {
      capText: `${fmtPct(wtdCap, 2)} (incomplete)`,
      spreadText: '—',
      note: `Spread withheld: the weighted cap rate is incomplete (blank NOI on ${noiGap.join(', ')}).`,
    };
  }
  const spreadBps = tenY !== null ? Math.round((wtdCap * 100 - tenY) * 100) : null;
  return { capText: fmtPct(wtdCap, 2), spreadText: spreadBps !== null ? `${spreadBps} bps` : '—', note: null };
}
