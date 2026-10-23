import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { fmtRange, fmtTimestamp } from '../analytics/format';
import { toProblem } from '../core/problem';
import { ErrorPanel } from '../shared/page-state';
import { CdpApi } from './api';
import { CdpContext } from './context';

const PAGES = [
  { path: 'segments', label: 'Segments' },
  { path: 'sites', label: 'Sites' },
  { path: 'player', label: 'Player 360' },
];

/** Frame for the CDP pages: sub-navigation, the 12-month window and which feeds are mock. */
@Component({
  selector: 'app-cdp-section',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <div class="title">
        <h2>{{ meta()?.client ?? 'Chickasaw' }} customer data platform</h2>
        @if (window(); as w) {
          <span class="note">{{ w }}</span>
        }
      </div>
      <nav class="sub" aria-label="CDP pages">
        @for (p of pages; track p.path) {
          <a [routerLink]="p.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ p.label }}</a>
        }
      </nav>
    </div>

    @if (meta(); as m) {
      <details class="mock" role="note">
        <summary>
          <span class="tag warn" aria-hidden="true">MOCK</span>
          <span><strong>Prototype on mock data.</strong> Only {{ realList() }} are real. Everything else is generated until Chickasaw's feeds arrive.</span>
        </summary>
        <ul>
          @for (f of m.feeds; track f.code) {
            <li>
              <span class="tag" [class.warn]="f.isMock" [class.good]="!f.isMock">{{ f.isMock ? 'mock' : 'real' }}</span>
              <span>{{ f.notes }}</span> <span class="mono src">{{ f.source }}</span>
            </li>
          }
        </ul>
      </details>
    }

    @if (context.problem(); as p) {
      <div class="page"><app-error-panel [problem]="p" (retry)="loadMeta()" /></div>
    } @else {
      <router-outlet />
    }
  `,
  styles: `
    .head {
      display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 6px 16px;
      padding: 14px 16px 0; background: var(--surface); border-bottom: 1px solid var(--line);
    }
    .title { display: grid; gap: 2px; padding-bottom: 8px; }
    .sub { display: flex; gap: 2px; }
    .sub a {
      padding: 8px 12px; color: var(--ink2); text-decoration: none; border-bottom: 2px solid transparent;
      font-weight: 550; font-size: 0.88rem;
    }
    .sub a:hover { color: var(--ink); }
    .sub a.active { color: var(--accent); border-bottom-color: var(--accent); }
    .mock {
      padding: 8px 16px; background: var(--warn-soft); border-bottom: 1px solid var(--line); font-size: 0.85rem;
    }
    .mock summary { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .mock ul { margin: 8px 0 2px; padding: 0; list-style: none; display: grid; gap: 4px; }
    .mock li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
    .src { color: var(--mute); font-size: 0.78rem; }
  `,
})
export class CdpSection {
  protected readonly context = inject(CdpContext);
  private readonly api = inject(CdpApi);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly pages = PAGES;

  protected readonly meta = this.context.meta;
  protected readonly window = computed(() => {
    const m = this.meta();
    if (!m) return null;
    return `Last 12 months: ${fmtRange(m.windowFrom, m.asOfDate)} · CDP refreshed ${fmtTimestamp(m.refreshedAt, 'America/Chicago')}`;
  });
  protected readonly realList = computed(() => {
    const real = (this.meta()?.feeds ?? []).filter((f) => !f.isMock).map((f) => f.notes.split(',')[0]!.replace(/ \(.*\)$/, ''));
    return real.length ? `the ${real.join(' and the ')}` : 'none of the feeds';
  });

  constructor() {
    this.loadMeta();
  }

  protected loadMeta(): void {
    this.context.problem.set(null);
    const sub = this.api.meta().subscribe({
      next: (meta) => this.context.meta.set(meta),
      error: (err: unknown) => this.context.problem.set(toProblem(err)),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
