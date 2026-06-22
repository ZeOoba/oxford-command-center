// server/warehouse/property-onboarding.ts
//
// Phase 5 W4 — Data-driven property onboarding.
// Writes a new property_master row + a property_onboarding row (aliases, pmSystem,
// authoritativeSource). The detect.ts PROPERTY_ALIASES const is compile-time-only;
// this table is the runtime-writable companion. Wiring detect.ts to read aliases_json
// is a deferred Integration-agent follow-up (spec §9.2).
import type { WarehouseDb } from './db';

export interface PropertyOnboardingInput {
  id: string;
  name: string;
  aliases: string[];
  sfTotal: number | null;
  pmSystem: 'quickbooks' | 'yardi' | 'appfolio' | 'rent-manager';
  authoritativeSource: 'pm-exports' | 'internal-quickbooks' | 'workbook-only';
}

export function onboardProperty(
  db: WarehouseDb,
  input: PropertyOnboardingInput,
): { ok: boolean; propertyId?: string; error?: string } {
  // 1. Validate id: URL-safe kebab-case only
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.id)) {
    return { ok: false, error: `invalid id '${input.id}' (must be URL-safe kebab-case, e.g. 'my-property')` };
  }

  // 2. Reject duplicate
  const existing = db.prepare('SELECT 1 FROM property_master WHERE id = ?').get(input.id);
  if (existing) {
    return { ok: false, error: `property '${input.id}' already exists in property_master` };
  }

  // 3. INSERT into property_master + 4. persist onboarding record
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO property_master (id, name, market, rentable_sf, ownership_pct, ownership_status)
      VALUES (?, ?, NULL, ?, 1, 'active')
    `).run(input.id, input.name, input.sfTotal ?? null);

    db.prepare(`
      INSERT INTO property_onboarding (property_id, aliases_json, pm_system, authoritative_source)
      VALUES (?, ?, ?, ?)
    `).run(
      input.id,
      JSON.stringify(input.aliases),
      input.pmSystem,
      input.authoritativeSource,
    );
  });

  tx();
  return { ok: true, propertyId: input.id };
}
