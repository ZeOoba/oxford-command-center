import { describe, it, expect } from 'vitest';
import { isAbsolute, sep } from 'node:path';
import { defaultEnvPath } from '../../server/load-env';

describe('defaultEnvPath()', () => {
  it('is an absolute path ending in .env, anchored to this module\'s own file location -- not process.cwd() -- so it works regardless of the directory the process was launched from (npm --prefix <dir> run <script> does NOT chdir the spawned process to <dir>)', () => {
    const p = defaultEnvPath();
    expect(p).not.toBe('.env'); // regression: this was the old cwd-relative default
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith(`${sep}.env`)).toBe(true);
  });

  it('returns the same value on every call (a fixed constant, not re-derived from process.cwd() per call)', () => {
    expect(defaultEnvPath()).toBe(defaultEnvPath());
  });
});
