import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { fmtInt } from '../analytics/format';

export interface BarItem {
  label: string;
  value: number;
  /** Extra text after the value, e.g. "avg 0.5 s". */
  note?: string;
  /** Short tag such as "test" or "no ID". */
  tag?: string;
  tagTone?: 'warn' | 'bad';
}

/** Ranked list with proportional bars. Values are always printed, so bars are never the only signal. */
@Component({
  selector: 'app-bar-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length === 0) {
      <p class="note">{{ empty() }}</p>
    } @else {
      <ol>
        @for (item of items(); track item.label) {
          <li>
            <div class="row">
              <span class="label" [title]="item.label">{{ item.label }}</span>
              @if (item.tag) {
                <span class="tag" [class.warn]="item.tagTone === 'warn'" [class.bad]="item.tagTone === 'bad'">{{ item.tag }}</span>
              }
              <span class="value">{{ fmt(item.value) }}@if (item.note) {<span class="extra"> · {{ item.note }}</span>}</span>
            </div>
            <div class="track" aria-hidden="true"><div class="bar" [class.ctx]="item.tag === 'test'" [style.width.%]="pct(item.value)"></div></div>
          </li>
        }
      </ol>
    }
  `,
  styles: `
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .row { display: flex; align-items: baseline; gap: 8px; font-size: 0.85rem; }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .value { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .extra { color: var(--mute); font-weight: 400; }
    .track { height: 6px; background: var(--grid); border-radius: 3px; margin-top: 3px; }
    .bar { height: 100%; background: var(--accent); border-radius: 3px; min-width: 2px; }
    .bar.ctx { background: var(--ctx); }
  `,
})
export class BarList {
  readonly items = input.required<BarItem[]>();
  readonly empty = input('No data in this period.');

  private readonly max = computed(() => Math.max(1, ...this.items().map((i) => i.value)));
  protected pct(value: number): number {
    return (value / this.max()) * 100;
  }
  protected readonly fmt = fmtInt;
}
