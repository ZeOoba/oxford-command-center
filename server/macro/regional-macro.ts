// server/macro/regional-macro.ts
//
// Scope B — Regional Market Dynamics: state-level unemployment for ORA's 7 markets.
//
// getRegionalMacro(): returns one StateEmploymentMetric per ORA-market state, pulling the
// FRED state unemployment series (OHUR/MDUR/INEUR/WIUR/MOUR/KSUR/TNUR) when FRED_API_KEY is set.
// Fail-open by contract (mirrors getMacro.ts / market-benchmarks.ts):
//   • No key, or a single series 404/5xx  → that state falls back to its mock seed (source:'mock').
//   • fetch rejects / any error           → the WHOLE snapshot falls back to mock; NEVER throws.
//
// This is a DISPLAY-ONLY economic context signal. It does NOT feed the capital-allocation
// priority score or capitalAction — it is a diagnostic overlay, like MacroContext and the
// market cap-rate benchmarks. State unemployment from FRED (monthly, seasonally adjusted).
//
// Mock seed values are defensible approximate current rates (mid-2026) for ORA's markets,
// labeled source:'mock' so the UI badges them as a snapshot — set FRED_API_KEY to go live.
import { WORKBOOK_AS_OF } from '../config';
import {
  type StateEmploymentMetric,
  type RegionalMacroSnapshot,
} from '../../src/contracts/index';

const BASE = 'https://api.stlouisfed.org/fred';
const FRED_TIMEOUT_MS = 4_000;

/** ORA market → FRED state unemployment series. The single source of truth for the 7 states. */
export const ORA_STATE_SERIES: ReadonlyArray<{
  stateCode: string;
  stateName: string;
  seriesId: string;
  /** Defensible approximate current rate (mid-2026) used when FRED is unavailable. */
  mockRate: number;
}> = [
  { stateCode: 'OH', stateName: 'Ohio', seriesId: 'OHUR', mockRate: 4.3 },
  { stateCode: 'MD', stateName: 'Maryland', seriesId: 'MDUR', mockRate: 3.1 },
  { stateCode: 'IN', stateName: 'Indiana', seriesId: 'INEUR', mockRate: 4.2 },
  { stateCode: 'WI', stateName: 'Wisconsin', seriesId: 'WIUR', mockRate: 3.4 },
  { stateCode: 'MO', stateName: 'Missouri', seriesId: 'MOUR', mockRate: 3.9 },
  { stateCode: 'KS', stateName: 'Kansas', seriesId: 'KSUR', mockRate: 3.6 },
  { stateCode: 'TN', stateName: 'Tennessee', seriesId: 'TNUR', mockRate: 3.5 },
];

function key(): string | undefined {
  return process.env.FRED_API_KEY;
}

/**
 * Fetch the latest observation for one state series. Returns { rate, asOf } on success,
 * or null on any non-OK response or non-finite value. Pass null through (no `?? 0`) — a
 * missing observation must surface as null, never a 0-lie (cf. server/macro/fred.ts).
 */
async function latestObs(seriesId: string): Promise<{ rate: number; asOf: string } | null> {
  const url = `${BASE}/series/observations?series_id=${seriesId}&api_key=${key()}&file_type=json&sort_order=desc&limit=1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FRED_TIMEOUT_MS);
  let r: Response | null;
  try {
    r = await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!r || !r.ok) return null;
  const j = (await r.json()) as { observations?: { date?: string; value: string }[] };
  const o = j.observations?.[0];
  if (!o) return null;
  const n = o.value ? parseFloat(o.value) : NaN;
  if (!Number.isFinite(n)) return null;
  return { rate: n, asOf: o.date ?? WORKBOOK_AS_OF };
}

/** Build the all-mock snapshot (key absent, or whole-provider fail-open). */
function seeded(): RegionalMacroSnapshot {
  const states: StateEmploymentMetric[] = ORA_STATE_SERIES.map((s) => ({
    stateCode: s.stateCode,
    stateName: s.stateName,
    unemploymentRate: s.mockRate,
    source: 'mock' as const,
    asOf: WORKBOOK_AS_OF,
  }));
  return { asOf: WORKBOOK_AS_OF, source: 'mock', states };
}

/**
 * Resolve the regional macro snapshot. Live FRED per state when FRED_API_KEY is set;
 * otherwise (or on any error) the mock seed. NEVER throws.
 *
 * Per-state fail-open: a single series that 404s falls back to that state's mock rate while
 * the other states keep their live values — the failure is scoped, never cascading.
 */
export async function getRegionalMacro(): Promise<RegionalMacroSnapshot> {
  if (!key()) return seeded();
  try {
    const results = await Promise.all(
      ORA_STATE_SERIES.map((s) => latestObs(s.seriesId).catch(() => null)),
    );

    // Total outage (no state came back live — e.g. fetch rejected, or every series 404'd):
    // fall back to the full mock seed with defensible static values, not a wall of nulls.
    // A PARTIAL outage (below) keeps the live states and nulls only the missing ones.
    const anyLive = results.some((r) => r !== null);
    if (!anyLive) return seeded();

    let latestAsOf: string | null = null;
    const states: StateEmploymentMetric[] = ORA_STATE_SERIES.map((s, i) => {
      const obs = results[i];
      if (obs) {
        if (latestAsOf === null || obs.asOf > latestAsOf) latestAsOf = obs.asOf;
        return {
          stateCode: s.stateCode,
          stateName: s.stateName,
          unemploymentRate: obs.rate,
          source: 'fred' as const,
          asOf: obs.asOf,
        };
      }
      // This state's series was unavailable while others were live. Surface null (not the
      // mock rate) so a scoped outage reads honestly — we do NOT substitute a static value
      // into an otherwise-live snapshot and call it data. The UI renders null as '—'.
      return {
        stateCode: s.stateCode,
        stateName: s.stateName,
        unemploymentRate: null,
        source: 'mock' as const,
        asOf: null,
      };
    });

    return { asOf: latestAsOf, source: 'fred', states };
  } catch {
    return seeded();
  }
}
