// server/warehouse/property-onboarding.ts
//
// Phase 5 W4 — Data-driven property onboarding.
// Writes a new property_master row + a property_onboarding row (aliases, pmSystem,
// authoritativeSource). The detect.ts PROPERTY_ALIASES const is compile-time-only;
// this table is the runtime-writable companion. Wiring detect.ts to read aliases_json
// is a deferred Integration-agent follow-up (spec §9.2).
import { z } from 'zod';
import type { WarehouseDb } from './db';

export const PropertyOnboardingInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  sfTotal: z.number().nullable(),
  // Required, no default: property_master.ownership_pct is NOT NULL DEFAULT 1.0 at the schema level,
  // so before this field existed onboarding always wrote the literal 1 regardless of the deal's real
  // ownership share. debt-scoring.ts's DSCR/debt-yield governor check reads NOI on this same
  // ownership-adjusted basis (oxfordNoi = noi * ownershipPct, paired with Oxford's own debt service in
  // debt_positions) -- an onboarded property that is actually a fractional JV but silently carries 1
  // here reproduces the exact false-clearance DSCR overstatement the 2026-08-22 oxfordNoi fix (9cb6169)
  // closed for every property seeded before this field existed (see debt-scoring.ts's noiByProperty
  // comment). Forcing the caller to state it here, with no fallback, is the boundary check: a JV
  // property can no longer be onboarded through the supported route without an explicit ownership share.
  ownershipPct: z.number().gt(0).lte(1),
  pmSystem: z.enum(['quickbooks', 'yardi', 'appfolio', 'rent-manager']),
  authoritativeSource: z.enum(['pm-exports', 'internal-quickbooks', 'workbook-only']),
});

export type PropertyOnboardingInput = z.infer<typeof PropertyOnboardingInputSchema>;

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
      VALUES (?, ?, NULL, ?, ?, 'active')
    `).run(input.id, input.name, input.sfTotal ?? null, input.ownershipPct);

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
