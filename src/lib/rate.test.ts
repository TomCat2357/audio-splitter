import { describe, expect, it } from 'vitest';
import { MAX_RATE, MIN_RATE, clampRate, formatRate } from './rate';

describe('clampRate', () => {
  it('keeps values in range and rounds to 0.05', () => {
    expect(clampRate(1)).toBe(1);
    expect(clampRate(1.26)).toBe(1.25);
    expect(clampRate(0.1)).toBe(MIN_RATE);
    expect(clampRate(10)).toBe(MAX_RATE);
    expect(clampRate(1.1 + 0.25)).toBe(1.35);
  });
  it('treats non-finite values as 1', () => {
    expect(clampRate(NaN)).toBe(1);
    expect(clampRate(Infinity)).toBe(1);
  });
});

describe('formatRate', () => {
  it('drops trailing zeros', () => {
    expect(formatRate(1.5)).toBe('1.5');
    expect(formatRate(2)).toBe('2');
    expect(formatRate(0.25)).toBe('0.25');
  });
});
