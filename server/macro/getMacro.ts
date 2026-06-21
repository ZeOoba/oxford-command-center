import type { MacroSnapshot } from '../../src/contracts/index';
import { WORKBOOK_AS_OF } from '../config';
import { fetchFredMacro } from './fred';

/**
 * Macro snapshot. Live FRED when FRED_API_KEY is set; otherwise the fallback below,
 * which is seeded with REAL values pulled from FRED as of June 2026 (so the dashboard
 * is accurate-as-of-today even without a key). Labeled `source: 'mock'` since it's a
 * static snapshot — set FRED_API_KEY to go live (`source: 'fred'`).
 */
export async function getMacro(): Promise<MacroSnapshot> {
  const live = await fetchFredMacro().catch(() => null);
  if (live) return live;
  return seeded();
}

function seeded(): MacroSnapshot {
  // Real 10Y monthly path from FRED (Jun 2025 → May 2026).
  const months = ['2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
  const tenY = [4.38, 4.39, 4.26, 4.12, 4.06, 4.09, 4.14, 4.21, 4.13, 4.25, 4.32, 4.48];
  const tenYearHistory = tenY.map((value, i) => ({ date: `${months[i]}-01`, value }));

  return {
    asOf: WORKBOOK_AS_OF,
    source: 'mock',
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: -0.01 },
      { id: 'DGS5', label: '5Y Treasury', value: 4.18, unit: '%', change: null },
      { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: null },
      { id: 'SOFR', label: 'SOFR', value: 3.63, unit: '%', change: null },
      { id: 'FEDFUNDS', label: 'Fed Funds (effective)', value: 3.63, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory,
  };
}
