import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Problem } from '@phub/contracts';

/** Placeholder blocks while a view loads. */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sr" role="status">Loading…</div>
    <div class="row">@for (i of tiles; track i) {<div class="block tile"></div>}</div>
    <div class="row two"><div class="block chart"></div><div class="block chart"></div></div>
  `,
  styles: `
    :host { display: grid; gap: 16px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
    .row.two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); }
    .block { background: linear-gradient(90deg, var(--grid), var(--surface), var(--grid)); background-size: 200% 100%;
      border-radius: var(--radius); border: 1px solid var(--line); animation: shimmer 1.4s infinite linear; }
    .tile { height: 96px; } .chart { height: 300px; }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  `,
})
export class Skeleton {
  protected readonly tiles = [1, 2, 3, 4, 5, 6];
}

/** Problem details with a retry button. */
@Component({
  selector: 'app-error-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card" role="alert">
      <h2><span aria-hidden="true">✕</span> {{ problem().title }}</h2>
      @if (problem().detail) {
        <p>{{ problem().detail }}</p>
      }
      @for (e of problem().errors ?? []; track e.path) {
        <p class="note">{{ e.path }}: {{ e.message }}</p>
      }
      @if (problem().status !== 401 && problem().status !== 403) {
        <button type="button" class="btn" (click)="retry.emit()">Try again</button>
      }
    </div>
  `,
  styles: `
    .card { border-color: var(--bad); background: var(--bad-soft); }
    h2 { color: var(--bad); margin-bottom: 6px; }
    p { margin: 4px 0 10px; }
  `,
})
export class ErrorPanel {
  readonly problem = input.required<Problem>();
  readonly retry = output();
}
