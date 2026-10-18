import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/calibration-promote';

describe('calibration:promote argument parsing', () => {
  it('accepts an obs_id with repeated or = form --supersedes', () => {
    expect(parseArgs(['x:new'])).toEqual({ obsId: 'x:new', supersedes: undefined, allowDuplicateDocument: false, allowBesidePlaceholder: false });
    expect(parseArgs(['x:new', '--supersedes', 'a', '--supersedes=b'])).toEqual({ obsId: 'x:new', supersedes: ['a', 'b'], allowDuplicateDocument: false, allowBesidePlaceholder: false });
    expect(parseArgs(['--supersedes', 'a', 'x:new'])).toEqual({ obsId: 'x:new', supersedes: ['a'], allowDuplicateDocument: false, allowBesidePlaceholder: false });
  });

  it('--allow-duplicate-document is an explicit opt-in for a second scope on one quote document', () => {
    expect(parseArgs(['x:new', '--allow-duplicate-document'])).toEqual({ obsId: 'x:new', supersedes: undefined, allowDuplicateDocument: true, allowBesidePlaceholder: false });
    expect(parseArgs(['x:new', '--allow-beside-placeholder'])).toEqual({ obsId: 'x:new', supersedes: undefined, allowDuplicateDocument: false, allowBesidePlaceholder: true });
    expect(typeof parseArgs(['x:new', '--allow-duplicate-documents'])).toBe('string');
  });

  it('never silently ignores a malformed flag', () => {
    expect(typeof parseArgs(['x:new', '--supersedes'])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersedes='])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersedes', '--other'])).toBe('string');
    expect(typeof parseArgs(['x:new', '--supersede', 'a'])).toBe('string');
    expect(typeof parseArgs(['x:new', 'y:new'])).toBe('string');
  });
});
