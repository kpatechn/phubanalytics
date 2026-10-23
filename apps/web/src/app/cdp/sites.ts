import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { fmtInt, fmtMoney, fmtPct, fmtShare } from '../analytics/format';
import { BarList, type BarItem } from '../shared/bar-list';
import { ErrorPanel, Skeleton } from '../shared/page-state';
import { CdpApi } from './api';
import { CdpContext } from './context';
import { loadCdp } from './load';

@Component({
  selector: 'app-cdp-sites-page',
  imports: [BarList, ErrorPanel, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sites.html',
  styles: `
    .city { color: var(--mute); font-size: 0.8rem; }
    .extra { color: var(--mute); font-weight: 400; }
    table.matrix td.num { min-width: 64px; }
    table.matrix td.self { color: var(--mute); }
    .cell { display: inline-block; min-width: 3ch; padding: 1px 6px; border-radius: 4px; }
  `,
})
export class CdpSitesPage {
  private readonly api = inject(CdpApi);
  private readonly context = inject(CdpContext);

  private readonly loader = loadCdp(() => this.api.sites());
  protected readonly data = computed(() => {
    const s = this.loader.state();
    return s.status === 'ready' ? s.envelope.data : null;
  });
  protected readonly problem = computed(() => {
    const s = this.loader.state();
    return s.status === 'error' ? s.problem : null;
  });

  protected readonly fmt = fmtInt;
  protected readonly money = fmtMoney;
  protected readonly pct = fmtPct;
  protected readonly share = fmtShare;

  protected readonly theoBars = computed<BarItem[]>(() =>
    [...(this.data()?.sites ?? [])]
      .sort((a, b) => b.theo - a.theo)
      .map((s) => ({ label: s.name, value: Math.round(s.theo), note: `${fmtInt(s.trips)} trips`, ...(s.gamingIsMock ? { tag: 'mock', tagTone: 'warn' as const } : {}) })),
  );

  protected readonly nonGamingBars = computed<BarItem[]>(() =>
    [...(this.data()?.sites ?? [])]
      .filter((s) => s.nonGamingPaid > 0)
      .sort((a, b) => b.nonGamingPaid - a.nonGamingPaid)
      .map((s) => ({ label: s.name, value: Math.round(s.nonGamingPaid), note: `${fmtShare(s.knownGuestShare)} from known guests`, tag: 'mock', tagTone: 'warn' as const })),
  );

  /** Home site (rows) × other site visited (columns): players. Shading follows the number, which is always printed. */
  protected readonly matrix = computed(() => {
    const d = this.data();
    if (!d) return null;
    const codes = d.sites.map((s) => s.siteCode);
    const counts = new Map(d.crossVisits.map((c) => [`${c.homeSite}|${c.visitedSite}`, c.players]));
    const max = Math.max(1, ...d.crossVisits.map((c) => c.players));
    const homes = d.sites.filter((s) => s.homePlayers > 0);
    return {
      columns: codes.map((c) => ({ code: c, name: this.context.siteName(c) })),
      rows: homes.map((h) => ({
        name: h.name,
        homePlayers: h.homePlayers,
        cells: codes.map((c) => {
          const n = c === h.siteCode ? null : (counts.get(`${h.siteCode}|${c}`) ?? 0);
          // Up to 35% accent keeps the printed number readable in both themes.
          return { code: c, players: n, alpha: n ? Math.round(8 + (n / max) * 27) : 0 };
        }),
      })),
    };
  });

  protected reload(): void {
    this.loader.reload();
  }
}
