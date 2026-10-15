// src/modules/property-condition/pca-overlay.ts
//
// Curated PCA facts that the 2026-10-06 extraction register (v01_2) does not carry or carries wrongly,
// each with provenance IN THE DATA (source_file / source_date / price_basis / status). Seeded from the
// 2026-10-13 PCA Command Center report; the register + underlying PCR remain the source of record — every
// divergence is listed in PCA_RECONCILIATION.md. Nothing here is invented: a field a source does not state
// is null and renders "n/a".
//
// This file is display data only. It feeds no scoring, governor, DSCR/LTV or capital-allocation path.
import type { PcaOverlay, Provenance } from '@/analytics/pca-intelligence';

const REPORT_FILE = '2026-10-13_PCA_Command_Center_Report_v01.md';
const REGISTER_FILE = '2026-10-06_PCA-Extraction_Register_v01_2.xlsx';

const INFO_LANE_PROV: Provenance = {
  sourceFile: `${REPORT_FILE} §2/§6; verified against Intertek PCR T1643.01 DRAFT 2025-10-29 (Business/29000 Information Lane, Loan Symetra 10.2025)`,
  sourceDate: '2025-10-29',
  priceBasis: 'PCA_CONSULTANT_ESTIMATE',
  status: 'DRAFT',
};

/** Derived from the live ledger counts (never a stored "n=1"): adding an observation is a data change only. */
export function calibrationLabel(counts: number[]): string {
  const ns = counts.filter((n) => n > 0);
  const nPart = ns.length === 0 ? 'no countable observations' : Math.min(...ns) === Math.max(...ns) ? `n=${ns[0]} each` : `n=${Math.min(...ns)}–${Math.max(...ns)} per component`;
  return `PCA consultant estimate vs contractor quote; ${nPart}; directional only below n=5`;
}

export const PCA_OVERLAY: PcaOverlay = {
  corrections: [
    {
      propertyKey: 'info-lane',
      reportId: 'R08',
      set: { reportDate: '2025-10-29', immediateUsd: 1100, shortTermUsd: 0, psfYrStated: 0.23 },
      reason:
        'Register R08 / Context Summary list Immediate $54,681 and Short-term $16,182 — those are the Year 1 and Year 2 reserve outlays. Intertek DRAFT: Immediate $1,100 (ADA), Short-term $0. $/SF/yr 0.23 uninflated (0.25 inflated).',
      provenance: INFO_LANE_PROV,
    },
    {
      propertyKey: 'raytown',
      reportId: 'R06',
      set: { reservesUninflUsd: 292500, psfYrStated: null },
      reason:
        'EWI states $218,500 but its own year columns sum to $292,500 (inflated $301,086 reconciles to that). $74,000 understatement; the corrected figure is used.',
      provenance: {
        sourceFile: `${REGISTER_FILE} (Flags_Open_Items #4; EWI #243812 year columns)`,
        sourceDate: '2024-10-07',
        priceBasis: 'PCA_CONSULTANT_ESTIMATE',
        status: 'CURRENT',
      },
    },
  ],
  flags: {
    'e-fulton': [
      'No roof access (roof ages inferred)',
      '~500 SF Bldg A NW collapse not costed',
      'Roof reserve likely understated: CBRE $4.00/SF vs Able $12.50/SF (3.1×)',
    ],
    'e-livingston': ['DRAFT — final PCA not obtained', 'Able signed price +$4,300.85 unexplained'],
    northwood: [
      'Conflicts with King/Pegnato 2026: roofs Poor, 2–4 yrs, 52,233 SF',
      'No roof replacement in reserve',
      'Only an inflated reserve ($33,653) is stated — $/SF/yr not derivable',
    ],
    raytown: ['Report states $218,500; year columns sum to $292,500 ($74,000 understated)', 'Table has wrong address / year / SF'],
    sunburst: ['Comment letter, not a full PCA — no reserves, no SF'],
    'info-lane': [
      'DRAFT — final PCR and fire-code response outstanding',
      'CO / lot / vintage mismatch',
      'S-1 COs vs church and fitness tenants [SPECULATIVE]',
      'Paving and exterior paint look light [SPECULATIVE; no bid]',
    ],
  },
  rentRolls: [
    {
      propertyKey: 'info-lane',
      propertyLabel: '29000 Information Ln',
      asOf: '2025-10-17',
      stale: true,
      note: '7 leases (10,500 SF) ended by 2026-10-08; units 105 and 106 since re-let; pull a current roll before relying on WALT.',
      provenance: {
        sourceFile: `${REPORT_FILE} §6`,
        sourceDate: '2025-10-17',
        priceBasis: 'PCA_CONSULTANT_ESTIMATE',
        status: 'STALE',
      },
    },
  ],
};

