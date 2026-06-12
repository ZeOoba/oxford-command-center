// server/warehouse/detect.ts

/** Filename token -> property_master id (staged-corpus aliases, audited 2026-06-12). */
export const PROPERTY_ALIASES: Record<string, string> = {
  '1100 rarig': '1100-rarig-ave-columbus-oh',
  '1851 south club solar': '1851-s-club-solar',
  '1851 s club solar': '1851-s-club-solar',
  '1900 broadway': '1900-n-broadway-baltimore-md',
  '29000 info lane': '29000-information-lane-easton-md',
  '3034 westerville': '3034-westerville-rd-columbus-oh',
  '3540 e 5th': '3540-e-5th-ave-columbus-oh',
  '3883 livingston': '3875-3883-e-livingston-ave-columbus-oh',
  '55 new plant (egfllc)': '55-new-plant-ct-owings-mills-md',
  '55 new plant': '55-new-plant-ct-owings-mills-md',
  '9050 red branch': '9050-red-branch-rd-columbia-md',
  '9620 state 350': '9620-e-state-route-350-raytown-mo',
  'fvc': 'sepich-portfolio-columbus-oh-8-props',
  '2203-2207 northwood': '2203-2207-northwood-dr-salisbury-md',
  '401 sunburst': '401-sunburst-hwy-cambridge-md',
  '7658 fishel': '7658-fishel-dr-n-dublin-oh',
};

export interface FilenameDetection {
  propertyId: string | null;
  propertyToken: string;
  year: number;
  grain: 'year' | 'ytd';
  format: 'xlsx' | 'xlsm' | 'csv' | 'pdf';
  confidence: number;
}

// Forms: "P&L 2025 -- token.ext" | "P&L 2026 YTD -- token.ext" | "2025 P&L -- token.ext" | "2026 YTD P&L -- token.ext"
const PATTERNS = [
  /^P&L\s+(?<year>20\d{2})(?<ytd>\s+YTD)?\s*--\s*(?<token>.+)\.(?<ext>xlsx|xlsm|csv|pdf)$/i,
  /^(?<year>20\d{2})(?<ytd>\s+YTD)?\s+P&L\s*--\s*(?<token>.+)\.(?<ext>xlsx|xlsm|csv|pdf)$/i,
];

export function detectFromFilename(fileName: string): FilenameDetection | null {
  for (const re of PATTERNS) {
    const m = fileName.match(re);
    if (!m?.groups) continue;
    const token = m.groups['token']!.trim();
    const year = Number(m.groups['year']);
    const grain = m.groups['ytd'] ? 'ytd' as const : 'year' as const;
    const ext = m.groups['ext']!.toLowerCase() as FilenameDetection['format'];
    const propertyId = PROPERTY_ALIASES[token.toLowerCase()] ?? null;
    return {
      propertyId, propertyToken: token, year, grain, format: ext,
      confidence: propertyId ? 0.95 : 0.4,
    };
  }
  return null; // not a P&L filename (leases, misc) — skip gracefully
}
