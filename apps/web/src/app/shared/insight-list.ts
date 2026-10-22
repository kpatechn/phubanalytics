import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Insight, Severity } from '../analytics/insights';

const ICON: Record<Severity, string> = { good: '✓', info: 'i', warn: '!', bad: '✕' };
const LABEL: Record<Severity, string> = { good: 'Good', info: 'Note', warn: 'Watch', bad: 'Problem' };

/** Insight callouts: icon + severity word + text, so color is never the only cue. */
@Component({
  selector: 'app-insight-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (insights().length > 0) {
      <ul aria-label="Insights">
        @for (i of insights(); track i.id) {
          <li [class]="i.severity">
            <span class="icon" aria-hidden="true">{{ icon[i.severity] }}</span>
            <div>
              <strong><span class="visually-hidden">{{ label[i.severity] }}: </span>{{ i.title }}</strong>
              <p>{{ i.detail }}</p>
            </div>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); }
    li { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--surface); }
    .icon { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: var(--surface); }
    .good { background: var(--good-soft); } .good .icon { background: var(--good); }
    .info { background: var(--ctx-soft); } .info .icon { background: var(--mute); }
    .warn { background: var(--warn-soft); } .warn .icon { background: var(--warn); }
    .bad { background: var(--bad-soft); } .bad .icon { background: var(--bad); }
    strong { font-size: 0.88rem; }
    p { margin: 2px 0 0; font-size: 0.82rem; color: var(--ink2); }
  `,
})
export class InsightList {
  readonly insights = input.required<Insight[]>();
  protected readonly icon = ICON;
  protected readonly label = LABEL;
}