// ── 29000 Information Ln drill-down ──────────────────────────────────────────────────────────

export interface InfoLaneDetail {
  propertyKey: string;
  label: string;
  sf: number;
  provenance: Provenance;
  facts: Array<{ label: string; value: string }>;
  immediateUsd: number;
  immediateItems: Array<{ item: string; usd: number }>;
  shortTermUsd: number;
  reservesUninflUsd: number;
  reservesInflUsd: number;
  termYears: number;
  /** Uninflated reserve outlays by year. yr1 / yr2 are RESERVE outlays — never Immediate / Short-term. */
  reserveScheduleUninfl: Record<'yr1' | 'yr2' | 'yr6' | 'yr7' | 'yr10' | 'yr11', number>;
  systems: Array<{ system: string; usd: number }>;
  unitCosts: Array<{ item: string; usd: number; uom: string }>;
  conflicts: Array<{ text: string; speculative: boolean }>;
  correctionNote: string;
  rentRoll: {
    asOf: string;
    leases: number;
    baseRentUsd: number;
    baseRentPsf: number;
    waltYears: number;
    nnnLeases: number;
    grossLeases: number;
    rolloverSfByLeaseEndYear: Record<string, number>;
  };
}

export const INFO_LANE_DETAIL: InfoLaneDetail = {
  propertyKey: 'info-lane',
  label: '29000 Information Ln (Easton Tech Commons), Easton MD',
  sf: 48000,
  provenance: INFO_LANE_PROV,
  facts: [
    { label: 'Report', value: 'Intertek PCR T1643.01 — DRAFT 2025-10-29 (site visit 2025-10-21; 117 pp; ASTM E2018-24)' },
    { label: 'Purpose', value: 'Symetra loan (proposal 331168R0)' },
    { label: 'Owner of record', value: '29000 Information Lane LLC — acquired 2016-12-27 at $2,000,000' },
    { label: 'Site', value: '5 buildings, 48,000 SF, 4.64 ac, 2 parcels' },
    { label: 'Vintage', value: 'Built 2001 (B2–B4); expanded 2007 (B1, B5)' },
    { label: 'Condition', value: 'Good / Fair' },
    { label: 'Violations', value: 'No open building violations (Town of Easton, 2025-10-27); fire-code response pending' },
    { label: 'Roofs', value: 'Metal panel — 2001 (B2–B4), 2007 (B1, B5); no warranty; EUL 40; landlord responsibility' },
    { label: 'HVAC', value: 'Tenant-owned except landlord Rheem 1.5-ton split, unit 301 (2021)' },
    { label: 'Basis', value: 'Today’s dollars, 12 yrs, 2.5% escalation — PCA consultant estimate' },
  ],
  immediateUsd: 1100,
  immediateItems: [
    { item: 'ADA van space', usd: 275 },
    { item: 'ADA signs', usd: 225 },
    { item: 'ADA aisles', usd: 600 },
  ],
  shortTermUsd: 0,
  reservesUninflUsd: 133225,
  reservesInflUsd: 146304,
  termYears: 12,
  reserveScheduleUninfl: { yr1: 54681, yr2: 16182, yr6: 2362, yr7: 33000, yr10: 15000, yr11: 12000 },
  systems: [
    { system: 'Paving', usd: 74500 },
    { system: 'Exterior (paint / sealants)', usd: 34725 },
    { system: 'Roof maintenance', usd: 24000 },
  ],
  unitCosts: [
    { item: 'Full-depth asphalt', usd: 42.5, uom: 'SY' },
    { item: 'Seal & stripe', usd: 1.5, uom: 'SY' },
    { item: 'Mill & overlay', usd: 15, uom: 'SY' },
    { item: 'Exterior paint', usd: 1.5, uom: 'SF' },
    { item: 'Sealants', usd: 3.5, uom: 'LF' },
    { item: 'Roof sealant / fastener maintenance', usd: 0.25, uom: 'SF' },
  ],
  conflicts: [
    { text: 'CO / lot / vintage mismatch: 2007/2008 COs cite Lot 5, but SDAT shows built 2001.', speculative: false },
    { text: 'COs are S-1 storage, unsprinklered, while tenants include a church and a fitness studio — use-group / insurer / lender exposure; PCR silent.', speculative: true },
    { text: 'Paving $74,500 (56% of reserves) and exterior paint quantity look light vs report photos; no bid obtained.', speculative: true },
    { text: 'Rent roll (2025-10-17) is stale — 7 leases (10,500 SF) ended by 2026-10-08; WALT figure not current.', speculative: false },
    { text: 'CAM recoverability of roof / paving / paint reserve items is unreviewed.', speculative: false },
    { text: 'Utility and site conflicts: Delmarva vs Town of Easton service, and generator / transformer location.', speculative: false },
    { text: 'Final PCR and fire-code response are outstanding; the only report on hand is a DRAFT. The 2016 PCI report is stale (install dates only).', speculative: false },
  ],
  correctionNote:
    'Corrected 2026-10-08: earlier entries showed Immediate $54,681 / Short-term $16,182. Those are the Year 1 and Year 2 reserve outlays and are never displayed as Immediate / Short-term.',
  rentRoll: {
    asOf: '2025-10-17',
    leases: 24,
    baseRentUsd: 647545.56,
    baseRentPsf: 13.49,
    waltYears: 2.2,
    nnnLeases: 22,
    grossLeases: 2,
    rolloverSfByLeaseEndYear: { '2025': 1500, '2026': 12000, '2027': 12000, '2028': 12000, '2029': 6000, '2030': 4500 },
  },
};

