import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { RxContext } from './context';

const PAGES = [
  { path: 'overview', label: 'Command center' },
  { path: 'offers', label: 'Offer effectiveness' },
  { path: 'player', label: 'Player 360' },
  { path: 'optimizer', label: 'Optimizer' },
];

/** Frame for the reinvestment pages: sub-navigation, and what the numbers rest on (simulated data, draft finance rules). */
@Component({
  selector: 'app-rx-section',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <div class="title">
        <h2>Reinvestment</h2>
        @if (meta(); as m) {
          <span class="note">Tenant {{ m.tenant }}{{ m.asOfMonth ? ' · data through ' + monthLabel(m.asOfMonth) : '' }}</span>
        }
      </div>
      <nav class="sub" aria-label="Reinvestment pages">
        @for (p of pages; track p.path) {
          <a [routerLink]="p.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ p.label }}</a>
        }
      </nav>
    </div>
    @if (meta(); as m) {
      <div class="banners">
        @if (m.dataKind === 'mock') {
          <p class="banner" role="note">
            <span class="tag warn">FICTIONAL</span>
            <span><strong>Simulated tenant.</strong> Every player, visit, offer and dollar here is generated. The numbers show how the method works, not how any casino performs.</span>
          </p>
        }
        @if (draft()) {
          <p class="banner" role="note">
            <span class="tag">DRAFT RULES</span>
            <span>Contribution and cost use finance rules {{ m.ruleVersion }} until Finance approves them.</span>
          </p>
        }
      </div>
    }
    <router-outlet />
  `,
  styles: `
    .head {
      display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 6px 16px;
      max-width: 1280px; margin: 0 auto; padding: 16px 16px 0;
    }
    .title { display: grid; gap: 2px; }
    h2 { margin: 0; font-size: 1.15rem; }
    .sub { display: flex; flex-wrap: wrap; gap: 4px; }
    .sub a {
      padding: 6px 10px; border-radius: 8px; color: var(--ink2); text-decoration: none; font-size: 0.88rem;
      border: 1px solid transparent;
    }
    .sub a.active { background: var(--surface); border-color: var(--line); color: var(--ink); font-weight: 600; }
    .banners { display: grid; gap: 6px; max-width: 1280px; margin: 10px auto 0; padding: 0 16px; }
    .banner { display: flex; gap: 8px; align-items: baseline; margin: 0; font-size: 0.84rem; color: var(--ink2); }
  `,
})
export class RxSection {
  private readonly context = inject(RxContext);
  protected readonly pages = PAGES;
  protected readonly meta = this.context.meta;
  protected readonly draft = computed(() => (this.meta()?.ruleVersion ?? '').includes('draft'));

  protected monthLabel(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
}
