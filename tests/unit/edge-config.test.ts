// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EDGE_STALE_DAYS, edgeDir } from '../../server/edge/config';
import { BUY_BOX_TYPES, EDGE_SERIES, SERIES_UNITS } from '../../server/edge/series';

const saved = process.env.OXFORD_EDGE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.OXFORD_EDGE_DIR;
  else process.env.OXFORD_EDGE_DIR = saved;
});

describe('edgeDir()', () => {
  it('defaults to the home-relative OneDrive oxford-edge output folder (never a C:\\Users\\Owner literal)', () => {
    delete process.env.OXFORD_EDGE_DIR;
    expect(edgeDir()).toBe(
      join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output'),
    );
  });

  it('honours OXFORD_EDGE_DIR, resolved at call time', () => {
    process.env.OXFORD_EDGE_DIR = 'D:/elsewhere/edge';
    expect(edgeDir()).toBe('D:/elsewhere/edge');
  });

  it('treats a blank OXFORD_EDGE_DIR as unset', () => {
    process.env.OXFORD_EDGE_DIR = '   ';
    expect(edgeDir()).toContain('oxford-edge');
  });

  it('pins the 7-day firm staleness rule', () => {
    expect(EDGE_STALE_DAYS).toBe(7);
  });
});

describe('series.ts', () => {
  it('re-exports the contract series/unit tables and declares the buy-box types', () => {
    expect(EDGE_SERIES).toHaveLength(18);
    expect(SERIES_UNITS.vac).toBe('pct_level');
    expect([...BUY_BOX_TYPES].sort()).toEqual(['named', 'named_custom']);
  });

  it('SERIES_UNITS keys match EDGE_SERIES exactly', () => {
    expect(Object.keys(SERIES_UNITS).sort()).toEqual([...EDGE_SERIES].sort());
  });
});
