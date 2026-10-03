import { describe, expect, it } from 'vitest';
import { hashOf, stableStringify } from './hash.js';

describe('stableStringify', () => {
  it('sorts keys recursively but keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('gives equal hashes for objects that differ only in key order', () => {
    expect(hashOf({ x: 1, y: { z: 2, w: 3 } })).toBe(hashOf({ y: { w: 3, z: 2 }, x: 1 }));
    expect(hashOf({ x: 1 })).not.toBe(hashOf({ x: 2 }));
  });
});
