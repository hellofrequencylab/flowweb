import { describe, expect, test } from 'vitest';
import { canonicalJson, newId, nowIso, sha256Hex } from '../src/index.ts';

describe('canonicalJson (RFC 8785)', () => {
  test('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], A: { z: 0, y: -0 } })).toBe(
      '{"A":{"y":0,"z":0},"a":[true,null,"x"],"b":1}',
    );
    expect(canonicalJson({ '\u20ac': 1, '\r': 2, '1': 3 })).toBe('{"\\r":2,"1":3,"\u20ac":1}');
  });

  test('serialises numbers the ECMAScript way', () => {
    expect(canonicalJson([1e21, 1e-7, 0.1, 333333333.3333333, 100])).toBe(
      '[1e+21,1e-7,0.1,333333333.3333333,100]',
    );
  });

  test('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

test('sha256Hex hashes strings as UTF-8 and bytes as given', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
});

describe('newId', () => {
  test('is prefixed, ULID-shaped and matches the contract id pattern', () => {
    const id = newId('evt');
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).toMatch(/^[a-z]{2,4}_[0-9A-Za-z]{4,40}$/);
  });

  test('ids made in one millisecond sort in creation order and never repeat', () => {
    const ids = Array.from({ length: 500 }, () => newId('evt', 1_700_000_000_000));
    expect(new Set(ids).size).toBe(500);
    expect([...ids].sort()).toEqual(ids);
  });

  test('rejects a malformed prefix', () => {
    expect(() => newId('EVT')).toThrow(RangeError);
    expect(() => newId('toolong')).toThrow(RangeError);
  });
});

test('nowIso is UTC ISO-8601 with milliseconds', () => {
  expect(nowIso(new Date(Date.UTC(2026, 10, 8, 9, 52, 10, 410)))).toBe('2026-11-08T09:52:10.410Z');
  expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
