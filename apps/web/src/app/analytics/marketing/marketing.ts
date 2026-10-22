import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { MarketingData } from '@phub/contracts';
import { BarList, type BarItem } from '../../shared/bar-list';
import { InsightList } from '../../shared/insight-list';
import { KpiTile } from '../../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../../shared/page-state';
import { Filters } from '../filters';
import { fmtInt, fmtPct, fmtSeconds } from '../format';
import { marketingInsights } from '../insights';
import { loadView } from '../load';

const UNKNOWN_CAMPAIGNS = new Set(['unknown_campaign', '(none)']);
const KIND_LABEL = { promotion: 'Promotion', event: 'Event', drawing: 'Live drawing' } as const;
const titled = (label: string) => (label === '(none)' ? '(no title)' : label);

@Component({
  selector: 'app-marketing-page',
  imports: [KpiTile, InsightList, ErrorPanel, Skeleton, BarList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './marketing.html',
})
export class MarketingPage {
  protected readonly filters = inject(Filters);
  protected readonly state = loadView<MarketingData>('marketing');
  protected readonly includeTestZones = signal(false);

  protected readonly data = computed(() => {
    const s = this.state();
    return s.status === 'ready' ? s.envelope.data : null;
  });
  protected readonly problem = computed(() => {
    const s = this.state();
    return s.status === 'error' ? s.problem : null;
  });
  protected readonly insights = computed(() => {
    const d = this.data();
    return d ? marketingInsights(d) : [];
  });
  protected readonly fmt = fmtInt;

  /** Each step as a share of the step before it (inbox views → opened → read → CTA). */
  protected readonly funnel = computed<BarItem[]>(() => {
    const f = this.data()?.funnel;
    if (!f) return [];
    return [
      { label: 'Inbox viewed', value: f.inboxViewed },
      { label: 'Message opened', value: f.opened, note: `${fmtPct(f.opened, f.inboxViewed)} of inbox views` },
      { label: 'Marked read', value: f.markedRead, note: `${fmtPct(f.markedRead, f.opened)} of opened` },
      { label: 'CTA completed', value: f.ctaCompleted, note: `${fmtPct(f.ctaCompleted, f.opened)} of opened`, ...(f.ctaCompleted === 0 && f.opened > 0 ? { tag: 'check tracking', tagTone: 'warn' as const } : {}) },
      { label: 'Deleted', value: f.deleted, note: 'not a funnel step' },
    ];
  });

  protected readonly campaigns = computed<BarItem[]>(() =>
    (this.data()?.campaigns ?? []).map((c) => ({
      label: UNKNOWN_CAMPAIGNS.has(c.campaignId) ? 'No campaign ID' : c.campaignId,
      value: c.opens,
      ...(UNKNOWN_CAMPAIGNS.has(c.campaignId) ? { tag: 'untracked', tagTone: 'warn' as const } : {}),
    })),
  );

  protected readonly messages = computed<BarItem[]>(() => (this.data()?.topMessages ?? []).map((m) => ({ label: titled(m.title), value: m.opens })));

  protected readonly denials = computed<BarItem[]>(() =>
    (this.data()?.permissions.denialTypes ?? []).map((d) => ({ label: d.type === 'permanently_denied' ? 'Permanently denied' : d.type === 'skipped' ? 'Skipped (can ask again)' : d.type, value: d.count })),
  );

  protected readonly testZoneCount = computed(() => (this.data()?.geofences ?? []).filter((g) => g.isTest).length);
  protected readonly geofences = computed<BarItem[]>(() =>
    (this.data()?.geofences ?? [])
      .filter((g) => this.includeTestZones() || !g.isTest)
      .filter((g) => g.entries > 0)
      .map((g) => ({ label: g.zone, value: g.entries, ...(g.exits > 0 ? { note: `${fmtInt(g.exits)} exits` } : {}), ...(g.isTest ? { tag: 'test' } : {}) })),
  );
  private readonly shownZones = computed(() => (this.data()?.geofences ?? []).filter((g) => this.includeTestZones() || !g.isTest));
  protected readonly geofenceEntries = computed(() => this.shownZones().reduce((n, g) => n + g.entries, 0));
  protected readonly geofenceExits = computed(() => this.shownZones().reduce((n, g) => n + g.exits, 0));

  protected readonly webRows = computed(() =>
    (this.data()?.webContent ?? []).map((w) => ({ page: w.page, opens: fmtInt(w.opens), avg: fmtSeconds(w.avgSeconds) })),
  );
  protected readonly shortVisits = computed(() =>
    (this.data()?.webContent ?? []).filter((w) => w.opens >= 10 && w.avgSeconds !== null && w.avgSeconds < 1).map((w) => w.page),
  );

  protected readonly content = computed(() => {
    const views = this.data()?.contentViews ?? [];
    return (['promotion', 'event', 'drawing'] as const)
      .map((kind) => ({
        kind,
        label: KIND_LABEL[kind],
        items: views.filter((v) => v.kind === kind).map((v): BarItem => ({ label: titled(v.label), value: v.views, ...(v.avgSeconds !== null ? { note: `avg ${fmtSeconds(v.avgSeconds)}` } : {}) })),
      }))
      .filter((g) => g.items.length > 0);
  });
}
