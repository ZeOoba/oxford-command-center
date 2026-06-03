import type { MacroSnapshot, MacroSeriesPoint, MacroIndicator } from '../../src/contracts/index';
import { WORKBOOK_AS_OF } from '../config';

/**
 * Live FRED adapter. Activates when FRED_API_KEY is set; otherwise returns null
 * and getMacro() falls back to the real-seeded snapshot in getMacro.ts.
 * Series: DGS10, DGS2, SOFR, FEDFUNDS (levels) + CPIAUCSL (YoY %).
 */
const BASE = 'https://api.stlouisfed.org/fred';

function key(): string | undefined {
  return process.env.FRED_API_KEY;
}

async function obs(seriesId: string, extra = ''): Promise<number | null> {
  const url = `${BASE}/series/observations?series_id=${seriesId}&api_key=${key()}&file_type=json&sort_order=desc&limit=1${extra}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as { observations?: { value: string }[] };
  const v = j.observations?.[0]?.value;
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function tenYearHistory(): Promise<MacroSeriesPoint[]> {
  const url = `${BASE}/series/observations?series_id=DGS10&api_key=${key()}&file_type=json&frequency=m&observation_start=2025-06-01&sort_order=asc&limit=13`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = (await r.json()) as { observations?: { date: string; value: string }[] };
  return (j.observations ?? [])
    .filter((o) => o.value !== '.' && Number.isFinite(parseFloat(o.value)))
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
}

export async function fetchFredMacro(): Promise<MacroSnapshot | null> {
  if (!key()) return null;
  try {
    const [t10, t2, sofr, ff, cpi, hist] = await Promise.all([
      obs('DGS10'),
      obs('DGS2'),
      obs('SOFR'),
      obs('FEDFUNDS'),
      obs('CPIAUCSL', '&units=pc1'),
      tenYearHistory(),
    ]);
    const ind = (id: string, label: string, value: number | null): MacroIndicator => ({
      id,
      label,
      value: value ?? 0,
      unit: '%',
      change: null,
    });
    return {
      asOf: WORKBOOK_AS_OF,
      source: 'fred',
      indicators: [
        ind('DGS10', '10Y Treasury', t10),
        ind('DGS2', '2Y Treasury', t2),
        ind('SOFR', 'SOFR', sofr),
        ind('FEDFUNDS', 'Fed Funds (effective)', ff),
        ind('CPIAUCSL', 'CPI (YoY)', cpi),
      ],
      tenYearHistory: hist.length ? hist : [],
    };
  } catch {
    return null;
  }
}
