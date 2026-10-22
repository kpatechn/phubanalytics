import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { METRICS, type MetricDefinition, type MetricKey } from '../analytics/metrics';

let nextId = 0;

/** "i" button that opens the metric's definition, source and caveat (native popover). */
@Component({
  selector: 'app-info-tip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="tip-btn" [attr.popovertarget]="id" [attr.aria-label]="'About ' + metric().label">i</button>
    <div [id]="id" popover class="tip" role="dialog" [attr.aria-label]="metric().label">
      <strong>{{ metric().label }}</strong>
      <p>{{ metric().definition }}</p>
      <p class="src"><span>Source</span> {{ metric().source }}</p>
      @if (metric().caveat; as caveat) {
        <p class="caveat"><span aria-hidden="true">⚠</span> {{ caveat }}</p>
      }
      <button type="button" class="btn" [attr.popovertarget]="id" popovertargetaction="hide">Close</button>
    </div>
  `,
  styles: `
    :host { display: inline-flex; }
    .tip-btn {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--line); background: var(--surface);
      color: var(--mute); font-size: 11px; font-weight: 700; line-height: 1; cursor: pointer; padding: 0;
    }
    .tip {
      max-width: min(360px, calc(100vw - 32px)); border: 1px solid var(--line); border-radius: var(--radius);
      background: var(--surface); color: var(--ink); padding: 14px 16px; box-shadow: 0 8px 30px rgb(0 0 0 / 25%);
      font-size: 0.85rem;
    }
    .tip::backdrop { background: rgb(0 0 0 / 20%); }
    p { margin: 6px 0; }
    .src span { color: var(--mute); margin-right: 4px; }
    .caveat { color: var(--warn); }
  `,
})
export class InfoTip {
  readonly key = input.required<MetricKey>();
  protected readonly metric = computed<MetricDefinition>(() => METRICS[this.key()]);
  protected readonly id = `metric-tip-${nextId++}`;
}
