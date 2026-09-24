// @vitest-environment node
// Reads the REAL repo (no fs mock — check-write-schema-drift.test.ts mocks node:fs, so this lives
// in its own file). Regression for the 2026-09-23 PR-1 review finding: wrapping the sub-router
// entries as `factory: withJsonErrors(debtApi)` silently blinded buildMountPrefixMap()'s regex
// (`factory:\s*<bareName>\s*}`), so check:schema-drift resolved 0 of 9 prefixes and skipped the
// body-shape cross-check for brain-api / lease-market-api / tax-api with only a warning.
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { buildMountPrefixMap } from '../../scripts/check-write-schema-drift';
import { WAREHOUSE_SUB_ROUTERS } from '../../server/warehouse/sub-routers';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('buildMountPrefixMap × WAREHOUSE_SUB_ROUTERS', () => {
  it('resolves a mount prefix for every WAREHOUSE_SUB_ROUTERS entry (check:schema-drift stays sighted)', () => {
    const map = buildMountPrefixMap(REPO_ROOT);
    const resolvedSubRouterPrefixes = [...map.values()].filter((p) => p.startsWith('/api/warehouse/'));
    const expected = WAREHOUSE_SUB_ROUTERS.map((e) => `/api/warehouse${e.prefix}`);

    expect(WAREHOUSE_SUB_ROUTERS.length).toBeGreaterThan(0);
    for (const prefix of expected) expect(resolvedSubRouterPrefixes).toContain(prefix);
    expect(resolvedSubRouterPrefixes).toHaveLength(expected.length);
  });
});
