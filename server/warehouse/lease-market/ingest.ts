// server/warehouse/lease-market/ingest.ts
//
// Lease Market Intelligence — CoStar listings ingest (spec rev 3 §3.1-3.5).
// One transaction per file. Property (building) and listing (space) are separate entities.
// Only COMPLETE exports move listings toward removal, and removal needs two consecutive complete
// exports without the space (missing_once -> removed). Financial-decision source: refute pass required.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { WarehouseDb } from '../db';
import type { LeaseMarketConfig } from '../../../src/contracts/lease-market';
import type { ListingEventKind, LmSubtype } from '../../../src/contracts/lease-market';
import { addDays, daysBetween, priceObservation, resolveOpex, splitAddress, type OpexEstimate } from '../../../src/analytics/lease-market/normalize';
import { CostarParseError, parseCostarListingsFile, sha256File, type CostarHeaderMap, type ParsedCostarExport } from './costar-parse';
import type { OwnerScreenResult } from './owner-screen';

export interface IngestDeps {
  config: LeaseMarketConfig;
  headerMap: CostarHeaderMap;
  rawDir: string;
  now: () => string;
  screen: (names: string[]) => OwnerScreenResult;
}

export interface IngestResult {
  file: string;
  status: 'ingested' | 'duplicate' | 'failed';
  landingId: number | null;
  marketId: string | null;
  exportDate: string | null;
  completeness: 'complete' | 'partial' | null;
  partialReason: string | null;
  insertedSpaces: number;
  updatedSpaces: number;
  newProperties: number;
  skipped: number;
  markedMissing: number;
  markedRemoved: number;
  events: Record<ListingEventKind, number>;
  error: string | null;
}

const FILE_RE = /^costar-listings_([a-z0-9-]+)_(\d{4}-\d{2}-\d{2})\.(xlsx|csv)$/i;

export function parseListingFileName(name: string): { marketId: string; exportDate: string } | null {
  const m = FILE_RE.exec(name);
  return m ? { marketId: m[1]!.toLowerCase(), exportDate: m[2]! } : null;
}

export interface CompleteLanding {
  id: number;
  observed_at: string;
  row_count: number;
  header_fingerprint: string | null;
  owner_screen_ok: number;
}