// ── asset facts not in the register ──────────────────────────────────────────────────────────

export interface ExtraAssetFact {
  propertyKey: string;
  propertyLabel: string;
  component: string;
  installYear: number | null;
  eul: number | null;
  rul: number | null;
  rulAsOfYear: number | null;
  warrantyEndYear: number | null;
  note: string | null;
  /** Register component text this row replaces (matched by startsWith) so the clock never lists a roof twice. */
  supersedes: string | null;
  /** The register's own property_key for the row being replaced (it can differ from propertyKey). */
  supersedesPropertyKey?: string;
  provenance: Provenance;
}

export const EXTRA_ASSET_FACTS: ExtraAssetFact[] = [
  {
    propertyKey: 'info-lane', propertyLabel: '29000 Information Ln', component: 'Metal-panel roof B2–B4',
    installYear: 2001, eul: 40, rul: null, rulAsOfYear: null, warrantyEndYear: null, note: 'No warranty; landlord responsibility',
    supersedes: 'Buildings / metal roofs', supersedesPropertyKey: 'easton-tech-commons', provenance: INFO_LANE_PROV,
  },
  {
    propertyKey: 'info-lane', propertyLabel: '29000 Information Ln', component: 'Metal-panel roof B1, B5',
    installYear: 2007, eul: 40, rul: null, rulAsOfYear: null, warrantyEndYear: null, note: 'No warranty; landlord responsibility',
    supersedes: null, provenance: INFO_LANE_PROV,
  },
  {
    propertyKey: 'info-lane', propertyLabel: '29000 Information Ln', component: 'Asphalt ~10,000 SY',
    installYear: 2001, eul: null, rul: 1, rulAsOfYear: 2025, warrantyEndYear: null, note: 'Original 2001 / 2007; RUL 1 per Intertek',
    supersedes: null, provenance: INFO_LANE_PROV,
  },
  {
    propertyKey: 'info-lane', propertyLabel: '29000 Information Ln', component: 'Landlord Rheem 1.5-ton split, unit 301',
    installYear: 2021, eul: null, rul: null, rulAsOfYear: null, warrantyEndYear: null, note: 'Tenant-owned HVAC otherwise',
    supersedes: null, provenance: INFO_LANE_PROV,
  },
  {
    propertyKey: 'e-fifth', propertyLabel: '3540 E Fifth Ave', component: 'Roof — TPO 26,700 SF',
    installYear: 2022, eul: null, rul: null, rulAsOfYear: null, warrantyEndYear: 2042,
    note: 'Warranty end DERIVED: 20-yr term from the 2022-10-21 start (the register states the term and start, not an end date)',
    supersedes: 'Roof — TPO 26,700', supersedesPropertyKey: 'e-fifth',
    provenance: {
      sourceFile: `${REGISTER_FILE} > Asset_Facts (Contractors Inc. proposal: 20-yr Holcim/Firestone #700431934, start 2022-10-21)`,
      sourceDate: '2022-10-21', priceBasis: 'CONTRACTOR_QUOTE', status: 'CURRENT',
    },
  },
];

