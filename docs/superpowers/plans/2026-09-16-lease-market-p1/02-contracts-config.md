### Task 02: Contracts + market config

**Files:**
- Create: `src/contracts/lease-market.ts`
- Create: `config/lease-market.json`
- Test: `tests/unit/lease-market-contract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact exported names, used by every later task): `RentBasis`, `LmSubtype`, `BuildingStatus`, `SIZE_BANDS`, `SizeBand`, `OfficeStratum`, `OwnerType`, `ListingStatus`, `OriginTier`, `ObservationConfidence`, `OpexComponent`, `CanonicalListingRow`, `OpexDefaults`, `LmMarketConfig`, `OraPropertyConfig`, `LmThresholds`, `LeaseMarketConfig`, `CellBenchmark`, `MarketFreshness`, `DistributionPoint`, `DomBin`, `LeaseMarketSummaryResponse`, `PositioningBand`, `PositioningRow`, `PositioningResponse`, `SignalKind`, `SignalSeverity`, `EvidenceValue`, `SignalRow`, `SignalsResponse` — each both a Zod schema and a same-named `z.infer` type.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LeaseMarketConfig, CanonicalListingRow, SIZE_BANDS } from '../../src/contracts/lease-market';

const shipped = JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.json'), 'utf8')) as unknown;

describe('lease-market contracts', () => {
  it('the shipped config parses', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    expect(cfg.markets.map((m) => m.id)).toContain('columbus');
    expect(cfg.thresholds.belowMarketMedianRatio).toBe(0.85);
    expect(cfg.thresholds.benchmarkMinN).toBe(5);
    expect(cfg.thresholds.belowMarketMinN).toBe(10);
  });

  it('shipped config carries no fabricated opex numbers', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    for (const m of cfg.markets) {
      expect(m.opexDefaults.warehouse).toBeNull();
      expect(m.opexDefaults.flex).toBeNull();
    }
  });

  it('rejects an ORA property pointing at an unknown market', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    const bad = {
      ...cfg,
      oraProperties: [
        { propertyKey: 'X', marketId: 'nowhere', submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 5000, leaseBasis: 'NNN', addressNorms: ['1 MAIN ST'] },
      ],
    };
    expect(LeaseMarketConfig.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate market ids', () => {
    const cfg = LeaseMarketConfig.parse(shipped);
    const bad = { ...cfg, markets: [cfg.markets[0], cfg.markets[0]] };
    expect(LeaseMarketConfig.safeParse(bad).success).toBe(false);
  });

  it('size bands are ordered smallest to largest', () => {
    expect(SIZE_BANDS).toEqual(['<5K', '5-15K', '15-30K', '30-50K', '50-80K']);
  });

  it('canonical row requires positive available SF', () => {
    const row = {
      costarPropertyId: null, address: '1 Main St', suite: null, city: null, state: null, submarket: null,
      subtype: 'warehouse', buildingStatus: 'existing', buildingSf: null, yearBuilt: null, clearHeightFt: null,
      docks: null, driveIns: null, officePct: null, ownerName: null, availableSf: 0, minDivisibleSf: null,
      rentLow: null, rentHigh: null, rentPeriod: null, rentBasis: 'WITHHELD', isSublease: false, costarDateOnMarket: null,
    };
    expect(CanonicalListingRow.safeParse(row).success).toBe(false);
    expect(CanonicalListingRow.safeParse({ ...row, availableSf: 1200 }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-contract.test.ts`
Expected: FAIL — cannot resolve `../../src/contracts/lease-market`.

- [ ] **Step 3: Write the contracts**