export function latestCompleteLanding(db: WarehouseDb, marketId: string): CompleteLanding | undefined {
  return db
    .prepare(
      `SELECT id, observed_at, row_count, header_fingerprint, owner_screen_ok FROM lm_landing
       WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' AND completeness = 'complete'
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(marketId) as CompleteLanding | undefined;
}

const EVENT_KINDS: readonly ListingEventKind[] = ['new', 'returned', 'price_cut', 'price_increase', 'sf_change', 'dom_reset', 'missing', 'removed'];
const CENT = 0.005;

function emptyEvents(): Record<ListingEventKind, number> {
  return Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<ListingEventKind, number>;
}

export async function ingestCostarListingsFile(db: WarehouseDb, filePath: string, deps: IngestDeps): Promise<IngestResult> {
  const file = basename(filePath);
  const result: IngestResult = {
    file, status: 'failed', landingId: null, marketId: null, exportDate: null, completeness: null, partialReason: null,
    insertedSpaces: 0, updatedSpaces: 0, newProperties: 0, skipped: 0, markedMissing: 0, markedRemoved: 0, events: emptyEvents(), error: null,
  };
  const sha = sha256File(filePath);
  const dup = db.prepare(`SELECT id FROM lm_landing WHERE sha256 = ? AND parse_status = 'ok'`).get(sha) as { id: number } | undefined;
  if (dup) return { ...result, status: 'duplicate', landingId: dup.id };

  const fail = (marketId: string | null, observedAt: string, error: string): IngestResult => {
    const info = db
      .prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status, parse_error)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, 'n/a', 'failed', ?)`,
      )
      .run(file, sha, marketId, observedAt, deps.now(), error);
    return { ...result, landingId: Number(info.lastInsertRowid), marketId, exportDate: observedAt, error };
  };

  const fromName = parseListingFileName(file);
  const exportDate = fromName?.exportDate ?? statSync(filePath).mtime.toISOString().slice(0, 10);

  let parsed: ParsedCostarExport;
  try {
    parsed = await parseCostarListingsFile(filePath, deps.headerMap);
  } catch (e) {
    if (e instanceof CostarParseError) return fail(fromName?.marketId ?? null, exportDate, e.message);
    throw e;
  }

  let marketId = fromName?.marketId ?? null;
  if (marketId === null) {
    const ids = new Set<string>();
    for (const name of parsed.marketNames) {
      const m = deps.config.markets.find((mk) => mk.costarMarketNames.some((c) => c.toLowerCase() === name.toLowerCase()));
      if (!m) return fail(null, exportDate, `market "${name}" is not in any configured market's costarMarketNames`);
      ids.add(m.id);
    }
    if (ids.size !== 1) {
      return fail(
        null,
        exportDate,
        ids.size === 0
          ? 'cannot determine market: name the file costar-listings_<marketId>_<YYYY-MM-DD>.xlsx or map the market column'
          : `export spans ${ids.size} markets; export one market per file`,
      );
    }
    marketId = [...ids][0]!;
  }
  const market = deps.config.markets.find((m) => m.id === marketId);
  if (!market) return fail(marketId, exportDate, `market id "${marketId}" is not in config/lease-market.json`);

  if (!market.enabled) {
    return fail(marketId, exportDate, `market "${marketId}" is not enabled in config/lease-market.json (Columbus-first validation gate)`);
  }

  const prior = latestCompleteLanding(db, marketId);
  if (prior && prior.header_fingerprint !== null && prior.header_fingerprint !== parsed.headerFingerprint) {
    return fail(marketId, exportDate, `header set changed vs landing #${prior.id}; update config/lease-market.costar-headers.json, then re-ingest`);
  }

  const t = deps.config.thresholds;
  const reasons: string[] = [];
  if (parsed.rowCount >= t.exportRowCap) reasons.push(`row count ${parsed.rowCount} at export cap ${t.exportRowCap}`);
  if (prior && parsed.rowCount < t.exportMinRowRatio * prior.row_count) {
    reasons.push(`row count ${parsed.rowCount} < ${t.exportMinRowRatio} x prior ${prior.row_count}`);
  }
  if (prior && exportDate <= prior.observed_at) reasons.push(`export date ${exportDate} not after last complete export ${prior.observed_at}`);
  const complete = reasons.length === 0;

  const screen = deps.screen(parsed.rows.flatMap((r) => (r.ownerName ? [r.ownerName] : [])));

  mkdirSync(deps.rawDir, { recursive: true });
  const rawPath = join(deps.rawDir, `${sha}${extname(filePath).toLowerCase()}`);
  copyFileSync(filePath, rawPath);

  const quotedRows = db
    .prepare(
      `SELECT p.subtype AS subtype, o.opex_quoted_psf AS v FROM lm_observation o
       JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id
       WHERE p.market_id = ? AND o.opex_quoted_psf IS NOT NULL AND o.observed_at >= ?`,
    )
    .all(marketId, addDays(exportDate, -365)) as Array<{ subtype: LmSubtype; v: number }>;
  const quoted: Record<LmSubtype, number[]> = { warehouse: [], flex: [] };
  for (const q of quotedRows) quoted[q.subtype].push(q.v);
  for (const r of parsed.rows) if (r.opexQuotedPsf !== null) quoted[r.subtype].push(r.opexQuotedPsf);
  const opexBySubtype: Record<LmSubtype, OpexEstimate | null> = {
    warehouse: resolveOpex(market.opexDefaults.warehouse, quoted.warehouse, t.quotedOpexMinN),
    flex: resolveOpex(market.opexDefaults.flex, quoted.flex, t.quotedOpexMinN),
  };

  const events = emptyEvents();
  const counts = { insertedSpaces: 0, updatedSpaces: 0, newProperties: 0, skipped: parsed.skipped.length, markedMissing: 0, markedRemoved: 0 };
  let landingId = 0;

  db.transaction(() => {
    landingId = Number(
      db.prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, file_path, row_count, skipped_count,
           header_fingerprint, completeness, partial_reason, owner_screen_ok, parse_status)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      ).run(file, sha, marketId, exportDate, deps.now(), rawPath, parsed.rowCount, parsed.skipped.length, parsed.headerFingerprint,
        complete ? 'complete' : 'partial', complete ? null : reasons.join('; '), screen.available ? 1 : 0).lastInsertRowid,
    );

    const findPropertyByCostarId = db.prepare('SELECT id FROM lm_property WHERE costar_property_id = ? ORDER BY id LIMIT 1');
    const findPropertyByAddress = db.prepare('SELECT id FROM lm_property WHERE address_norm = ?');
    const insertProperty = db.prepare(
      `INSERT INTO lm_property (costar_property_id, address_norm, address_display, city, state, zip, lat, lon, market_id, submarket, subtype,
         building_status, building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type, ora_property_key, first_seen, last_seen)
       VALUES (@costarPropertyId, @addressNorm, @addressDisplay, @city, @state, @zip, @lat, @lon, @marketId, @submarket, @subtype,
         @buildingStatus, @buildingSf, @yearBuilt, @clearHeightFt, @docks, @driveIns, @officePct, @ownerName, @ownerType, @oraPropertyKey, @seen, @seen)`,
    );
    const updateProperty = db.prepare(
      `UPDATE lm_property SET
         costar_property_id = COALESCE(@costarPropertyId, costar_property_id), address_display = @addressDisplay,
         city = COALESCE(@city, city), state = COALESCE(@state, state), zip = COALESCE(@zip, zip),
         lat = COALESCE(@lat, lat), lon = COALESCE(@lon, lon), submarket = COALESCE(@submarket, submarket),
         subtype = @subtype, building_status = @buildingStatus,
         building_sf = COALESCE(@buildingSf, building_sf), year_built = COALESCE(@yearBuilt, year_built),
         clear_height_ft = COALESCE(@clearHeightFt, clear_height_ft), docks = COALESCE(@docks, docks),
         drive_ins = COALESCE(@driveIns, drive_ins), office_pct = COALESCE(@officePct, office_pct),
         owner_name = COALESCE(@ownerName, owner_name),
         owner_type = CASE WHEN @ownerName IS NULL THEN owner_type ELSE @ownerType END,
         ora_property_key = COALESCE(@oraPropertyKey, ora_property_key),
         last_seen = MAX(last_seen, @seen)
       WHERE id = @id`,
    );
    const findSpace = db.prepare('SELECT id, status FROM lm_listing WHERE property_id = ? AND suite_norm = ?');
    const insertSpace = db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, costar_date_on_market, status, origin_tier,
         broker_name, broker_company, listing_url, description)
       VALUES (@propertyId, @suiteNorm, @seen, @seen, @landingId, @dateOnMarket, 'active', 'T1', @brokerName, @brokerCompany, @listingUrl, @description)`,
    );
    const updateSpace = db.prepare(
      `UPDATE lm_listing SET
         last_seen = MAX(last_seen, @seen),
         costar_date_on_market = CASE WHEN costar_date_on_market IS NULL THEN @dateOnMarket WHEN @dateOnMarket IS NULL THEN costar_date_on_market
                                      ELSE MIN(costar_date_on_market, @dateOnMarket) END,
         status = 'active', removed_at = NULL, origin_tier = 'T1',
         broker_name = COALESCE(@brokerName, broker_name), broker_company = COALESCE(@brokerCompany, broker_company),
         listing_url = COALESCE(@listingUrl, listing_url), description = COALESCE(@description, description)
       WHERE id = @id`,
    );
    const previousObservation = db.prepare(
      'SELECT asking_nnn_eq, rent_low, rent_is_total, available_sf, costar_dom FROM lm_observation WHERE listing_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1',
    );
    const insertObservation = db.prepare(
      `INSERT INTO lm_observation (listing_id, landing_id, observed_at, source_row, available_sf, min_divisible_sf, rent_low, rent_high, rent_period,
         rent_is_total, rent_basis, is_sublease, asking_psf_yr, asking_nnn_eq, opex_quoted_psf, opex_est_psf, opex_source, costar_dom, confidence, rejected_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare('INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind, prev_value, new_value) VALUES (?, ?, ?, ?, ?, ?)');
    const event = (listingId: number, kind: ListingEventKind, prev: number | null, next: number | null) => {
      insertEvent.run(listingId, landingId, exportDate, kind, prev, next);
      events[kind]++;
    };

    const seenSpaces = new Set<number>();
    for (const row of parsed.rows) {
      const { addressNorm, suiteNorm } = splitAddress(row.address, row.suite);
      const oraProperty = deps.config.oraProperties.find((p) => p.addressNorms.includes(addressNorm));
      const propertyFields = {
        costarPropertyId: row.costarPropertyId, addressDisplay: row.address, city: row.city, state: row.state, zip: row.zip,
        lat: row.lat, lon: row.lon, submarket: row.submarket, subtype: row.subtype, buildingStatus: row.buildingStatus,
        buildingSf: row.buildingSf, yearBuilt: row.yearBuilt, clearHeightFt: row.clearHeightFt, docks: row.docks, driveIns: row.driveIns,
        officePct: row.officePct, ownerName: row.ownerName,
        ownerType: row.ownerName ? (screen.types.get(row.ownerName.trim()) ?? 'unknown') : 'unknown',
        oraPropertyKey: oraProperty?.propertyKey ?? null, seen: exportDate,
      };
      const propertyHit = ((row.costarPropertyId ? findPropertyByCostarId.get(row.costarPropertyId) : undefined) ??
        findPropertyByAddress.get(addressNorm)) as { id: number } | undefined;
      let propertyId: number;
      if (propertyHit) {
        updateProperty.run({ ...propertyFields, id: propertyHit.id });
        propertyId = propertyHit.id;
      } else {
        propertyId = Number(insertProperty.run({ ...propertyFields, addressNorm, marketId }).lastInsertRowid);
        counts.newProperties++;
      }

      const spaceHit = findSpace.get(propertyId, suiteNorm) as { id: number; status: string } | undefined;
      if (spaceHit && seenSpaces.has(spaceHit.id)) {
        counts.skipped++;
        continue;
      }
      const prev = spaceHit
        ? (previousObservation.get(spaceHit.id) as { asking_nnn_eq: number | null; rent_low: number | null; rent_is_total: number; available_sf: number; costar_dom: number | null } | undefined)
        : undefined;
      const spaceFields = {
        seen: exportDate, dateOnMarket: row.costarDateOnMarket, brokerName: row.brokerName, brokerCompany: row.brokerCompany,
        listingUrl: row.listingUrl, description: row.description,
      };
      let listingId: number;
      if (spaceHit) {
        updateSpace.run({ ...spaceFields, id: spaceHit.id });
        listingId = spaceHit.id;
        counts.updatedSpaces++;
      } else {
        listingId = Number(insertSpace.run({ ...spaceFields, propertyId, suiteNorm, landingId }).lastInsertRowid);
        counts.insertedSpaces++;
      }
      seenSpaces.add(listingId);

      const opex = opexBySubtype[row.subtype];
      const priced = priceObservation(
        { rentLow: row.rentLow, rentHigh: row.rentHigh, rentPeriod: row.rentPeriod, rentBasis: row.rentBasis, rentIsTotal: row.rentIsTotal, availableSf: row.availableSf },
        opex, market.mgLandlordPays, t,
      );
      const costarDom = row.costarDateOnMarket ? Math.max(0, daysBetween(row.costarDateOnMarket, exportDate)) : null;
      insertObservation.run(
        listingId, landingId, exportDate, row.sourceRow, row.availableSf, row.minDivisibleSf, row.rentLow, row.rentHigh, row.rentPeriod,
        row.rentIsTotal ? 1 : 0, priced.effectiveBasis, row.isSublease ? 1 : 0, priced.askingPsfYr, priced.askingNnnEq, row.opexQuotedPsf,
        priced.opexEstPsf, priced.opexSource, costarDom, priced.confidence, priced.rejectedReason,
      );

      if (!spaceHit) {
        event(listingId, 'new', null, priced.askingNnnEq);
        continue;
      }
      if (spaceHit.status === 'removed') event(listingId, 'returned', null, priced.askingNnnEq);
      if (prev) {
        let before: number | null = null;
        let after: number | null = null;
        if (prev.asking_nnn_eq !== null && priced.askingNnnEq !== null) {
          before = prev.asking_nnn_eq;
          after = priced.askingNnnEq;
        } else if (prev.rent_low !== null && row.rentLow !== null && prev.rent_is_total === 0 && !row.rentIsTotal) {
          before = prev.rent_low;
          after = row.rentLow;
        }
        if (before !== null && after !== null) {
          if (after < before - CENT) event(listingId, 'price_cut', before, after);
          else if (after > before + CENT) event(listingId, 'price_increase', before, after);
        }
        if (prev.available_sf > 0 && Math.abs(row.availableSf - prev.available_sf) / prev.available_sf >= t.sfChangePct) {
          event(listingId, 'sf_change', prev.available_sf, row.availableSf);
        }
        if (prev.costar_dom !== null && costarDom !== null && costarDom < prev.costar_dom) event(listingId, 'dom_reset', prev.costar_dom, costarDom);
      }
    }

    if (complete) {
      const tracked = db
        .prepare(
          `SELECT l.id, l.status FROM lm_listing l JOIN lm_property p ON p.id = l.property_id
           WHERE p.market_id = ? AND l.origin_tier = 'T1' AND l.status IN ('active', 'missing_once')`,
        )
        .all(marketId) as Array<{ id: number; status: 'active' | 'missing_once' }>;
      const toMissing = db.prepare(`UPDATE lm_listing SET status = 'missing_once' WHERE id = ?`);
      const toRemoved = db.prepare(`UPDATE lm_listing SET status = 'removed', removed_at = ? WHERE id = ?`);
      for (const l of tracked) {
        if (seenSpaces.has(l.id)) continue;
        if (l.status === 'active') {
          toMissing.run(l.id);
          event(l.id, 'missing', null, null);
          counts.markedMissing++;
        } else {
          toRemoved.run(exportDate, l.id);
          event(l.id, 'removed', null, null);
          counts.markedRemoved++;
        }
      }
    }
  })();

  return {
    ...result, status: 'ingested', landingId, marketId, exportDate,
    completeness: complete ? 'complete' : 'partial', partialReason: complete ? null : reasons.join('; '),
    ...counts, events,
  };
}
