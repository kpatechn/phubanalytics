// Business-day arithmetic on YYYY-MM-DD strings. Days are calendar dates in the
// property's time zone; arithmetic runs in UTC so DST never shifts a date.

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Number of days from..to inclusive. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export interface DateRange {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  days: number;
}

export class DateRangeError extends Error {}

/** Defaults to the last 30 days ending today (property time). */
export function resolveRange(input: { from?: string | undefined; to?: string | undefined }, timeZone: string, now: Date = new Date()): DateRange {
  const to = input.to ?? (input.from ? addDays(input.from, DEFAULT_RANGE_DAYS - 1) : todayIn(timeZone, now));
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) {
    throw new DateRangeError('from must be on or before to');
  }
  const days = dayCount(from, to);
  if (days > MAX_RANGE_DAYS) {
    throw new DateRangeError(`range is ${days} days; the maximum is ${MAX_RANGE_DAYS}`);
  }
  const previousTo = addDays(from, -1);
  return { from, to, previousFrom: addDays(previousTo, -(days - 1)), previousTo, days };
}
