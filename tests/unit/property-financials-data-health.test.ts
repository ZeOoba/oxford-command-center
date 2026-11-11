// tests/unit/property-financials-data-health.test.ts — T8 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The pure data-health model on the
// REAL committed dataset: the per-property gap matcher (data_quality items + partial-lease reads +
// the FVC inference) for all 11 entities, the leases that attach to no entity (Fishel, Sunburst),
// exclusion detection (Northwood), and the small formatting helpers the panel uses.
import { describe, expect, it } from 'vitest';
import { PF_ENTITY_IDS, type PfEntityId } from '@contracts/property-financials';
import {
  AUDIT_CSV_ABSENT_TEXT,
  NOI_DISCLOSURE,
  csvAuditStatus,
  excludedNames,
  gapsForEntity,
  mentionsExcluded,
  shortSha,
  unattachedLeaseGaps,
} from '../../src/modules/property-financials/data-health';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const dq = (needle: string) => {
  const hit = D.data_quality.find((x) => x.includes(needle));
  if (!hit) throw new Error(`fixture drift: no data_quality item contains ${needle}`);
  return hit;
};
const texts = (id: PfEntityId) => gapsForEntity(D, id).map((g) => g.text);

const MISSING = dq('Missing monthly exports');
const RECONCILE = dq('reconciles to the annual P&Ls');
const FVC_AGG = dq('all-properties aggregate');
const ANNUAL = dq('entity-level annual QuickBooks');
const PM_NOI = dq('PM-reported NOI differs');
const SEPICH_HTML = dq('Sepich all-properties HTML export');
const NORTHWOOD = dq('Northwood');

describe('gapsForEntity — data_quality matcher over the 11 entities', () => {
  it('Westerville, Livingston and 9620 carry the missing-months item', () => {
    for (const id of ['3034 Westerville', '3883 Livingston', '9620 State 350'] as const) expect(texts(id)).toContain(MISSING);
    for (const id of ['1100 Rarig', '1900 Broadway', '29000 Info Lane', '3540 E 5th', '9050 Red Branch', 'FVC'] as const) {
      expect(texts(id)).not.toContain(MISSING);
    }
  });

  it('the reconciliation item reaches every entity it names (incl. Livingston / 9620 differences), not Westerville', () => {
    for (const id of ['1100 Rarig', '1900 Broadway', '29000 Info Lane', '3540 E 5th', '9050 Red Branch', 'FVC', '3883 Livingston', '9620 State 350'] as const) {
      expect(texts(id)).toContain(RECONCILE);
    }
    expect(texts('3034 Westerville')).not.toContain(RECONCILE);
  });

  it('FVC: aggregate + Sepich items, the SF-mapping inference, and every Sepich mention marked [INFERRED]', () => {
    const g = gapsForEntity(D, 'FVC');
    const by = (t: string) => g.find((x) => x.text === t);
    expect(by(FVC_AGG)?.inferred).toBe(true);
    expect(by(SEPICH_HTML)?.inferred).toBe(true);
    expect(by(PM_NOI)?.inferred).toBe(false);
    const mapping = g.find((x) => x.source === 'mapping');
    expect(mapping?.text).toBe(D.sf.FVC.note);
    expect(mapping?.inferred).toBe(true);
  });

  it('3540 E 5th: lease OCR partial; the FVC E 5th addresses never leak into it', () => {
    const g = gapsForEntity(D, '3540 E 5th');
    const lease = g.find((x) => x.source === 'lease');
    // names the lease's tenant (read from the dataset; never a hardcoded tenant name)
    expect(lease?.text).toContain(D.leases.find((l) => l.property === '3540 E 5th')!.tenant);
    expect(lease?.text).toMatch(/OCR of scan, first pages only/);
    expect(g.some((x) => x.source === 'mapping')).toBe(false);
  });

  it('a building number written before the street phrase must be the entity’s own; bare numbers and aliases match', () => {
    const with_ = (items: string[]) => ({ ...D, data_quality: items });
    const dqOf = (ds: ReturnType<typeof with_>, id: PfEntityId) => gapsForEntity(ds, id).filter((g) => g.source === 'data_quality').map((g) => g.text);
    const x = with_(['4595 E 5th roof is leaking.', '3540 E 5th roof is leaking.', 'Unit 9620 was re-metered.', 'EGFLLC books close late.', 'In 1900 the area was farmland.']);
    expect(dqOf(x, '3540 E 5th')).toEqual(['3540 E 5th roof is leaking.']);
    expect(dqOf(x, '9620 State 350')).toEqual(['Unit 9620 was re-metered.']);
    expect(dqOf(x, '55 New Plant (EGFLLC)')).toEqual(['EGFLLC books close late.']);
    // 1900 is year-like: a bare "1900" never names 1900 Broadway.
    expect(gapsForEntity(x, '1900 Broadway')).toEqual([]);
  });

  it('55 New Plant: annual-only item + renewal clause not read; Solar: annual-only item, no lease', () => {
    const np = gapsForEntity(D, '55 New Plant (EGFLLC)');
    expect(np.map((x) => x.text)).toContain(ANNUAL);
    expect(np.find((x) => x.source === 'lease')?.text).toMatch(/renewal clause not read/);
    const solar = gapsForEntity(D, '1851 South Club Solar');
    expect(solar.map((x) => x.text)).toEqual([ANNUAL]);
  });

  it('text-layer leases are not gaps (Westerville / Livingston have leases read from the text layer)', () => {
    expect(gapsForEntity(D, '3034 Westerville').some((x) => x.source === 'lease')).toBe(false);
    expect(gapsForEntity(D, '3883 Livingston').some((x) => x.source === 'lease')).toBe(false);
  });

  it('nothing is inferred outside FVC, no entity is handed the Northwood item, every entity resolves', () => {
    for (const id of PF_ENTITY_IDS) {
      const g = gapsForEntity(D, id);
      expect(g.map((x) => x.text)).not.toContain(NORTHWOOD);
      for (const x of g) expect(x.text).not.toMatch(/northwood/i);
      if (id !== 'FVC') expect(g.filter((x) => x.inferred)).toEqual([]);
    }
  });

  it('pins the full per-entity source mix (counts per entity)', () => {
    const shape = Object.fromEntries(PF_ENTITY_IDS.map((id) => [id, gapsForEntity(D, id).map((x) => x.source)]));
    expect(shape).toEqual({
      '1100 Rarig': ['data_quality'],
      // v03.2 (prepaid-rent ruling 2026-10-06): the NOI-definition note now names Broadway and Red Branch
      // (their Yardi Prepaid Rental Income is excluded), so each gains that note — was ['data_quality'].
      '1900 Broadway': ['data_quality', 'data_quality'],
      '29000 Info Lane': ['data_quality'],
      '3034 Westerville': ['data_quality'],
      '3540 E 5th': ['data_quality', 'lease'],
      '3883 Livingston': ['data_quality', 'data_quality'],
      '9050 Red Branch': ['data_quality', 'data_quality'],
      '9620 State 350': ['data_quality', 'data_quality'],
      FVC: ['data_quality', 'data_quality', 'data_quality', 'data_quality', 'mapping'],
      '55 New Plant (EGFLLC)': ['data_quality', 'lease'],
      '1851 South Club Solar': ['data_quality'],
    });
  });
});

