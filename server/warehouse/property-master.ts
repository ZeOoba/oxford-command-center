// server/warehouse/property-master.ts
import { createHash } from 'node:crypto';
import { PropertyMasterRowSchema, type PropertyMasterRow } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';
import { stableStringify } from './stable-stringify';

function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export interface PropertyMasterRecord {
  id: string;
  name: string;
  market: string | null;
  rentableSf: number | null;
  ownershipPct: number;
  ownershipStatus: string;
  assetClass: string | null;
  source: 'db' | 'seed';
}

interface DbPropertyRow {
  id: string;
  name: string;
  market: string | null;
  rentable_sf: number | null;
  ownership_pct: number;
  ownership_status: string;
  asset_class: string | null;
}

/** DB rows win on id conflict; seed entries fill in any id absent from the DB. */
export function getPropertyMaster(db: WarehouseDb): PropertyMasterRecord[] {
  const dbRows = db.prepare(
    'SELECT id, name, market, rentable_sf, ownership_pct, ownership_status, asset_class FROM property_master',
  ).all() as DbPropertyRow[];
  const dbIds = new Set(dbRows.map((r) => r.id));
  const dbRecords: PropertyMasterRecord[] = dbRows.map((r) => ({
    id: r.id,
    name: r.name,
    market: r.market,
    rentableSf: r.rentable_sf,
    ownershipPct: r.ownership_pct,
    ownershipStatus: r.ownership_status,
    assetClass: r.asset_class,
    source: 'db' as const,
  }));
  const seedRecords: PropertyMasterRecord[] = CANON_PROPERTIES
    .filter((s) => !dbIds.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      market: s.market ?? null,
      rentableSf: s.rentableSf ?? null,
      ownershipPct: s.ownershipPct,
      ownershipStatus: s.ownershipStatus,
      assetClass: s.assetClass ?? null,
      source: 'seed' as const,
    }));
  return [...dbRecords, ...seedRecords].sort((a, b) => a.name.localeCompare(b.name));
}

const KRG = { propertyManager: 'Kohr Royer Griffith', pmContact: 'Paul Trautman' };

