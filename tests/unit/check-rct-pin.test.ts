// tests/unit/check-rct-pin.test.ts
//
// scripts/check-rct-pin.ts main() is the deploy-time pin gate (first step of build:mirror). Every failure path must
// exit 1: a gate that returned 0 from its catch block would let a synthetic, missing or unpinned table be bundled into
// the deployed drawer and edge Function. Each test runs main() with process.cwd() moved to a fresh temp dir, so the
// relative REPLACEMENT_COST_TABLE_PATH resolves to a table the test controls (the committed synthetic stand-in, or
// nothing). RCT_PIN_KEY is unset for every test and loadEnvFile is mocked out, so no real .env or key is ever read.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SYNTHETIC_RCT_FIXTURE } from '../support/rct-loader';

vi.mock('../../server/load-env', () => ({ loadEnvFile: () => {} }));

import { main } from '../../scripts/check-rct-pin';
import { REPLACEMENT_COST_TABLE_PATH } from '../../server/warehouse/acquisition';
import { RCT_PIN_KEY_ENV } from '../../server/warehouse/rct-pin';

let originalCwd: string;
let dir: string;
let errSpy: MockInstance;
let logSpy: MockInstance;

function seedSynthetic(): void {
  const target = join(dir, REPLACEMENT_COST_TABLE_PATH);
  mkdirSync(join(target, '..'), { recursive: true });
  copyFileSync(SYNTHETIC_RCT_FIXTURE, target);
}

function errorOutput(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'check-rct-pin-'));
  process.chdir(dir);
  vi.stubEnv(RCT_PIN_KEY_ENV, undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('check-rct-pin main() — deploy-time pin gate', () => {
  it('verify mode exits 1 on the synthetic stand-in', () => {
    seedSynthetic();
    expect(main([])).toBe(1);
    expect(errorOutput()).toMatch(/\[check-rct-pin\] FAIL: .*synthetic test stand-in/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('verify mode exits 1 when the table is missing', () => {
    expect(main([])).toBe(1);
    expect(errorOutput()).toMatch(/\[check-rct-pin\] FAIL: replacement-cost table not found/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('--print exits 1 when RCT_PIN_KEY is unset', () => {
    seedSynthetic();
    expect(process.env[RCT_PIN_KEY_ENV]).toBeUndefined();
    expect(main(['--print'])).toBe(1);
    expect(errorOutput()).toMatch(/\[check-rct-pin\] FAIL: RCT_PIN_KEY is not set/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('--print exits 1 when RCT_PIN_KEY is shorter than the minimum', () => {
    seedSynthetic();
    vi.stubEnv(RCT_PIN_KEY_ENV, 'test-key-too-short');
    expect(main(['--print'])).toBe(1);
    expect(errorOutput()).toMatch(/\[check-rct-pin\] FAIL: RCT_PIN_KEY is not set \(or shorter than/);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