// ── open-issues queue ────────────────────────────────────────────────────────────────────────

export interface PcaIssue {
  no: number;
  property: string;
  title: string;
  detail: string;
  status: 'Open';
  owner: string;
}

const issue = (no: number, property: string, title: string, detail: string): PcaIssue => ({
  no, property, title, detail, status: 'Open', owner: '',
});

export const PCA_ISSUES: PcaIssue[] = [
  issue(1, '3520 E Fulton', 'CBRE scope gaps',
    'CBRE had no roof access; the NW collapse is uncosted; the $22,500 partner PCA / roof / MEP package is unsigned.'),
  issue(2, 'Banwick / Morrison', 'Summary docx errors vs Intertek',
    'Summary docx (4/28/2026) conflicts with Intertek: Morrison SF 37,300 vs 31,200; roof types; schedule totals; fire-code. Fix before it goes to Symetra.'),
  issue(3, 'Banwick', '"2518" appears in no source',
    'All sources say 2800-2826 (parcel 010-181360-00). Close unless another source for "2518" exists.'),
  issue(4, 'Raytown', 'EWI reserve understated $74,000',
    'Table has wrong address / year / SF. Use $292,500 (the report states $218,500; its year columns sum to $292,500).'),
  issue(5, 'Northwood', 'Roof conflict',
    'PCI 2024 (roofs good) vs King/Pegnato 2026 (Poor, 2–4 yrs, 52,233 SF); no roof replacement in the reserve.'),
  issue(6, 'Missing documents', 'Final reports outstanding',
    '29000 Info Ln final PCR and fire-code response; Livingston final PCA; 1900 N Broadway PES PCA body; explanation of Able +$4,300.85.'),
  issue(7, 'Address checks', 'Sheriff and E 14th',
    '6300 vs 6410 Sheriff; 2920 vs 2892 E 14th.'),
  issue(8, '29000 Info Ln', 'Compliance, rent roll and cost conflicts',
    'CO / lot / vintage mismatch; S-1 COs vs church / fitness tenants [SPECULATIVE]; stale rent roll; paving / paint look light [SPECULATIVE; no bid]; CAM recoverability; Delmarva vs Town of Easton and generator / transformer location conflicts.'),
  issue(9, 'Cost seg (D1–D14)', 'Cost segregation discrepancies',
    'D1–D14: Livingston GBA 11,280 vs 10,950 SF and a three-surface roof; Northwood modeled 54,000 SF roof, alarm-only / church / auto-service use [SPECULATIVE] and "septic" / "120V 400A" wording; Red Branch "Muirkirk" naming vs the PCA register; Rarig books vs study basis; Fishel PIS date, lease status (ran to 9/30/2026) and generator; Broadway elevator / sprinkler / PES PCA gap. Full list on the Cost seg view.'),
];
