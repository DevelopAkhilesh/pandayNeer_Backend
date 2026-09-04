import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import { normalizePhone, generateOtp } from './otp.service.js';


// ---------------------------------------------------------------------------
// 1. normalizePhone — pure, no DB
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '9876543210', 'bare 10 digit'],
    ['+91 98765 43210', '9876543210', 'plus-91 with spaces'],
    ['91-9876543210', '9876543210', '91 with dash'],
    ['09876543210', '9876543210', 'leading trunk zero'],
    ['00919876543210', '9876543210', 'double-zero international prefix'],
    ['(987) 654-3210', '9876543210', 'punctuation'],
    ['6000000001', '6000000001', 'starts with 6'],
    ['7999999999', '7999999999', 'starts with 7'],
    ['8123456789', '8123456789', 'starts with 8'],
  ])('accepts %s -> %s (%s)', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['0000000000', 'all zeros'],
    ['1234567890', 'starts with 1'],
    ['5876543210', 'starts with 5'],
    ['98765432', 'too short'],
    ['98765432101', 'too long'],
    ['', 'empty string'],
    ['abcdefghij', 'letters only'],
    ['+1 415 555 0134', 'US number — must be rejected (SMS pumping guard)'],
    ['+44 7700 900123', 'UK number — must be rejected'],
    [null, 'null'],
    [undefined, 'undefined'],
    [9876543210, 'number type, not string'],
    [{}, 'object'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. generateOtp range
// ---------------------------------------------------------------------------
describe('generateOtp', () => {
  it('always produces exactly 6 digits', () => {
    // Collect failures rather than asserting per iteration — 20k vitest
    // assertions cost far more than the 20k draws they check.
    const bad = [];
    for (let i = 0; i < 20_000; i++) {
      const otp = generateOtp();
      if (!/^\d{6}$/.test(otp)) bad.push(otp);
    }
    expect(bad).toEqual([]);
  });

  it('asks for an EXCLUSIVE upper bound of 1000000, so 999999 is reachable', () => {
    // Sampling cannot prove this: hitting the exact extreme in N draws from a
    // 900k space is a coin flip (~20% at 200k draws), which makes for a test
    // that fails at random. Assert the bounds themselves instead.
    const spy = vi.spyOn(crypto, 'randomInt');
    try {
      generateOtp();
      expect(spy).toHaveBeenCalledWith(100000, 1000000);

      // And that both extremes of that range render as valid 6-digit codes.
      spy.mockReturnValueOnce(999999);
      expect(generateOtp()).toBe('999999');
      spy.mockReturnValueOnce(100000);
      expect(generateOtp()).toBe('100000');
    } finally {
      spy.mockRestore();
    }
  });

  it('never draws outside [100000, 999999]', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 50_000; i++) {
      const n = Number(generateOtp());
      if (n < min) min = n;
      if (n > max) max = n;
    }
    expect(min).toBeGreaterThanOrEqual(100000);
    expect(max).toBeLessThanOrEqual(999999);
  });
});

// ---------------------------------------------------------------------------
// 3. requestOtp — happy path
// ---------------------------------------------------------------------------