```ts
// src/contracts/lease-market.ts
//
// Lease Market Intelligence — shared Zod contracts.
// Spec: docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md (rev 2).
// Server routes parse responses through these before emitting; client hooks validate with the same schemas.
import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────
export const RentBasis = z.enum(['NNN', 'MG', 'IG', 'GROSS', 'FSG', 'UNKNOWN', 'WITHHELD']);
export type RentBasis = z.infer<typeof RentBasis>;
export const LmSubtype = z.enum(['warehouse', 'flex']);
export type LmSubtype = z.infer<typeof LmSubtype>;
export const BuildingStatus = z.enum(['existing', 'proposed', 'under_construction', 'unknown']);
export type BuildingStatus = z.infer<typeof BuildingStatus>;
export const SIZE_BANDS = ['<5K', '5-15K', '15-30K', '30-50K', '50-80K'] as const;
export const SizeBand = z.enum(SIZE_BANDS);
export type SizeBand = z.infer<typeof SizeBand>;
export const OfficeStratum = z.enum(['all', 'office_lt40', 'office_ge40']);
export type OfficeStratum = z.infer<typeof OfficeStratum>;
export const OwnerType = z.enum(['institutional', 'verify', 'affiliated', 'never_call', 'private', 'unknown']);
export type OwnerType = z.infer<typeof OwnerType>;
export const ListingStatus = z.enum(['active', 'missing_once', 'removed', 'expired']);
export type ListingStatus = z.infer<typeof ListingStatus>;
export const OriginTier = z.enum(['T1', 'T2', 'T5']);
export type OriginTier = z.infer<typeof OriginTier>;
export const ObservationConfidence = z.enum(['high', 'low']);
export type ObservationConfidence = z.infer<typeof ObservationConfidence>;
export const OpexComponent = z.enum(['tax', 'ins', 'cam']);
export type OpexComponent = z.infer<typeof OpexComponent>;

// ── Canonical listing row: the ONLY shape downstream of a parser ──────────────
export const CanonicalListingRow = z.object({
  costarPropertyId: z.string().nullable(),
  address: z.string().min(1),
  suite: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  buildingStatus: BuildingStatus,
  buildingSf: z.number().positive().nullable(),
  yearBuilt: z.number().int().nullable(),
  clearHeightFt: z.number().nonnegative().nullable(),
  docks: z.number().int().nonnegative().nullable(),
  driveIns: z.number().int().nonnegative().nullable(),
  officePct: z.number().min(0).max(100).nullable(),
  ownerName: z.string().nullable(),
  availableSf: z.number().positive(),
  minDivisibleSf: z.number().positive().nullable(),
  rentLow: z.number().nonnegative().nullable(),
  rentHigh: z.number().nonnegative().nullable(),
  rentPeriod: z.enum(['yr', 'mo']).nullable(), // null = period not stated
  rentBasis: RentBasis,
  isSublease: z.boolean(),
  costarDateOnMarket: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type CanonicalListingRow = z.infer<typeof CanonicalListingRow>;

// ── Config ────────────────────────────────────────────────────────────────────
export const OpexDefaults = z.object({
  tax: z.number().nonnegative(),
  ins: z.number().nonnegative(),
  cam: z.number().nonnegative(),
  source: z.string().min(1),
  asOf: z.string().min(1),
});
export type OpexDefaults = z.infer<typeof OpexDefaults>;

export const LmMarketConfig = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  tier: z.enum(['established', 'entry']),
  costarMarketNames: z.array(z.string()),
  mgLandlordPays: z.array(OpexComponent),
  opexDefaults: z.object({ warehouse: OpexDefaults.nullable(), flex: OpexDefaults.nullable() }),
});
export type LmMarketConfig = z.infer<typeof LmMarketConfig>;

export const OraPropertyConfig = z.object({
  propertyKey: z.string().min(1), // raw rent-roll label, e.g. "1100 Rarig" (Lease.propertyKey)
  marketId: z.string().min(1),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  officePct: z.number().min(0).max(100).nullable(),
  typicalUnitSf: z.number().positive(),
  leaseBasis: z.enum(['NNN', 'MG', 'GROSS', 'UNKNOWN']),
  addressNorms: z.array(z.string().min(1)), // splitAddress(...).addressNorm values for this property
});
export type OraPropertyConfig = z.infer<typeof OraPropertyConfig>;

export const LmThresholds = z.object({
  benchmarkMinN: z.number().int().positive(),
  belowMarketMinN: z.number().int().positive(),
  belowMarketMedianRatio: z.number().positive().max(1),
  lowCoverageQuotedShare: z.number().min(0).max(1),
  staleFloorDays: z.number().int().positive(),
  staleBaselineMultiple: z.number().positive(),
  staleFallbackDays: z.object({ established: z.number().int().positive(), entry: z.number().int().positive() }),
  completedDomMinN: z.number().int().positive(),
  vacancyShareMin: z.number().min(0).max(1),
  candidateMaxBuildingSf: z.number().positive(),
  benchmarkMaxBuildingSf: z.number().positive(),
  positioningBandPct: z.number().positive(),
  rangeMaxSpread: z.number().positive(),
  monthlyValueCeiling: z.number().positive(),
  exportMinRowRatio: z.number().min(0).max(1),
  exportRowCap: z.number().int().positive(),
  freshnessDays: z.number().int().positive(),
  flexOfficeSplitPct: z.number().min(0).max(100),
});
export type LmThresholds = z.infer<typeof LmThresholds>;

export const LeaseMarketConfig = z
  .object({
    version: z.literal(1),
    mirrorRowLevel: z.boolean(),
    ownerScreenModulePath: z.string().min(1),
    markets: z.array(LmMarketConfig).min(1),
    oraProperties: z.array(OraPropertyConfig),
    thresholds: LmThresholds,
  })
  .superRefine((c, ctx) => {
    const ids = new Set(c.markets.map((m) => m.id));
    if (ids.size !== c.markets.length) ctx.addIssue({ code: 'custom', message: 'duplicate market id in markets[]' });
    for (const p of c.oraProperties) {
      if (!ids.has(p.marketId)) {
        ctx.addIssue({ code: 'custom', message: `oraProperties["${p.propertyKey}"].marketId "${p.marketId}" is not a configured market` });
      }
    }
  });
export type LeaseMarketConfig = z.infer<typeof LeaseMarketConfig>;

// ── API responses ─────────────────────────────────────────────────────────────
export const CellBenchmark = z.object({
  cellKey: z.string(),
  marketId: z.string(),
  submarket: z.string().nullable(),
  subtype: LmSubtype,
  sizeBand: SizeBand,
  officeStratum: OfficeStratum,
  rolledUp: z.enum(['none', 'size_band', 'market']),
  n: z.number().int().nonnegative(),
  totalN: z.number().int().nonnegative(),
  quotedShare: z.number().min(0).max(1),
  p25: z.number().nullable(),
  median: z.number().nullable(),
  p75: z.number().nullable(),
  lowCoverage: z.boolean(),
});
export type CellBenchmark = z.infer<typeof CellBenchmark>;

export const MarketFreshness = z.object({
  marketId: z.string(),
  label: z.string(),
  lastLandingDate: z.string().nullable(),
  lastCompleteDate: z.string().nullable(),
  lastCompleteness: z.enum(['complete', 'partial']).nullable(),
  partialReason: z.string().nullable(),
  stale: z.boolean(),
});
export type MarketFreshness = z.infer<typeof MarketFreshness>;

export const DistributionPoint = z.object({
  listingId: z.number().int(),
  marketId: z.string(),
  subtype: LmSubtype,
  sizeBand: SizeBand,
  askingNnnEq: z.number(),
  solid: z.boolean(), // benchmark-eligible (NNN quoted); false = converted / low confidence
  isOra: z.boolean(),
  address: z.string().nullable(), // null when config.mirrorRowLevel is false
});
export type DistributionPoint = z.infer<typeof DistributionPoint>;

export const DomBin = z.object({ label: z.string(), count: z.number().int().nonnegative() });
export type DomBin = z.infer<typeof DomBin>;

export const LeaseMarketSummaryResponse = z.object({
  asOf: z.string(),
  rowLevel: z.boolean(),
  freshness: z.array(MarketFreshness),
  benchmarks: z.array(CellBenchmark),
  distribution: z.array(DistributionPoint),
  domByMarket: z.array(z.object({ marketId: z.string(), bins: z.array(DomBin) })),
});
export type LeaseMarketSummaryResponse = z.infer<typeof LeaseMarketSummaryResponse>;

export const PositioningBand = z.enum(['above', 'in_band', 'below', 'unknown']);
export type PositioningBand = z.infer<typeof PositioningBand>;

export const PositioningRow = z.object({
  propertyKey: z.string(),
  unit: z.string().nullable(),
  sf: z.number().nonnegative(),
  oraAskingNnnEq: z.number().nullable(),
  cell: CellBenchmark.nullable(),
  percentile: z.number().min(0).max(1).nullable(),
  gapPct: z.number().nullable(),
  band: PositioningBand,
  effectiveDom: z.number().int().nullable(),
});
export type PositioningRow = z.infer<typeof PositioningRow>;

export const PositioningResponse = z.object({
  asOf: z.string(),
  unconfiguredPropertyKeys: z.array(z.string()),
  rows: z.array(PositioningRow),
});
export type PositioningResponse = z.infer<typeof PositioningResponse>;

export const SignalKind = z.enum(['new_listing', 'stale', 'rent_cut', 'below_market', 'acq_candidate']);
export type SignalKind = z.infer<typeof SignalKind>;
export const SignalSeverity = z.enum(['info', 'watch', 'high']);
export type SignalSeverity = z.infer<typeof SignalSeverity>;
export const EvidenceValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type EvidenceValue = z.infer<typeof EvidenceValue>;

export const SignalRow = z.object({
  id: z.number().int(),
  listingId: z.number().int(),
  marketId: z.string(),
  address: z.string().nullable(),
  kind: SignalKind,
  severity: SignalSeverity,
  cellKey: z.string().nullable(),
  computedAt: z.string(),
  evidence: z.record(z.string(), EvidenceValue),
});
export type SignalRow = z.infer<typeof SignalRow>;

export const SignalsResponse = z.object({
  asOf: z.string(),
  candidatesWithheld: z.array(z.object({ marketId: z.string(), reason: z.string() })),
  signals: z.array(SignalRow),
});
export type SignalsResponse = z.infer<typeof SignalsResponse>;
```

