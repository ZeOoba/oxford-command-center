// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  PF_STALE_DAYS,
  propertyFinancialsDir,
  propertyFinancialsStatusPath,
} from '../../server/property-financials/config';

const saved = { dir: process.env.PROPERTY_FINANCIALS_DIR, status: process.env.PROPERTY_FINANCIALS_STATUS_PATH };
afterEach(() => {
  if (saved.dir === undefined) delete process.env.PROPERTY_FINANCIALS_DIR;
  else process.env.PROPERTY_FINANCIALS_DIR = saved.dir;
  if (saved.status === undefined) delete process.env.PROPERTY_FINANCIALS_STATUS_PATH;
  else process.env.PROPERTY_FINANCIALS_STATUS_PATH = saved.status;
});

describe('propertyFinancialsDir()', () => {
  it('defaults to <repo>/data/property-financials', () => {
    delete process.env.PROPERTY_FINANCIALS_DIR;
    expect(propertyFinancialsDir()).toBe(join(process.cwd(), 'data', 'property-financials'));
  });

  it('honours PROPERTY_FINANCIALS_DIR, resolved at call time', () => {
    process.env.PROPERTY_FINANCIALS_DIR = 'D:/elsewhere/pf';
    expect(propertyFinancialsDir()).toBe('D:/elsewhere/pf');
  });

  it('treats a blank PROPERTY_FINANCIALS_DIR as unset', () => {
    process.env.PROPERTY_FINANCIALS_DIR = '   ';
    expect(propertyFinancialsDir()).toBe(join(process.cwd(), 'data', 'property-financials'));
  });
});

describe('propertyFinancialsStatusPath()', () => {
  it('defaults to <repo>/data/property-financials-status.json (outside the dataset dir)', () => {
    delete process.env.PROPERTY_FINANCIALS_STATUS_PATH;
    expect(propertyFinancialsStatusPath()).toBe(join(process.cwd(), 'data', 'property-financials-status.json'));
  });

  it('honours PROPERTY_FINANCIALS_STATUS_PATH at call time', () => {
    process.env.PROPERTY_FINANCIALS_STATUS_PATH = 'D:/x/status.json';
    expect(propertyFinancialsStatusPath()).toBe('D:/x/status.json');
  });
});

describe('staleness constant', () => {
  it('pins the 45-day as_of freshness window', () => {
    expect(PF_STALE_DAYS).toBe(45);
  });
});
