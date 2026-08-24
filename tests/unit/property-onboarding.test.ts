// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { onboardProperty, PropertyOnboardingInputSchema } from '../../server/warehouse/property-onboarding';
import { getPropertyMaster } from '../../server/warehouse/property-master';

const openedDbs: WarehouseDb[] = [];

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  seedPropertyMaster(db);
  openedDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openedDbs.splice(0)) db.close();
});

describe('property onboarding', () => {
  it('O-1: valid new property → ok:true, row in property_master', () => {
    const db = freshDb();
    const result = onboardProperty(db, {
      id: 'test-new-property',
      name: 'Test New Property',
      aliases: ['TestNew', 'test_new'],
      sfTotal: 10000,
      ownershipPct: 1,
      pmSystem: 'quickbooks',
      authoritativeSource: 'internal-quickbooks',
    });
    expect(result.ok).toBe(true);
    expect(result.propertyId).toBe('test-new-property');
    const row = db.prepare('SELECT id, name, ownership_pct FROM property_master WHERE id = ?').get('test-new-property') as { id: string; name: string; ownership_pct: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('Test New Property');
    expect(row?.ownership_pct).toBe(1);
    const onboardRow = db.prepare('SELECT property_id, aliases_json, pm_system, authoritative_source FROM property_onboarding WHERE property_id = ?').get('test-new-property') as { property_id: string; aliases_json: string; pm_system: string; authoritative_source: string } | undefined;
    expect(onboardRow).toBeTruthy();
    expect(onboardRow?.pm_system).toBe('quickbooks');
    expect(onboardRow?.authoritative_source).toBe('internal-quickbooks');
  });

  it('O-2: duplicate id → ok:false with "already exists" error', () => {
    const db = freshDb();
    const result = onboardProperty(db, {
      id: '3540-e-5th-ave-columbus-oh',
      name: 'Duplicate',
      aliases: [],
      sfTotal: null,
      ownershipPct: 1,
      pmSystem: 'quickbooks',
      authoritativeSource: 'internal-quickbooks',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/);
  });

  it('O-3: getPropertyMaster merges DB + seed; DB wins on id conflict (source==="db")', () => {
    const db = freshDb();
    // seed already inserted CANON_PROPERTIES; add a new one via onboard
    onboardProperty(db, {
      id: 'hand-onboarded-property',
      name: 'Hand-Onboarded',
      aliases: [],
      sfTotal: 5000,
      ownershipPct: 0.5,
      pmSystem: 'yardi',
      authoritativeSource: 'pm-exports',
    });
    const records = getPropertyMaster(db);
    // All seeded canon properties present
    const seeded = records.find(r => r.id === '3540-e-5th-ave-columbus-oh');
    expect(seeded).toBeDefined();
    // Newly onboarded property present
    const onboarded = records.find(r => r.id === 'hand-onboarded-property');
    expect(onboarded).toBeDefined();
    // A seed id that exists in DB has source='db' (seedPropertyMaster inserts via upsert)
    expect(seeded?.source).toBe('db');
  });

  it('O-4: invalid id (spaces/caps) → ok:false with "URL-safe" error', () => {
    const db = freshDb();
    const result = onboardProperty(db, {
      id: 'Fulton St',
      name: 'Fulton',
      aliases: [],
      sfTotal: null,
      ownershipPct: 1,
      pmSystem: 'quickbooks',
      authoritativeSource: 'workbook-only',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/URL-safe/);
  });

  it('O-5: ownershipPct is required (schema-level) -- omitting it fails validation before any DB write', () => {
    const parsed = PropertyOnboardingInputSchema.safeParse({
      id: 'jv-no-ownership-pct',
      name: 'JV Missing Ownership',
      aliases: [],
      sfTotal: null,
      pmSystem: 'quickbooks',
      authoritativeSource: 'internal-quickbooks',
      // ownershipPct intentionally omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('O-6: ownershipPct out of (0,1] range is rejected by the schema', () => {
    for (const bad of [0, -0.5, 1.01, 2]) {
      const parsed = PropertyOnboardingInputSchema.safeParse({
        id: 'jv-bad-ownership-pct',
        name: 'JV Bad Ownership',
        aliases: [],
        sfTotal: null,
        ownershipPct: bad,
        pmSystem: 'quickbooks',
        authoritativeSource: 'internal-quickbooks',
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('O-7: a fractional JV property persists its real ownershipPct, not a silent 1.0 default', () => {
    const db = freshDb();
    onboardProperty(db, {
      id: 'jv-fractional-property',
      name: 'JV Fractional Property',
      aliases: [],
      sfTotal: 20000,
      ownershipPct: 0.5,
      pmSystem: 'yardi',
      authoritativeSource: 'pm-exports',
    });
    const row = db.prepare('SELECT ownership_pct FROM property_master WHERE id = ?').get('jv-fractional-property') as { ownership_pct: number } | undefined;
    expect(row?.ownership_pct).toBe(0.5);
  });
});
