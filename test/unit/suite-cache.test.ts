import { describe, expect, it } from 'vitest';
import { suiteCacheIdentity } from '../../scripts/suite-cache.ts';

describe('conformance reference cache', () => {
  it('invalidates recordings when compiler, runner or source revision changes', () => {
    const baseline = suiteCacheIdentity('compiler-a', 'runner-a', 'source-a');
    expect(suiteCacheIdentity('compiler-a', 'runner-a', 'source-a')).toBe(baseline);
    for (const changed of [
      ['compiler-b', 'runner-a', 'source-a'],
      ['compiler-a', 'runner-b', 'source-a'],
      ['compiler-a', 'runner-a', 'source-b'],
    ])
      expect(suiteCacheIdentity(...changed)).not.toBe(baseline);
    expect(suiteCacheIdentity('ab', 'c')).not.toBe(suiteCacheIdentity('a', 'bc'));
  });
});
