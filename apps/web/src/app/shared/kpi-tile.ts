import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Delta } from '../analytics/format';
import { METRICS, type MetricKey } from '../analytics/metrics';
import { InfoTip } from './info-tip';

/** One headline number with its definition and change vs the prior period (icon + text, never color alone). */
@Component({
  selector: 'app-kpi-tile',
  imports: [InfoTip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="label">
      <span>{{ label() }}</span>
      <app-info-tip [key]="metric()" />
    </div>
    <div class="value">{{ value() }}</div>
    @if (sub(); as sub) {
      <div class="sub">{{ sub }}</div>
    }
    @if (delta(); as d) {
      <div class="delta" [class.good]="d.good === true" [class.bad]="d.good === false">
        <span aria-hidden="true">{{ arrow() }}</span> {{ d.text }}
      </div>
    }
  `,
  styles: `
    :host {
      display: grid; gap: 4px; align-content: start;
      background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
      box-shadow: var(--shadow); padding: 12px 14px; min-width: 0;
    }
    .label { display: flex; align-items: center; justify-content: space-between; gap: 6px; color: var(--mute); font-size: 0.8rem; }
    .value { font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
    .sub { color: var(--ink2); font-size: 0.8rem; }
    .delta { color: var(--mute); font-size: 0.78rem; }
    .delta.good { color: var(--good); }
    .delta.bad { color: var(--bad); }
  `,
})
export class KpiTile {
  readonly metric = input.required<MetricKey>();
  readonly value = input.required<string>();
  readonly sub = input<string | null>(null);
  readonly delta = input<Delta | null>(null);
  readonly labelOverride = input<string | null>(null, { alias: 'label' });

  protected readonly label = computed(() => this.labelOverride() ?? METRICS[this.metric()].label);
  protected readonly arrow = computed(() => {
    const d = this.delta();
    return d?.direction === 'up' ? '▲' : d?.direction === 'down' ? '▼' : d?.direction === 'flat' ? '●' : '';
  });
}