describe('unattachedLeaseGaps', () => {
  it('Fishel and Sunburst attach to no entity (no P&L in folder) and are reported with their read quality', () => {
    const u = unattachedLeaseGaps(D);
    expect(u.map((x) => x.property)).toEqual(['7658 Fishel (no P&L in folder)', '401 Sunburst Highway (no P&L in folder)']);
    expect(u[1]!.text).toMatch(/addenda not read/);
    for (const id of PF_ENTITY_IDS) for (const g of gapsForEntity(D, id)) expect(g.text).not.toMatch(/Fishel|Sunburst/);
  });
});

describe('exclusions + helpers', () => {
  it('excluded names come from meta.excluded without the parenthetical', () => {
    expect(excludedNames(D.meta.excluded)).toEqual(['2203-2207 Northwood']);
    expect(mentionsExcluded(NORTHWOOD, D.meta.excluded)).toBe(true);
    expect(mentionsExcluded(MISSING, D.meta.excluded)).toBe(false);
  });

  it('shortSha keeps 12 hex chars; null stays null', () => {
    expect(shortSha('a'.repeat(64))).toBe('aaaaaaaaaaaa');
    expect(shortSha(null)).toBeNull();
  });

  it('the NOI disclosure names both spines and says not reconciled', () => {
    expect(NOI_DISCLOSURE).toBe(
      'Normalized NOI · cash basis · computed independently of the warehouse (Spine B) and the Master Workbook (Spine A); not reconciled',
    );
  });
});

describe('csvAuditStatus — monthly-long.csv is a local-only audit layer (Gabriel ruling 2026-10-06)', () => {
  const sha = 'c'.repeat(64);

  it('a hashed CSV reads as its sha', () => {
    expect(csvAuditStatus({ csvSha256: sha, csvError: null })).toEqual({ kind: 'sha', sha });
  });

  it('a CSV that is not on disk (ENOENT / ENOTDIR) reads as absent-by-policy, never as an error', () => {
    for (const csvError of ['monthly-long.csv: stat failed (ENOENT)', 'monthly-long.csv: stat failed (ENOTDIR)', 'monthly-long.csv: read failed (ENOENT)']) {
      expect(csvAuditStatus({ csvSha256: null, csvError })).toEqual({ kind: 'absent', text: AUDIT_CSV_ABSENT_TEXT });
    }
    // An older server that sends no error with no hash: nothing to show but absence.
    expect(csvAuditStatus({ csvSha256: null, csvError: null })).toEqual({ kind: 'absent', text: AUDIT_CSV_ABSENT_TEXT });
  });

  it('a genuine read failure stays a visible error (absence is only claimed for a missing file)', () => {
    expect(csvAuditStatus({ csvSha256: null, csvError: 'monthly-long.csv: read failed (EBUSY)' })).toEqual({
      kind: 'error',
      text: 'monthly-long.csv: read failed (EBUSY)',
    });
    expect(csvAuditStatus({ csvSha256: null, csvError: 'monthly-long.csv changed while being read' }).kind).toBe('error');
  });

  it('the absent text names the policy and the way back', () => {
    expect(AUDIT_CSV_ABSENT_TEXT).toBe('Audit CSV not present on this machine (kept off the remote by policy); regenerate with the refresh pipeline');
  });
});