/** Gabriel-ratified 2026-06-12 (memory/pfi-build-canon.md). Do not edit without a new ruling. */
export const CANON_PROPERTIES: PropertyMasterRow[] = ([
  { id: '3540-e-5th-ave-columbus-oh', name: '3540 E. 5th Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 35886, acquisitionDate: '2022-01-21', assetClass: 'Flex', ...KRG },
  { id: '3034-westerville-rd-columbus-oh', name: '3034 Westerville Rd, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 18000, acquisitionDate: '2024-09-22', assetClass: 'Flex', notes: 'Coverage starts 2025 (ratified).', ...KRG },
  { id: '3875-3883-e-livingston-ave-columbus-oh', name: '3875-3883 E Livingston Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 10950, acquisitionDate: '2025-06-01', assetClass: 'Flex', ...KRG },
  { id: 'sepich-portfolio-columbus-oh-8-props', name: 'FVC — Fairground Village Center / Sepich Portfolio (8 props)', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 110000, acquisitionDate: '2021-03-16', assetClass: 'Flex', notes: 'ENTITY-LEVEL official unit. FVC 2025 contains $500k one-time cell-tower easement sale (exclude from run-rate). Zettler sale dead — still owned.', ...KRG },
  { id: '1100-rarig-ave-columbus-oh', name: '1100 Rarig Ave, Columbus OH', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 21000, acquisitionDate: '2023-10-06', assetClass: 'Flex', ...KRG },
  { id: '29000-information-lane-easton-md', name: '29000 Information Lane, Easton MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 48000, acquisitionDate: '2021-01-01', assetClass: 'Flex', propertyManager: 'Thomas Park', pmContact: 'Civita Peters' },
  { id: '9620-e-state-route-350-raytown-mo', name: '9620 E State Route 350, Raytown MO', market: 'Kansas City MO', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 34560, acquisitionDate: '2024-10-22', assetClass: 'Flex', propertyManager: 'Peak Real Estate Partners', pmContact: 'Hank Simpson; Garrett Alejos', notes: 'Coverage starts 2025 (ratified).' },
  { id: '9050-red-branch-rd-columbia-md', name: '9050 Red Branch Rd, Columbia MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 0.5, ownershipStatus: 'active', rentableSf: 90000, acquisitionDate: '2015-08-27', assetClass: 'Flex', propertyManager: 'CRC', pmContact: 'Steve She' },
  { id: '1900-n-broadway-baltimore-md', name: '1900 N Broadway, Baltimore MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 0.5, ownershipStatus: 'active', rentableSf: 27671, acquisitionDate: '2015-08-31', assetClass: 'Retail', propertyManager: 'CRC', pmContact: 'Steve She' },
  { id: '7658-fishel-dr-n-dublin-oh', name: '7658 Fishel Dr N, Dublin OH', market: 'Columbus OH', financialMode: 'lease-run', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 24000, acquisitionDate: '2026-01-29', assetClass: 'Flex', notes: 'Run off master lease with estimated capex (ratified).' },
  { id: '401-sunburst-hwy-cambridge-md', name: '401 Sunburst Hwy, Cambridge MD', market: 'Mid-Atlantic', financialMode: 'lease-run', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 5100, acquisitionDate: '2026-01-26', assetClass: 'Retail', notes: 'Run off master lease with estimated capex (ratified).' },
  { id: '55-new-plant-ct-owings-mills-md', name: '55 New Plant Ct, Owings Mills MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 34534, acquisitionDate: '2016-12-05', assetClass: 'Flex', notes: 'EGFLLC QuickBooks books; distributions-as-expenses defect — engine excludes.' },
  { id: '2203-2207-northwood-dr-salisbury-md', name: '2203-2207 Northwood Dr, Salisbury MD', market: 'Mid-Atlantic', financialMode: 'pnl', ownershipPct: 1, ownershipStatus: 'active', rentableSf: 53700, acquisitionDate: '2024-10-03', assetClass: 'Flex', propertyManager: 'SVN', pmContact: 'Brady Smith', pmPlatform: 'AppFolio', notes: 'Coverage starts 2025 (ratified). AppFolio Cash Flow reports — reclassify owner transfers/interest on ingest.' },
  { id: '1851-s-club-solar', name: '1851 S Club — Solar (25% roof project)', market: 'Columbus OH', financialMode: 'pnl', ownershipPct: 0.25, ownershipStatus: 'active', rentableSf: null, acquisitionDate: null, assetClass: 'Solar', notes: 'No real estate owned — 25% roof/solar project (Perfect Settings PPA). Building sold to RLIF East.' },
] as const).map((row) => PropertyMasterRowSchema.parse(row));

/** Hash of every field seedPropertyMaster writes, excluding id (the key) and the timestamp columns
 *  themselves — so an unchanged row reseeds to an identical hash regardless of when it runs. */
function contentHash(r: PropertyMasterRow): string {
  return sha16(stableStringify({
    name: r.name, market: r.market ?? null,
    propertyManager: r.propertyManager ?? null, pmContact: r.pmContact ?? null,
    pmPlatform: r.pmPlatform ?? null, financialMode: r.financialMode,
    rentableSf: r.rentableSf ?? null, acquisitionDate: r.acquisitionDate ?? null,
    ownershipPct: r.ownershipPct, ownershipStatus: r.ownershipStatus,
    assetClass: r.assetClass ?? null, notes: r.notes ?? null,
  }));
}

export function seedPropertyMaster(db: WarehouseDb): void {
  const up = db.prepare(`
    INSERT INTO property_master (id, name, market, property_manager, pm_contact, pm_platform,
      financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status, asset_class, notes,
      content_hash)
    VALUES (@id, @name, @market, @propertyManager, @pmContact, @pmPlatform,
      @financialMode, @rentableSf, @acquisitionDate, @ownershipPct, @ownershipStatus, @assetClass, @notes,
      @contentHash)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, market=excluded.market, property_manager=excluded.property_manager,
      pm_contact=excluded.pm_contact, pm_platform=excluded.pm_platform, financial_mode=excluded.financial_mode,
      rentable_sf=excluded.rentable_sf, acquisition_date=excluded.acquisition_date,
      ownership_pct=excluded.ownership_pct, ownership_status=excluded.ownership_status,
      asset_class=excluded.asset_class, notes=excluded.notes,
      content_hash=excluded.content_hash,
      updated_at=CASE WHEN property_master.content_hash IS excluded.content_hash
        THEN property_master.updated_at ELSE datetime('now') END
  `);
  const tx = db.transaction((rows: PropertyMasterRow[]) => {
    for (const r of rows) {
      up.run({
        id: r.id, name: r.name, market: r.market ?? null,
        propertyManager: r.propertyManager ?? null, pmContact: r.pmContact ?? null,
        pmPlatform: r.pmPlatform ?? null, financialMode: r.financialMode,
        rentableSf: r.rentableSf ?? null, acquisitionDate: r.acquisitionDate ?? null,
        ownershipPct: r.ownershipPct, ownershipStatus: r.ownershipStatus,
        assetClass: r.assetClass ?? null, notes: r.notes ?? null,
        contentHash: contentHash(r),
      });
    }
  });
  tx(CANON_PROPERTIES);
}
