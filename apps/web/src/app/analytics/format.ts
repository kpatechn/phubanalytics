const int = new Intl.NumberFormat('en-US');
const pct0 = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => int.format(n);

const pct1 = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Share as a whole percent; '–' when there is no denominator. */
export const fmtPct = (part: number, whole: number): string => (whole > 0 ? pct0.format(part / whole) : '–');

/** Success rates compared with a target: one decimal, so 94.8% never shows as a passing "95%". */
export const fmtRate = (part: number, whole: number): string => (whole > 0 ? pct1.format(part / whole) : '–');

export const fmtSeconds = (s: number | null): string => (s === null ? '–' : `${oneDecimal.format(s)} s`);

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

/** $512, $9,870, then $12.3K, $4.5M. */
export const fmtMoney = (n: number): string => (Math.abs(n) >= 10_000 ? usdCompact.format(n) : usd0.format(n));

/** A share already computed as 0..1; '–' when unknown. */
export const fmtShare = (share: number | null): string => (share === null ? '–' : pct0.format(share));

/** 'Sep 3' for a YYYY-MM-DD date (no time zone shift). */
export function fmtDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** 'Sep 3, 2025' for a YYYY-MM-DD date; '–' when missing. */
export function fmtDate(day: string | null): string {
  if (!day) return '–';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function fmtRange(from: string, to: string): string {
  const year = (d: string) => d.slice(0, 4);
  const end = new Date(`${to}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return year(from) === year(to) ? `${fmtDay(from)} – ${end}` : `${fmtDay(from)}, ${year(from)} – ${end}`;
}

/** 'Oct 21, 4:24 PM PDT' in the property's time zone. */
export function fmtTimestamp(iso: string | null, timeZone: string): string {
  if (!iso) return 'no data yet';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
}

export interface Delta {
  text: string;
  direction: 'up' | 'down' | 'flat' | 'none';
  /** Whether the change is good news; null when neutral or unknown. */
  good: boolean | null;
}

/** Change vs the previous period. higherIsBetter=null for neutral metrics. */
export function delta(current: number, previous: number, higherIsBetter: boolean | null = true): Delta {
  if (previous === 0) {
    return current === 0 ? { text: 'no change', direction: 'flat', good: null } : { text: 'no data in prior period', direction: 'none', good: null };
  }
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { text: 'no change', direction: 'flat', good: null };
  const direction = change > 0 ? 'up' : 'down';
  return {
    text: `${change > 0 ? '+' : '−'}${pct0.format(Math.abs(change))} vs prior period`,
    direction,
    good: higherIsBetter === null ? null : (change > 0) === higherIsBetter,
  };
}

/** Change of a ratio in percentage points, e.g. "+2.1 pts vs prior period". */
export function deltaPoints(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return { text: 'no change', direction: 'flat', good: null };
  return {
    text: `${points > 0 ? '+' : '−'}${oneDecimal.format(Math.abs(points))} pts vs prior period`,
    direction: points > 0 ? 'up' : 'down',
    good: points > 0,
  };
}

const PLATFORM_LABEL: Record<string, string> = { ios: 'iOS', android: 'Android', mac: 'Mac', web: 'Web', unknown: 'Unknown' };
export const fmtPlatform = (p: string): string => PLATFORM_LABEL[p] ?? p;

/** 0.5 s, 12 s, 3.2 min, 1.4 h. */
export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '–';
  if (seconds < 60) return `${oneDecimal.format(seconds)} s`;
  if (seconds < 3600) return `${oneDecimal.format(seconds / 60)} min`;
  return `${oneDecimal.format(seconds / 3600)} h`;
}
