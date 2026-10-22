import { describe, expect, it } from 'vitest';
import { DateRangeError, addDays, dayCount, isIsoDate, resolveRange, todayIn } from '../src/dates.js';

const LA = 'America/Los_Angeles';

describe('todayIn', () => {
  it('uses the property time zone, not UTC', () => {
    // 2026-10-02 05:30 UTC is still Oct 1 in Los Angeles.
    expect(todayIn(LA, new Date('2026-10-02T05:30:00Z'))).toBe('2026-10-01');
    expect(todayIn('UTC', new Date('2026-10-02T05:30:00Z'))).toBe('2026-10-02');
  });
});

describe('date helpers', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-09-03')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-3')).toBe(false);
  });

  it('adds days across DST and month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(dayCount('2026-09-03', '2026-10-02')).toBe(30);
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-10-22T18:00:00Z');

  it('defaults to the last 30 days ending today, with the previous 30 days', () => {
    expect(resolveRange({}, LA, now)).toEqual({
      from: '2026-09-23',
      to: '2026-10-22',
      previousFrom: '2026-08-24',
      previousTo: '2026-09-22',
      days: 30,
    });
  });

  it('keeps an explicit range and mirrors it for the previous period', () => {
    expect(resolveRange({ from: '2026-09-03', to: '2026-10-02' }, LA, now)).toMatchObject({
      days: 30,
      previousFrom: '2026-08-04',
      previousTo: '2026-09-02',
    });
  });

  it('fills a missing end 30 days after the start', () => {
    expect(resolveRange({ from: '2026-09-03' }, LA, now).to).toBe('2026-10-02');
  });

  it('rejects reversed and oversized ranges', () => {
    expect(() => resolveRange({ from: '2026-10-02', to: '2026-09-03' }, LA, now)).toThrow(DateRangeError);
    expect(() => resolveRange({ from: '2025-01-01', to: '2026-10-02' }, LA, now)).toThrow(/maximum is 366/);
  });
});