- [ ] **Step 4: Write the shipped config**

`exportRowCap` 2000 is provisional; the controller re-checks it against a real CoStar export (Task 99). `oraProperties` starts empty; the controller fills it (Task 99).

```json
{
  "version": 1,
  "mirrorRowLevel": true,
  "ownerScreenModulePath": "~/.claude/skills/county-parcel-screen/scripts/institutional_owners.py",
  "markets": [
    { "id": "columbus", "label": "Columbus", "tier": "established", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "kansas-city", "label": "Kansas City", "tier": "established", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "baltimore", "label": "Baltimore", "tier": "established", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "eastern-shore-md", "label": "Eastern Shore MD", "tier": "established", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "cincinnati", "label": "Cincinnati", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "indianapolis", "label": "Indianapolis", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "madison", "label": "Madison", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "grand-rapids", "label": "Grand Rapids", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "richmond", "label": "Richmond", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "des-moines", "label": "Des Moines", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } },
    { "id": "louisville", "label": "Louisville", "tier": "entry", "costarMarketNames": [], "mgLandlordPays": ["tax", "ins"], "opexDefaults": { "warehouse": null, "flex": null } }
  ],
  "oraProperties": [],
  "thresholds": {
    "benchmarkMinN": 5,
    "belowMarketMinN": 10,
    "belowMarketMedianRatio": 0.85,
    "lowCoverageQuotedShare": 0.5,
    "staleFloorDays": 180,
    "staleBaselineMultiple": 1.5,
    "staleFallbackDays": { "established": 180, "entry": 270 },
    "completedDomMinN": 10,
    "vacancyShareMin": 0.3,
    "candidateMaxBuildingSf": 50000,
    "benchmarkMaxBuildingSf": 80000,
    "positioningBandPct": 0.1,
    "rangeMaxSpread": 0.2,
    "monthlyValueCeiling": 3,
    "exportMinRowRatio": 0.7,
    "exportRowCap": 2000,
    "freshnessDays": 35,
    "flexOfficeSplitPct": 40
  }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/unit/lease-market-contract.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/contracts/lease-market.ts config/lease-market.json tests/unit/lease-market-contract.test.ts
git commit -F <message-file>   # "feat(contracts): lease market contracts and market config"
```
