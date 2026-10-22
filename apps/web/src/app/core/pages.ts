import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Session } from './session';

@Component({
  selector: 'app-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="card">
        <h2>No analytics access</h2>
        @if (session.problem(); as p) {
          <p>{{ p.title }}{{ p.detail ? ': ' + p.detail : '' }}</p>
        } @else {
          <p>Your account has no analytics role. Ask an administrator for analytics:exec, analytics:marketing or analytics:it.</p>
        }
      </div>
    </div>
  `,
})
export class AccessPage {
  protected readonly session = inject(Session);
}

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="card">
        <h2>Page not found</h2>
        <p>This dashboard doesn't exist or your role can't open it. <a routerLink="/" queryParamsHandling="preserve">Go to your dashboards</a>.</p>
      </div>
    </div>
  `,
})
export class NotFoundPage {}
