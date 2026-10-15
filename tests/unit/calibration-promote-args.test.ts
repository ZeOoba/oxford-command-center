import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/calibration-promote';

describe('calibration:promote argument parsing', () => {
  it('accepts an obs_id with repeated or = form --supersedes', () => {
    expect(parseArgs(['x:new'])).toEqual({ obsId: 'x:new', supersedes: undefined });
    expect(parseArgs(['x:new', '--supersedes', 'a', '--supersedes=b'])).toEqual({ obsId: 'x:new', supersedes: ['a', 'b'] });
    expect(parseArgs(['--supersedes', 'a', 'x:new'])).toEqual({ obsId: 'x:new', supersedes: ['a'] });
  });

  it('never silently ignores a malformed flag', () => {
    expect(typeof parseArgs(['x:new', '--supersedes'])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersedes='])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersedes', '--other'])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersede', 'a'])).toBe('string');
    expect(typeof parseArgs(['x:new', 'y:new'])).toBe('string');
  });
});
