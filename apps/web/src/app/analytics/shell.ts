import { UpperCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import type { View } from '@phub/contracts';
import { Session } from '../core/session';
import { savedTheme, setTheme, type ThemeChoice } from '../core/theme';
import { toProblem } from '../core/problem';
import { ErrorPanel } from '../shared/page-state';
import { AnalyticsApi } from './api';
import { Filters, PRESETS, type Preset } from './filters';
import { fmtRange, fmtTimestamp } from './format';

const TABS: { view: View; path: string; label: string }[] = [
  { view: 'executive', path: 'executive', label: 'Executive' },
  { view: 'engagement', path: 'engagement', label: 'Engagement' },
  { view: 'marketing', path: 'marketing', label: 'Marketing' },
  { view: 'it', path: 'it', label: 'IT & Operations' },
  { view: 'cdp', path: 'cdp', label: 'Chickasaw CDP' },
  { view: 'reinvestment', path: 'reinvestment', label: 'Reinvestment' },
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ErrorPanel, UpperCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly filters = inject(Filters);
  protected readonly session = inject(Session);
  private readonly api = inject(AnalyticsApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly presets = PRESETS;
  protected readonly themeChoice = signal<ThemeChoice>(savedTheme());
  protected readonly propertyProblem = signal<ReturnType<typeof toProblem> | null>(null);

  protected readonly tabs = computed(() => TABS.filter((t) => this.session.me()?.views.includes(t.view)));

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: null },
  );
  /** The CDP and reinvestment are another client's data with their own window: property, period and freshness controls don't apply. */
  protected readonly inCdp = computed(() => /^\/(cdp|reinvestment)\b/.test(this.currentUrl() ?? this.router.url));
  protected readonly property = this.filters.property;
  protected readonly rangeLabel = computed(() => {
    const r = this.filters.range();
    return r ? fmtRange(r.from, r.to) : '';
  });
  protected readonly freshness = computed(() => {
    const meta = this.filters.lastMeta();
    const p = this.property();
    if (!meta || !p) return null;
    return {
      dataAsOf: fmtTimestamp(meta.dataAsOf, p.timeZone),
      refreshed: fmtTimestamp(meta.lastRefreshAt, p.timeZone),
      platform: meta.dextransAsOf ? fmtTimestamp(meta.dextransAsOf, p.timeZone) : null,
    };
  });

  constructor() {
    this.filters.applyUrl(this.route.snapshot.queryParamMap);
    void this.session.load();

    const sub = this.api.properties().subscribe({
      next: (list) => this.filters.properties.set(list),
      error: (err: unknown) => this.propertyProblem.set(toProblem(err)),
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());

    // Mirror filters to the URL so the current view can be shared. Waits for the
    // first navigation (and its redirect) to finish, then only rewrites query params.
    effect(() => {
      const url = this.currentUrl();
      const params = this.filters.urlParams();
      if (url === null || this.inCdp()) return;
      const tree = this.router.parseUrl(url);
      for (const [key, value] of Object.entries(params)) {
        if (value === null) delete tree.queryParams[key];
        else tree.queryParams[key] = String(value);
      }
      if (this.router.serializeUrl(tree) !== url) void this.router.navigateByUrl(tree, { replaceUrl: true });
    });
  }

  protected setPreset(value: string): void {
    if (value === 'custom') {
      const r = this.filters.range();
      if (r) this.filters.setCustom(r.from, r.to);
    } else {
      this.filters.preset.set(value as Preset);
    }
  }

  protected setFrom(value: string): void {
    const to = this.filters.range()?.to;
    if (to) this.filters.setCustom(value, to);
  }

  protected setTo(value: string): void {
    const from = this.filters.range()?.from;
    if (from) this.filters.setCustom(from, value);
  }

  protected setProperty(value: string): void {
    this.filters.propertyId.set(Number(value));
  }

  protected setThemeChoice(value: string): void {
    const choice = value as ThemeChoice;
    this.themeChoice.set(choice);
    setTheme(choice);
  }
}
