import { Injectable, computed, signal } from '@angular/core';
import type { ParamMap } from '@angular/router';
import type { Meta, Property } from '@phub/contracts';
import type { SummaryQuery } from './api';
import { addDays, isIsoDate, todayIn } from './dates';

export type Preset = '7d' | '30d' | '90d' | 'custom';

export const PRESETS: { value: Preset; label: string; days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
];

/**
 * Dashboard filters as signals. The shell mirrors them to the URL query string
 * (?range=30d or ?from=..&to=.., &property=..) so links are shareable.
 * Player IDs never go in the URL.
 */
@Injectable({ providedIn: 'root' })
export class Filters {
  readonly properties = signal<Property[]>([]);
  readonly propertyId = signal<number | null>(null);
  readonly preset = signal<Preset>('30d');
  readonly customFrom = signal<string | null>(null);
  readonly customTo = signal<string | null>(null);
  /** Bumped by "Try again" to reload the current view. */
  readonly reloadTick = signal(0);
  /** Meta of the most recent successful load, for the shell's freshness line. */
  readonly lastMeta = signal<Meta | null>(null);

  readonly property = computed(() => {
    const list = this.properties();
    return list.find((p) => p.propertyId === this.propertyId()) ?? list[0] ?? null;
  });

  readonly range = computed(() => {
    const property = this.property();
    if (!property) return null;
    const from = this.customFrom();
    const to = this.customTo();
    if (this.preset() === 'custom' && isIsoDate(from) && isIsoDate(to) && from <= to) return { from, to };
    const days = PRESETS.find((p) => p.value === this.preset())?.days ?? 30;
    const end = todayIn(property.timeZone);
    return { from: addDays(end, -(days - 1)), to: end };
  });

  readonly query = computed<(SummaryQuery & { tick: number }) | null>(() => {
    const property = this.property();
    const range = this.range();
    return property && range ? { property: property.propertyId, ...range, tick: this.reloadTick() } : null;
  });

  /** Query params that describe the current filters. */
  readonly urlParams = computed(() => {
    const custom = this.preset() === 'custom';
    return {
      range: custom ? null : this.preset(),
      from: custom ? this.customFrom() : null,
      to: custom ? this.customTo() : null,
      property: this.propertyId(),
    };
  });

  applyUrl(params: ParamMap): void {
    const from = params.get('from');
    const to = params.get('to');
    const range = params.get('range');
    const property = Number(params.get('property'));
    if (Number.isInteger(property) && property > 0) this.propertyId.set(property);
    if (isIsoDate(from) && isIsoDate(to) && from <= to) {
      this.customFrom.set(from);
      this.customTo.set(to);
      this.preset.set('custom');
    } else if (PRESETS.some((p) => p.value === range)) {
      this.preset.set(range as Preset);
    }
  }

  setCustom(from: string, to: string): void {
    if (isIsoDate(from) && isIsoDate(to) && from <= to) {
      this.customFrom.set(from);
      this.customTo.set(to);
      this.preset.set('custom');
    }
  }

  reload(): void {
    this.reloadTick.update((n) => n + 1);
  }
}
