import { describe, it, expect } from 'vitest';
import { stableStringify } from '../../server/warehouse/stable-stringify';

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('nested objects are also stable', () => {
    const a = { z: { y: 1, x: 2 }, m: 3 };
    const b = { m: 3, z: { x: 2, y: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles null', () => {
    expect(stableStringify(null)).toBe('null');
  });

  it('handles undefined as a top-level value (JSON.stringify passthrough)', () => {
    expect(stableStringify(undefined)).toBe(undefined as unknown as string);
  });

  it('handles arrays (preserving order)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested arrays', () => {
    expect(stableStringify({ b: [2, 1], a: [1, 2] })).toBe('{"a":[1,2],"b":[2,1]}');
  });

  it('round-trips through JSON.parse correctly', () => {
    const obj = { c: 3, a: 1, b: { y: 2, x: 1 } };
    const parsed = JSON.parse(stableStringify(obj));
    expect(parsed).toEqual(obj);
  });

  it('produces sorted-key JSON (matches calibration.ts expectation)', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('handles primitive numbers', () => {
    expect(stableStringify(42)).toBe('42');
  });

  it('handles primitive strings', () => {
    expect(stableStringify('hello')).toBe('"hello"');
  });

  it('handles boolean', () => {
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
  });

  it('undefined array elements are serialized as null (JSON.stringify parity)', () => {
    expect(stableStringify([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('undefined object values are omitted (JSON.stringify parity)', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('nested undefined in array within object is null', () => {
    expect(stableStringify({ a: [undefined] })).toBe('{"a":[null]}');
  });
});
