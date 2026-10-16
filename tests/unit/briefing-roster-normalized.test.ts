// Refute round 5, F4: server/briefing/compose.ts (both composers) and the warehouse IC-memo route
// still ran the RAW assertNoConfidential, so an NBSP / hyphen variant of a roster term in a
// briefing model rendered (JSON and PDF) and the IC memo exported. The composers now run the
// normalised assertNoRosterMatch (a local render keeps the placeholder concession); the two
// FILE artifacts that leave the machine (briefing PDF, IC-memo HTML attachment) run
// assertNoEgressRosterMatch, which also refuses the placeholder roster. Synthetic roster only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../server/brain', () => ({ brain: { getSnapshot: vi.fn(() => null) } }));
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn(async () => null) }));

import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { composePropertyBriefing, composeManagerBriefing, managerSlug } from '../../server/briefing/compose';

const cp = (...n: number[]) => String.fromCodePoint(...n);
const GEN = '2026-06-14';
const PROP = '1100-rarig-ave-columbus-oh';
const KRG_SLUG = managerSlug('Kohr Royer Griffith');
const ROSTER = { syn: { label: 'Synthetic', active: true, always: ['Kestrel Ridge'] } };

let dir: string;
const saved = { path: process.env.CONFIDENTIAL_TERMS_PATH, ph: process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER };
beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'briefing-roster-'));
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  if (saved.path === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = saved.path;
  if (saved.ph === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = saved.ph;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Committed full-year ledger rows (mirrors briefing.test.ts's seeder) so the property carries
 *  metrics and therefore appears, by name, in the briefing and capital-allocation outputs. */
function insertFy(d: WarehouseDb, propertyId: string, year: string, revenue: number, opex: number): void {
  const batch = d
    .prepare(
      `INSERT INTO import_batches
         (file_name, file_hash, raw_path, imported_at, property_id, period_start, period_end,
          period_grain, basis, source_system, version, status, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'year', 'cash', 'test', 1, 'committed', 0.99)`,
    )
    .run(`seed-${propertyId}-${year}.xlsx`, `hash-${propertyId}-${year}`, `raw/${propertyId}-${year}`,
      '2026-06-12T00:00:00Z', propertyId, `${year}-01-01`, `${year}-12-31`);
  const ins = d.prepare(
    `INSERT INTO ledger_entries (import_id, property_id, period, raw_account, gl_code, amount, normalized_category, classification, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  ins.run(batch.lastInsertRowid, propertyId, year, 'Rent', '5064', revenue, 'Rental Revenue', 'revenue');
  ins.run(batch.lastInsertRowid, propertyId, year, 'Repairs', '6100', opex, 'Repairs & Maintenance', 'opex');
}

function db(name?: string): WarehouseDb {
  const d = openWarehouse(join(mkdtempSync(join(tmpdir(), 'briefing-roster-db-')), 'f.sqlite'));
  seedPropertyMaster(d);
  insertFy(d, PROP, '2024', 120000, 30000);
  insertFy(d, PROP, '2025', 132000, 28000);
  if (name) d.prepare(`UPDATE property_master SET name = ? WHERE id = ?`).run(name, PROP);
  return d;
}

const usePlaceholder = () => {
  process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
  process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
};

const VARIANTS: Array<[string, string]> = [
  ['NBSP', `Kestrel${cp(0xa0)}Ridge Portfolio`],
  ['hyphen', 'Kestrel-Ridge Portfolio'],
  ['zero-width split', `Kes${cp(0x200b)}trel Ridge`],
];

describe('composers run the normalised roster match', () => {
  it.each(VARIANTS)('property briefing refuses a %s variant', (_n, name) => {
    expect(() => composePropertyBriefing(db(name), PROP, { generatedDate: GEN })).toThrow(/confidential deal term/);
  });
  it.each(VARIANTS)('manager briefing refuses a %s variant', (_n, name) => {
    expect(() => composeManagerBriefing(db(name), KRG_SLUG, { generatedDate: GEN })).toThrow(/confidential deal term/);
  });
  it('a clean model still composes', () => {
    expect(composePropertyBriefing(db(), PROP, { generatedDate: GEN })).not.toBeNull();
  });
  it('a local JSON render keeps the explicit placeholder concession (unchanged)', async () => {
    usePlaceholder();
    const res = await warehouseRoutes(() => db()).request(`/briefing/property/${PROP}`);
    expect(res.status).toBe(200);
  });
});

describe('file artifacts that leave the machine run the EGRESS match', () => {
  it.each(VARIANTS)('briefing PDF route refuses a %s variant with a structured 500', async (_n, name) => {
    const res = await warehouseRoutes(() => db(name)).request(`/briefing/property/${PROP}.pdf`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json()).toLowerCase()).not.toContain('kestrel');
  });
  it('briefing PDF route refuses the placeholder roster', async () => {
    usePlaceholder();
    const res = await warehouseRoutes(() => db()).request(`/briefing/property/${PROP}.pdf`);
    expect(res.status).toBe(500);
  });
  it('manager briefing PDF route refuses the placeholder roster', async () => {
    usePlaceholder();
    const res = await warehouseRoutes(() => db()).request(`/briefing/manager/${KRG_SLUG}.pdf`);
    expect(res.status).toBe(500);
  });
  it('IC memo export refuses the placeholder roster', async () => {
    usePlaceholder();
    const res = await warehouseRoutes(() => db()).request('/capital-allocation/ic-memo');
    expect(res.status).toBe(500);
  });
  it.each(VARIANTS)('IC memo export refuses a %s variant', async (_n, name) => {
    const res = await warehouseRoutes(() => db(name)).request('/capital-allocation/ic-memo');
    expect(res.status).toBe(500);
    expect((await res.text()).toLowerCase()).not.toContain('kestrel');
  });
  it('control: a clean IC memo still exports with the real roster', async () => {
    const res = await warehouseRoutes(() => db()).request('/capital-allocation/ic-memo');
    expect(res.status).toBe(200);
  });
});
