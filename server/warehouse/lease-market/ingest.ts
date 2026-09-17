// server/warehouse/lease-market/ingest.ts
//
// Lease Market Intelligence — CoStar listings ingest (spec rev 3 §3.1-3.5; fix round 1).
// One transaction per file. Property (building) and listing (space) are separate entities.
// Only COMPLETE exports move listings toward removal, and removal needs two consecutive complete
// exports without the space (missing_once -> removed). Financial-decision source: refute pass required.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { WarehouseDb } from '../db';
import type { LeaseMarketConfig } from '../../../src/contracts/lease-market';
import type { ListingEventKind, LmSubtype, RentBasis } from '../../../src/contracts/lease-market';
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

// A real calendar date, not just digits matching YYYY-MM-DD (rejects e.g. 2026-02-30).
function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// The mtime fallback uses the LOCAL calendar date (not UTC) — a file dropped just after local
// midnight must not be dated "yesterday" just because UTC hasn't rolled over yet.
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function cityNormOf(city: string | null): string {
  return (city ?? '').trim().toUpperCase();
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

interface OkLanding {
  id: number;
  observed_at: string;
  header_fingerprint: string | null;
}

// Latest landing regardless of completeness (complete OR partial) — used for the header-fingerprint
// comparison (a header change never locks a market out: it degrades the export to partial instead) AND
// for the date-after check (fix round 2 requirement 2): an export is complete only when it is dated
// after the TRUE latest landing, not just the latest COMPLETE one — otherwise a back-dated,
// complete-shaped file sandwiched before a more recent partial landing would wrongly apply status
// changes and the removal sweep using stale, out-of-order data.
function latestOkLanding(db: WarehouseDb, marketId: string): OkLanding | undefined {
  return db
    .prepare(
      `SELECT id, observed_at, header_fingerprint FROM lm_landing
       WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok'
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(marketId) as OkLanding | undefined;
}

const EVENT_KINDS: readonly ListingEventKind[] = ['new', 'returned', 'price_cut', 'price_increase', 'sf_change', 'dom_reset', 'missing', 'removed'];
const CENT = 0.005;
// R11: CoStar's own UI has historically defaulted its "export to Excel" action to a handful of round
// row caps — a row count landing exactly on one of these is suspicious even when it doesn't match
// today's configured exportRowCap.
const ROUND_EXPORT_CAPS: readonly number[] = [500, 1000, 2500, 5000, 10000];

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
  if (fromName && !isValidIsoDate(fromName.exportDate)) {
    return fail(fromName.marketId, localDateString(statSync(filePath).mtime), 'invalid export date in file name');
  }
  const exportDate = fromName?.exportDate ?? localDateString(statSync(filePath).mtime);

  // A landing dated more than 1 day after deps.now() is almost certainly a bad file-name date or a
  // clock skew on the source machine — fail closed rather than let a future-dated export poison the
  // completeness/removal-sweep ordering for every subsequent real file.
  // Clock bases differ on purpose: exportDate is a LOCAL calendar date (file name, or mtime via
  // localDateString) while deps.now() is UTC. The 1-day tolerance absorbs that offset in both
  // directions (max real offsets -12h/+14h), so it covers skew AND the local-vs-UTC gap.
  const maxAllowedDate = addDays(deps.now().slice(0, 10), 1);
  if (exportDate > maxAllowedDate) {
    return fail(fromName?.marketId ?? null, exportDate, `export date ${exportDate} is more than 1 day after ${deps.now().slice(0, 10)} (deps.now())`);
  }

  let parsed: ParsedCostarExport;
  try {
    parsed = await parseCostarListingsFile(filePath, deps.headerMap, exportDate);
  } catch (e) {
    if (e instanceof CostarParseError) return fail(fromName?.marketId ?? null, exportDate, e.message);
    throw e;
  }

  let marketId = fromName?.marketId ?? null;
  const resolveMarketIdFor = (name: string): string | undefined =>
    deps.config.markets.find((mk) => mk.costarMarketNames.some((c) => c.toLowerCase() === name.toLowerCase()))?.id;

  if (marketId !== null) {
    // The file name is authoritative, but a market column that maps to a DIFFERENT market than the
    // file name is a real contradiction worth failing on rather than silently trusting the file name.
    for (const name of parsed.marketNames) {
      const resolved = resolveMarketIdFor(name);
      if (resolved && resolved !== marketId) {
        return fail(marketId, exportDate, `file name market ${marketId} contradicts market column ${resolved}`);
      }
    }
  } else {
    const ids = new Set<string>();
    for (const name of parsed.marketNames) {
      const resolved = resolveMarketIdFor(name);
      if (!resolved) return fail(null, exportDate, `market "${name}" is not in any configured market's costarMarketNames`);
      ids.add(resolved);
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

  const priorComplete = latestCompleteLanding(db, marketId);
  const priorOk = latestOkLanding(db, marketId);
  // R10: a space FIRST sighted in a landing dated before the market's already-known latest complete
  // landing arrived out of order — the more current complete picture never showed it. It must not start
  // life as a confirmed 'active' space; it starts 'missing_once' instead (the same status an existing
  // space gets when a complete export doesn't see it), and its first-sighting 'new' event is excluded
  // from "new in the latest export" reporting (compute.ts).
  const backDatedFirstSighting = priorComplete !== undefined && exportDate < priorComplete.observed_at;

  const t = deps.config.thresholds;
  const reasons: string[] = [];
  if (parsed.rowCount >= t.exportRowCap) reasons.push(`row count ${parsed.rowCount} at export cap ${t.exportRowCap}`);
  if (priorComplete && parsed.rowCount < t.exportMinRowRatio * priorComplete.row_count) {
    reasons.push(`row count ${parsed.rowCount} < ${t.exportMinRowRatio} x prior ${priorComplete.row_count}`);
  }
  if (priorOk && exportDate <= priorOk.observed_at) {
    reasons.push(`export date ${exportDate} not after last landing ${priorOk.observed_at}`);
  }
  // A header change never locks the market out: it degrades this export to partial (the parser has
  // already verified every mapped column resolved), and the NEXT export with the same new header
  // compares equal again and can be complete.
  if (priorOk && priorOk.header_fingerprint !== null && priorOk.header_fingerprint !== parsed.headerFingerprint) {
    reasons.push(`header set changed vs landing #${priorOk.id} (mapped columns verified by parser)`);
  }
  const complete = reasons.length === 0;
  // A partial sighting clears a `missing_once` strike only when this export is dated after the true
  // latest COMPLETE landing — a partial that lands out of order (dated before the complete export that
  // set the strike) must not undo it, even though it may postdate the space's own last_seen.
  const clearsMissingOnce = !priorComplete || exportDate > priorComplete.observed_at;

  // R11: exportRowCap is a provisional, operator-configured guess at what CoStar actually caps an
  // export at. A landing whose row count exactly equals it is already forced partial above; a row count
  // landing on one of CoStar's own well-known round export caps is ALSO worth a loud warning even when
  // it doesn't match the currently configured cap — either shape can mean an export was silently
  // truncated, and mass false "missing"/"removed" status changes on the next complete export would
  // otherwise follow silently.
  const atConfiguredCap = parsed.rowCount >= t.exportRowCap;
  const roundCapHit = ROUND_EXPORT_CAPS.find((c) => c === parsed.rowCount) ?? null;
  if (atConfiguredCap || roundCapHit !== null) {
    console.warn(
      `[lease-market ingest] ${file}: row count ${parsed.rowCount} ${
        atConfiguredCap ? `is at/over the configured export cap ${t.exportRowCap}` : `matches a common CoStar export cap (${roundCapHit})`
      } — verify this export was not silently truncated`,
    );
  }
  const roundCapNote =
    roundCapHit !== null && !atConfiguredCap ? `row count ${parsed.rowCount} matches a common CoStar export cap (${roundCapHit})` : null;

  const screen = deps.screen(parsed.rows.flatMap((r) => (r.ownerName ? [r.ownerName] : [])));
  // R17: never logs or persists the flagged owner NAME — only the error text (owner-screen.ts's error
  // strings are always static/operational, e.g. "guard file unreadable" or a stripped exception
  // message, never derived from a name). A failing screen (missing Python, an unreadable never-call
  // guard file, invalid script output) otherwise leaves only the opaque owner_screen_ok = 0 flag, which
  // by itself gives an operator no way to tell "the screen script itself is broken" from "conditions
  // genuinely gate every candidate".
  const screenErrorNote = screen.error !== null ? `owner_screen_error: ${screen.error}` : null;

  mkdirSync(deps.rawDir, { recursive: true });
  const rawPath = join(deps.rawDir, `${sha}${extname(filePath).toLowerCase()}`);
  copyFileSync(filePath, rawPath);

  // Quoted-opex median input: at most ONE value per listing. Prior listings contribute only their
  // latest quoted-opex observation strictly before this export's date within the trailing 365 days,
  // and only when that listing is NOT also present in this file (its current-file value is added
  // below instead, so a listing quoted across many prior exports never inflates n). The exclusion/dedupe
  // key is PROPERTY IDENTITY (identity_key, i.e. costar:<id> or addr:<market>|<city>|<address>) + suite
  // — not raw address|suite, which would conflate two distinct properties that merely share the same
  // street address text (two CoStar ids, or a stale vs. adopted addr: key at the same address).
  const identityKeyFor = (costarPropertyId: string | null, cityForKey: string, addressForKey: string): string =>
    costarPropertyId ? `costar:${costarPropertyId}` : `addr:${marketId}|${cityForKey}|${addressForKey}`;
  const currentPairs = new Set(
    parsed.rows.map((r) => {
      const { addressNorm, suiteNorm } = splitAddress(r.address, r.suite);
      return `${identityKeyFor(r.costarPropertyId, cityNormOf(r.city), addressNorm)}|${suiteNorm}`;
    }),
  );
  const quotedRows = db
    .prepare(
      `SELECT p.subtype AS subtype, o.opex_quoted_psf AS v, p.identity_key AS identityKey, l.suite_norm AS suiteNorm
       FROM lm_observation o
       JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id
       WHERE p.market_id = ? AND o.opex_quoted_psf IS NOT NULL AND o.observed_at >= ? AND o.observed_at < ?
         AND o.id = (
           SELECT o2.id FROM lm_observation o2
           WHERE o2.listing_id = o.listing_id AND o2.opex_quoted_psf IS NOT NULL AND o2.observed_at < ?
           ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1
         )`,
    )
    .all(marketId, addDays(exportDate, -365), exportDate, exportDate) as Array<{ subtype: LmSubtype; v: number; identityKey: string; suiteNorm: string }>;
  const quoted: Record<LmSubtype, number[]> = { warehouse: [], flex: [] };
  for (const q of quotedRows) {
    if (currentPairs.has(`${q.identityKey}|${q.suiteNorm}`)) continue;
    quoted[q.subtype].push(q.v);
  }
  const seenOpexPairs = new Set<string>();
  for (const r of parsed.rows) {
    if (r.opexQuotedPsf === null) continue;
    const { addressNorm, suiteNorm } = splitAddress(r.address, r.suite);
    const key = `${identityKeyFor(r.costarPropertyId, cityNormOf(r.city), addressNorm)}|${suiteNorm}`;
    if (seenOpexPairs.has(key)) continue;
    seenOpexPairs.add(key);
    quoted[r.subtype].push(r.opexQuotedPsf);
  }
  const opexBySubtype: Record<LmSubtype, OpexEstimate | null> = {
    warehouse: resolveOpex(market.opexDefaults.warehouse, quoted.warehouse, t.quotedOpexMinN),
    flex: resolveOpex(market.opexDefaults.flex, quoted.flex, t.quotedOpexMinN),
  };

  const events = emptyEvents();
  const counts = { insertedSpaces: 0, updatedSpaces: 0, newProperties: 0, skipped: parsed.skipped.length, markedMissing: 0, markedRemoved: 0 };
  let landingId = 0;
  let marketMismatchSkipped = 0;
  let marketMismatchNote: string | null = null;
  let resultPartialReason: string | null =
    [complete ? null : reasons.join('; '), roundCapNote, screenErrorNote].filter((n): n is string => n !== null && n !== '').join('; ') || null;

  db.transaction(() => {
    landingId = Number(
      db.prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, file_path, row_count, skipped_count,
           header_fingerprint, completeness, partial_reason, owner_screen_ok, parse_status)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      ).run(file, sha, marketId, exportDate, deps.now(), rawPath, parsed.rowCount, parsed.skipped.length, parsed.headerFingerprint,
        complete ? 'complete' : 'partial', complete ? null : reasons.join('; '), screen.available ? 1 : 0).lastInsertRowid,
    );

    const findPropertyByIdentityKey = db.prepare('SELECT id, market_id, identity_key FROM lm_property WHERE identity_key = ?');
    const findAdoptableProperty = db.prepare(
      'SELECT id, identity_key FROM lm_property WHERE market_id = ? AND city_norm = ? AND address_norm = ? AND costar_property_id IS NULL ORDER BY id LIMIT 1',
    );
    const findLowestPropertyByAddress = db.prepare(
      'SELECT id, identity_key FROM lm_property WHERE market_id = ? AND city_norm = ? AND address_norm = ? ORDER BY id LIMIT 1',
    );
    // Reverse of the city-backfill adoption above: a blank-city no-id row adopts the SOLE existing
    // non-blank-city property at this market+address (ambiguous when more than one exists, so it is
    // left alone and a new blank-city property is inserted as before).
    const findNonBlankCityProperties = db.prepare(
      "SELECT id, identity_key FROM lm_property WHERE market_id = ? AND address_norm = ? AND city_norm != '' ORDER BY id",
    );
    const insertProperty = db.prepare(
      `INSERT INTO lm_property (costar_property_id, identity_key, address_norm, address_display, city, city_norm, state, zip, lat, lon, market_id, submarket, subtype,
         building_status, building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type, ora_property_key, first_seen, last_seen)
       VALUES (@costarPropertyId, @identityKey, @addressNorm, @addressDisplay, @city, @cityNorm, @state, @zip, @lat, @lon, @marketId, @submarket, @subtype,
         @buildingStatus, @buildingSf, @yearBuilt, @clearHeightFt, @docks, @driveIns, @officePct, @ownerName, @ownerType, @oraPropertyKey, @seen, @seen)`,
    );
    const updateProperty = db.prepare(
      `UPDATE lm_property SET
         costar_property_id = COALESCE(@costarPropertyId, costar_property_id),
         identity_key = COALESCE(@identityKey, identity_key),
         address_display = @addressDisplay,
         city = COALESCE(@city, city), state = COALESCE(@state, state), zip = COALESCE(@zip, zip),
         lat = COALESCE(@lat, lat), lon = COALESCE(@lon, lon), submarket = COALESCE(@submarket, submarket),
         subtype = @subtype, building_status = @buildingStatus,
         building_sf = COALESCE(@buildingSf, building_sf), year_built = COALESCE(@yearBuilt, year_built),
         clear_height_ft = COALESCE(@clearHeightFt, clear_height_ft), docks = COALESCE(@docks, docks),
         drive_ins = COALESCE(@driveIns, drive_ins), office_pct = COALESCE(@officePct, office_pct),
         owner_name = COALESCE(@ownerName, owner_name),
         owner_type = CASE WHEN @screenAvailable = 0 THEN owner_type WHEN @ownerName IS NULL THEN owner_type ELSE @ownerType END,
         -- A blank stored city_norm is backfilled once a row supplies one; a non-empty city_norm is
         -- never rewritten — a genuinely different city at the same address is a different building.
         city_norm = CASE WHEN city_norm = '' THEN @cityNorm ELSE city_norm END,
         ora_property_key = COALESCE(@oraPropertyKey, ora_property_key),
         first_seen = MIN(first_seen, @seen),
         last_seen = MAX(last_seen, @seen)
       WHERE id = @id`,
    );
    const findSpace = db.prepare('SELECT id, status, last_seen FROM lm_listing WHERE property_id = ? AND suite_norm = ?');
    const insertSpace = db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, costar_date_on_market, status, origin_tier,
         broker_name, broker_company, listing_url, description)
       VALUES (@propertyId, @suiteNorm, @seen, @seen, @landingId, @dateOnMarket, @status, 'T1', @brokerName, @brokerCompany, @listingUrl, @description)`,
    );
    const spaceUpdateColumns = `
         first_seen = MIN(first_seen, @seen),
         -- If this file's date lowers first_seen (a back-dated re-export), first_landing_id follows it
         -- to the landing that actually supplied the earliest sighting.
         first_landing_id = CASE WHEN @seen < first_seen THEN @landingId ELSE first_landing_id END,
         last_seen = MAX(last_seen, @seen),
         costar_date_on_market = CASE WHEN costar_date_on_market IS NULL THEN @dateOnMarket WHEN @dateOnMarket IS NULL THEN costar_date_on_market
                                      ELSE MIN(costar_date_on_market, @dateOnMarket) END,
         origin_tier = 'T1',
         broker_name = COALESCE(@brokerName, broker_name), broker_company = COALESCE(@brokerCompany, broker_company),
         listing_url = COALESCE(@listingUrl, listing_url), description = COALESCE(@description, description)`;
    // Status changes (active + removed_at cleared, and the two-strike 'removed'/'expired' recovery)
    // happen only on COMPLETE exports. A PARTIAL export still clears missing_once -> active — a sighting
    // is positive evidence the space is still there, distinct from the stronger two-consecutive-complete
    // protocol a removed/expired space needs to return.
    const updateSpaceComplete = db.prepare(`UPDATE lm_listing SET status = 'active', removed_at = NULL, ${spaceUpdateColumns} WHERE id = @id`);
    const updateSpacePartial = db.prepare(
      `UPDATE lm_listing SET status = CASE WHEN status = 'missing_once' AND @clearMissing = 1 THEN 'active' ELSE status END, ${spaceUpdateColumns} WHERE id = @id`,
    );
    const previousObservation = db.prepare(
      `SELECT asking_nnn_eq, asking_psf_yr, rent_basis, rent_period, rent_is_total, rent_low, available_sf, costar_dom, rejected_reason, confidence
       FROM lm_observation WHERE listing_id = ? AND observed_at < ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
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
      const cityNorm = cityNormOf(row.city);
      const oraProperty = deps.config.oraProperties.find((p) => p.addressNorms.includes(addressNorm) && p.marketId === marketId);
      const commonPropertyFields = {
        costarPropertyId: row.costarPropertyId, addressDisplay: row.address, city: row.city, state: row.state, zip: row.zip,
        lat: row.lat, lon: row.lon, submarket: row.submarket, subtype: row.subtype, buildingStatus: row.buildingStatus,
        buildingSf: row.buildingSf, yearBuilt: row.yearBuilt, clearHeightFt: row.clearHeightFt, docks: row.docks, driveIns: row.driveIns,
        officePct: row.officePct, ownerName: row.ownerName,
        ownerType: screen.available && row.ownerName ? (screen.types.get(row.ownerName.trim()) ?? 'unknown') : 'unknown',
        oraPropertyKey: oraProperty?.propertyKey ?? null, seen: exportDate,
      };

      // Property identity (fix round 1, requirement 4; fix round 2, requirement 1 + 6): (i) a CoStar id
      // present is looked up by identity_key 'costar:<id>' — SCOPED to this ingest's market: a match
      // belonging to a DIFFERENT market is a data anomaly (a reused/duplicated CoStar id), so the row is
      // skipped rather than cross-attached. If no market-matching hit, an existing address-matched
      // property with no CoStar id yet is ADOPTED (its costar id + identity_key are set) rather than
      // creating a duplicate. (ii) no CoStar id: the lowest-id property already at this market+city+
      // address; if the row's city is blank OR that exact-city lookup misses, fall back to a
      // market+address match whose stored city_norm is blank (adopting it, and backfilling its addr:
      // identity_key to include the now-known city) rather than forking a second property.
      let propertyHit: { id: number; identity_key: string } | undefined;
      let adopting = false;
      let cityBackfill = false;
      if (row.costarPropertyId) {
        const byKey = findPropertyByIdentityKey.get(`costar:${row.costarPropertyId}`) as { id: number; market_id: string; identity_key: string } | undefined;
        if (byKey && byKey.market_id !== marketId) {
          counts.skipped++; // market_mismatch: this CoStar id already belongs to a different market's property
          marketMismatchSkipped++;
          continue;
        }
        propertyHit = byKey;
        if (!propertyHit) {
          let adoptable = findAdoptableProperty.get(marketId, cityNorm, addressNorm) as { id: number; identity_key: string } | undefined;
          // Same bridge as the no-id path: an exact-city miss retries against a stored blank city_norm
          // rather than forking a second property for the same building.
          if (!adoptable && cityNorm !== '') {
            adoptable = findAdoptableProperty.get(marketId, '', addressNorm) as { id: number; identity_key: string } | undefined;
          }
          if (adoptable) {
            propertyHit = adoptable;
            adopting = true;
          }
        }
      } else {
        propertyHit = findLowestPropertyByAddress.get(marketId, cityNorm, addressNorm) as { id: number; identity_key: string } | undefined;
        if (!propertyHit && cityNorm !== '') {
          const blankCity = findLowestPropertyByAddress.get(marketId, '', addressNorm) as { id: number; identity_key: string } | undefined;
          if (blankCity) {
            propertyHit = blankCity;
            cityBackfill = true;
          }
        } else if (!propertyHit && cityNorm === '') {
          const candidates = findNonBlankCityProperties.all(marketId, addressNorm) as Array<{ id: number; identity_key: string }>;
          if (candidates.length === 1) {
            propertyHit = candidates[0];
          }
        }
      }

      let propertyId: number;
      if (propertyHit) {
        propertyId = propertyHit.id;
      } else {
        const identityKey = row.costarPropertyId ? `costar:${row.costarPropertyId}` : `addr:${marketId}|${cityNorm}|${addressNorm}`;
        propertyId = Number(insertProperty.run({ ...commonPropertyFields, addressNorm, cityNorm, marketId, identityKey }).lastInsertRowid);
        counts.newProperties++;
      }

      // Duplicate-space check happens BEFORE any property UPDATE (fix round 1, requirement 7): a
      // second row for an already-seen space in this file must not overwrite the property's physical
      // fields with a possibly-blank/different duplicate value.
      const spaceHit = findSpace.get(propertyId, suiteNorm) as { id: number; status: string; last_seen: string } | undefined;
      if (spaceHit && seenSpaces.has(spaceHit.id)) {
        counts.skipped++;
        continue;
      }

      if (propertyHit) {
        let identityKey: string | null = null;
        if (adopting) identityKey = `costar:${row.costarPropertyId}`;
        else if (cityBackfill && propertyHit.identity_key.startsWith('addr:')) identityKey = `addr:${marketId}|${cityNorm}|${addressNorm}`;
        updateProperty.run({ ...commonPropertyFields, id: propertyHit.id, identityKey, cityNorm, screenAvailable: screen.available ? 1 : 0 });
      }

      const prev = spaceHit
        ? (previousObservation.get(spaceHit.id, exportDate) as
            | {
                asking_nnn_eq: number | null; asking_psf_yr: number | null; rent_basis: RentBasis; rent_period: 'yr' | 'mo' | null;
                rent_is_total: number; rent_low: number | null; available_sf: number; costar_dom: number | null; rejected_reason: string | null;
                confidence: 'high' | 'low';
              }
            | undefined)
        : undefined;
      const spaceFields = {
        seen: exportDate, dateOnMarket: row.costarDateOnMarket, brokerName: row.brokerName, brokerCompany: row.brokerCompany,
        listingUrl: row.listingUrl, description: row.description, landingId, clearMissing: clearsMissingOnce ? 1 : 0,
        // R10: only meaningful for a brand-new space (the update statements never reference @status).
        status: backDatedFirstSighting ? 'missing_once' : 'active',
      };
      let listingId: number;
      if (spaceHit) {
        const updateSpace = complete ? updateSpaceComplete : updateSpacePartial;
        updateSpace.run({ ...spaceFields, id: spaceHit.id });
        listingId = spaceHit.id;
        counts.updatedSpaces++;
      } else {
        listingId = Number(insertSpace.run({ ...spaceFields, propertyId, suiteNorm }).lastInsertRowid);
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

      // A back-dated or same-day re-export (this file's date is not after the space's own last
      // sighting) writes the observation for the record but triggers no events at all — its data
      // point is not the space's current state.
      const backDated = exportDate <= spaceHit.last_seen;
      if (backDated) continue;

      if (complete && (spaceHit.status === 'removed' || spaceHit.status === 'expired')) {
        event(listingId, 'returned', null, priced.askingNnnEq);
      }
      if (prev) {
        let before: number | null = null;
        let after: number | null = null;
        const prevRejected = prev.rejected_reason !== null;
        const currRejected = priced.rejectedReason !== null;
        const sameBasis = prev.rent_basis === priced.effectiveBasis;
        // R4: a confidence-level change (high<->low) means the two observations were derived under
        // different interpretation confidence (e.g. an explicit vs. an inferred rent period, or a
        // basis that only sometimes needs an opex estimate) and are not safely comparable for a price
        // event — comparing them raw can produce a huge phantom price move.
        const sameConfidence = prev.confidence === priced.confidence;
        const prevIsTotal = prev.rent_is_total === 1;
        const bothTotal = prevIsTotal && row.rentIsTotal;
        const neitherTotal = !prevIsTotal && !row.rentIsTotal;
        if (bothTotal) {
          // R5: a total quote ("$2,500/MO NNN") is compared on the RAW TOTAL, never asking_psf_yr — a
          // total's $/SF/yr figure is total ÷ available SF, so an SF change alone (with the quoted
          // total unchanged) would otherwise register as a phantom price_cut/price_increase. sf_change
          // below still fires for the real SF move.
          if (sameBasis && sameConfidence && prev.rent_period === row.rentPeriod && !prevRejected && !currRejected && prev.rent_low !== null && row.rentLow !== null) {
            before = prev.rent_low;
            after = row.rentLow;
          }
        } else if (neitherTotal) {
          if (sameBasis && sameConfidence && !prevRejected && !currRejected && prev.asking_psf_yr !== null && priced.askingPsfYr !== null) {
            // Primary comparison: the raw asking $/SF/yr figure, never the NNN-equivalent — an
            // NNN-eq change driven purely by a shifting opex estimate (market-median drift) is not a
            // real price move.
            before = prev.asking_psf_yr;
            after = priced.askingPsfYr;
          } else if (
            sameBasis && sameConfidence &&
            prev.rent_period === row.rentPeriod &&
            !prevRejected && !currRejected &&
            prev.rent_low !== null && row.rentLow !== null
          ) {
            before = prev.rent_low;
            after = row.rentLow;
          }
        }
        // A mixed total-ness (one observation total, the other per-unit) is not a comparable pair
        // either way — neither branch above fires, so no price event, same as any other non-comparable
        // case (mismatched basis, confidence, or a rejected observation).
        if (before !== null && after !== null) {
          if (after < before - CENT) event(listingId, 'price_cut', before, after);
          else if (after > before + CENT) event(listingId, 'price_increase', before, after);
        } else if (sameBasis && !sameConfidence && !prevRejected && !currRejected) {
          // M-3: R4's confidence-flip suppression is deliberate (comparing observations derived under
          // different interpretation confidence can be a phantom move) but it is also the one case
          // where a GENUINE cut/increase can vanish from reduction_count and the Changes tab without a
          // trace — warn when the pair is otherwise comparable (same basis, neither rejected) and the
          // underlying quoted value actually differs, so a real cut doesn't just disappear silently.
          const primaryDiffers = bothTotal
            ? prev.rent_low !== null && row.rentLow !== null && prev.rent_low !== row.rentLow
            : neitherTotal && prev.asking_psf_yr !== null && priced.askingPsfYr !== null && prev.asking_psf_yr !== priced.askingPsfYr;
          if (primaryDiffers) {
            console.warn(
              `[lease-market] listing ${listingId}: a price change was suppressed because confidence flipped (${prev.confidence} -> ${priced.confidence}) between comparable observations — reduction_count and the Changes tab will not reflect it.`,
            );
          }
        }
        if (prev.available_sf > 0 && Math.abs(row.availableSf - prev.available_sf) / prev.available_sf >= t.sfChangePct) {
          event(listingId, 'sf_change', prev.available_sf, row.availableSf);
        }
        if (prev.costar_dom !== null && costarDom !== null && costarDom < prev.costar_dom) event(listingId, 'dom_reset', prev.costar_dom, costarDom);
      }
    }

    if (marketMismatchSkipped > 0) {
      // market_mismatch skips are discovered mid-file, after the initial completeness reasons were
      // already computed and inserted — fold this note into partial_reason (whether or not the export
      // is otherwise complete) so it survives on the landing row, not just in this call's return value.
      marketMismatchNote = `market_mismatch: ${marketMismatchSkipped} row(s) skipped (CoStar id belongs to a different market)`;
      resultPartialReason = resultPartialReason ? `${resultPartialReason}; ${marketMismatchNote}` : marketMismatchNote;
    }
    db.prepare('UPDATE lm_landing SET skipped_count = ?, partial_reason = ? WHERE id = ?').run(counts.skipped, resultPartialReason, landingId);

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

  if (marketMismatchNote) {
    // Warned once per file (not per row) so a large batch of cross-market rows doesn't flood the log.
    console.warn(`[lease-market ingest] ${file}: ${marketMismatchNote}`);
  }

  return {
    ...result, status: 'ingested', landingId, marketId, exportDate,
    completeness: complete ? 'complete' : 'partial', partialReason: resultPartialReason,
    ...counts, events,
  };
}
