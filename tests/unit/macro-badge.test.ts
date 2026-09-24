import { describe, expect, it } from 'vitest';
import { isLiveMacro } from '../../src/modules/market/macro-badge';

describe('isLiveMacro', () => {
  it('treats the server’s live-fred literal (and the legacy fred alias) as live', () => {
    expect(isLiveMacro('live-fred')).toBe(true);
    expect(isLiveMacro('fred')).toBe(true);
    expect(isLiveMacro('mock')).toBe(false);
    expect(isLiveMacro('seed')).toBe(false);
  });
});
