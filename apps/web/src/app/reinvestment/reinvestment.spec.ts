import { describe, expect, it } from 'vitest';
import { ciBar } from './offers';
import { amount } from './optimizer';

describe('plan form amounts', () => {
  it('reads the ways people type dollars', () => {
    expect(amount('250,000')).toBe(250_000);
    expect(amount(' $60k ')).toBe(60_000);
    expect(amount('1.5M')).toBe(1_500_000);
    expect(amount('99.50')).toBe(99.5);
  });

  it('tells blank from unreadable', () => {
    expect(amount('')).toBeNull();
    expect(amount('   ')).toBeNull();
    expect(amount('lots')).toBeNaN();
    expect(amount('-5')).toBeNaN();
    expect(amount('5k5')).toBeNaN();
  });
});

describe('interval bars', () => {
  it('centres zero and places the interval on the scale', () => {
    const b = ciBar(-10, 30, 10, 40);
    expect(b.left).toBe(37.5);
    expect(b.width).toBe(50);
    expect(b.point).toBe(62.5);
    expect(b.clipLo || b.clipHi).toBe(false);
  });

  it('clips intervals wider than the scale and says so', () => {
    const b = ciBar(-200, 180, -10, 100);
    expect(b.left).toBe(0);
    expect(b.left + b.width).toBe(100);
    expect(b.clipLo && b.clipHi).toBe(true);
  });

  it('keeps a zero-width interval visible', () => {
    expect(ciBar(5, 5, 5, 10).width).toBeGreaterThan(0);
  });
});
