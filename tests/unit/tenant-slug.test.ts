/**
 * M12 regression pin — tenantSlug must produce identical output to slug().
 *
 * Before the fix: tenantSlug had a local 3-line regex that skipped
 * .normalize('NFKD') and diacritic stripping, so Unicode tenant names
 * (e.g. "Müller GmbH") produced different ids in tenantSlug vs slug(),
 * silently breaking tenant-note lookups keyed by the slug.
 *
 * After the fix: tenantSlug delegates to slug(), so every case is identical.
 */

import { describe, it, expect } from 'vitest';
import { tenantSlug } from '../../src/brain/tenants';
import { slug } from '../../src/contracts/common';

/** ASCII corpus — the existing stable set. */
const ASCII_NAMES = [
  'Acme Corp',
  'Smith & Wesson',
  'Main Street Storage LLC',
  'ABC-123 Industrial',
  '  Leading spaces  ',
  'UPPERCASE ONLY',
  'lower-case-already',
  'Numbers 42 and 99',
  'A',
];

/** Unicode names that expose the pre-fix divergence. */
const UNICODE_NAMES = [
  'Müller GmbH',
  'José Ángel Consulting',
  'Société Générale',
  'Björk Industries',
  'Ångström Precision',
  'Ñoño Enterprises',
  'Café Logistics',
  'Ünited Über Transport',
];

describe('tenantSlug', () => {
  describe('ASCII parity with slug() — regression pin', () => {
    for (const name of ASCII_NAMES) {
      it(`produces identical output to slug() for "${name}"`, () => {
        expect(tenantSlug(name)).toBe(slug(name));
      });
    }
  });

  describe('Unicode parity with slug() — the bug that M12 fixes', () => {
    for (const name of UNICODE_NAMES) {
      it(`normalizes "${name}" identically to slug()`, () => {
        expect(tenantSlug(name)).toBe(slug(name));
      });
    }
  });

  it('strips diacritics (NFKD + diacritic removal)', () => {
    expect(tenantSlug('Müller GmbH')).toBe('muller-gmbh');
    expect(tenantSlug('José Ángel')).toBe('jose-angel');
  });

  it('caps output at 64 characters', () => {
    const long = 'A'.repeat(100);
    expect(tenantSlug(long)).toBe(slug(long));
    expect(tenantSlug(long).length).toBeLessThanOrEqual(64);
  });
});
