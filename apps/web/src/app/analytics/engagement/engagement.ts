import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { EngagementData, ReturnRate } from '@phub/contracts';
import { BarList, type BarItem } from '../../shared/bar-list';
import { ChartCard, type TableColumn } from '../../shared/chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from '../../shared/chart.directive';
import { InsightList } from '../../shared/insight-list';
import { KpiTile } from '../../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../../shared/page-state';
import { Filters } from '../filters';
import { delta, deltaPoints, fmtDay, fmtInt, fmtPct, fmtPlatform } from '../format';
import { INSIGHT_CONFIG, engagementInsights } from '../insights';
import { loadView } from '../load';

const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

@Component({
  selector: 'app-engagement-page',
  imports: [KpiTile, ChartCard, ChartDirective, InsightList, ErrorPanel, Skeleton, BarList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './engagement.html',
  styleUrl: './engagement.scss',
})
export class EngagementPage {
  protected readonly filters = inject(Filters);
  protected readonly state = loadView<EngagementData>('engagement');

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
    return d ? engagementInsights(d) : [];
  });

  protected readonly tiles = computed(() => {
    const d = this.data();
    if (!d) return null;
    const s = d.summary;
    const p = d.previous;
    const rate = (r: ReturnRate | undefined) => {
      if (!r) return { value: '–', sub: '' };
      const shown = r.eligible >= INSIGHT_CONFIG.engagement.minAccounts;
      return {
        value: shown ? fmtPct(r.returned, r.eligible) : '–',
        sub: shown
          ? `${fmtInt(r.returned)} of ${fmtInt(r.eligible)} new accounts`
          : `${fmtInt(r.returned)} of ${fmtInt(r.eligible)} new accounts: too few for a rate`,
      };
    };
    return {
      dau: { value: oneDecimal.format(s.dau), delta: delta(s.dau, p.dau) },
      wau: { value: oneDecimal.format(s.wau), delta: delta(s.wau, p.wau) },
      mau: { value: fmtInt(s.mau), delta: delta(s.mau, p.mau) },
      dauMau: { value: s.dauMau === null ? '–' : fmtPct(s.dauMau, 1), delta: deltaPoints(s.dauMau, p.dauMau) },
      wauMau: { value: s.wauMau === null ? '–' : fmtPct(s.wauMau, 1), delta: deltaPoints(s.wauMau, p.wauMau) },
      active: { value: fmtInt(s.activeAccounts), delta: delta(s.activeAccounts, p.activeAccounts) },
      new: { value: fmtInt(s.newAccounts), sub: `${fmtPct(s.newAccounts, s.activeAccounts)} of active`, delta: delta(s.newAccounts, p.newAccounts) },
      returning: { value: fmtInt(s.returningAccounts), sub: `${fmtPct(s.returningAccounts, s.activeAccounts)} of active`, delta: delta(s.returningAccounts, p.returningAccounts) },
      onsite: { value: fmtInt(s.onsiteAccounts), sub: `${fmtPct(s.onsiteAccounts, s.activeAccounts)} of active`, delta: delta(s.onsiteAccounts, p.onsiteAccounts) },
      week: rate(d.returnRates.find((r) => r.days === 7)),
      month: rate(d.returnRates.find((r) => r.days === 30)),
    };
  });

  private readonly days = computed(() => this.data()?.daily ?? []);
  private readonly labels = computed(() => this.days().map((d) => fmtDay(d.day)));

  protected readonly activeChart = computed<ChartBuilder>(() => {
    const days = this.days();
    const labels = this.labels();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: b.tooltip,
        legend: b.legend,
        xAxis: { type: 'category', data: labels, ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'DAU', type: 'line', data: days.map((d) => d.dau), color: t.accent, symbol: 'none', lineStyle: { width: 2 } },
          { name: 'WAU', type: 'line', data: days.map((d) => d.wau), color: t.accent, symbol: 'none', lineStyle: { width: 2, type: 'dashed' } },
          { name: 'MAU', type: 'line', data: days.map((d) => d.mau), color: t.ctx, symbol: 'none', lineStyle: { width: 2 } },
        ],
      };
    };
  });

  protected readonly stickinessChart = computed<ChartBuilder>(() => {
    const days = this.days();
    const labels = this.labels();
    const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v}%` : '–') },
        legend: b.legend,
        xAxis: { type: 'category', data: labels, ...b.categoryAxis },
        yAxis: { type: 'value', min: 0, max: 100, ...b.valueAxis, axisLabel: { ...b.valueAxis.axisLabel, formatter: '{value}%' } },
        series: [
          { name: 'DAU/MAU', type: 'line', data: days.map((d) => pct(d.dau, d.mau)), color: t.accent, symbol: 'none', lineStyle: { width: 2 } },
          { name: 'WAU/MAU', type: 'line', data: days.map((d) => pct(d.wau, d.mau)), color: t.ctx, symbol: 'none', lineStyle: { width: 2, type: 'dashed' } },
        ],
      };
    };
  });

  protected readonly newReturningChart = computed<ChartBuilder>(() => {
    const days = this.days();
    const labels = this.labels();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: labels, ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'New', type: 'bar', stack: 'accounts', data: days.map((d) => d.newAccounts), color: t.accent, barMaxWidth: 16 },
          { name: 'Returning', type: 'bar', stack: 'accounts', data: days.map((d) => d.returningAccounts), color: t.ctx, barMaxWidth: 16 },
        ],
      };
    };
  });

  protected readonly onsiteChart = computed<ChartBuilder>(() => {
    const days = this.days();
    const labels = this.labels();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: labels, ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'Active on property', type: 'bar', data: days.map((d) => d.onsite), color: t.accent, barMaxWidth: 16 },
          { name: 'All active (DAU)', type: 'line', data: days.map((d) => d.dau), color: t.ctx, symbol: 'none', lineStyle: { width: 2 } },
        ],
      };
    };
  });

  protected readonly dailyColumns: TableColumn[] = [
    { key: 'day', label: 'Day' },
    { key: 'dau', label: 'DAU', numeric: true },
    { key: 'wau', label: 'WAU', numeric: true },
    { key: 'mau', label: 'MAU', numeric: true },
    { key: 'dauMau', label: 'DAU/MAU', numeric: true },
    { key: 'wauMau', label: 'WAU/MAU', numeric: true },
    { key: 'new', label: 'New', numeric: true },
    { key: 'returning', label: 'Returning', numeric: true },
    { key: 'onsite', label: 'On property', numeric: true },
  ];
  protected readonly dailyRows = computed(() =>
    this.days().map((d) => ({
      day: fmtDay(d.day),
      dau: fmtInt(d.dau),
      wau: fmtInt(d.wau),
      mau: fmtInt(d.mau),
      dauMau: fmtPct(d.dau, d.mau),
      wauMau: fmtPct(d.wau, d.mau),
      new: fmtInt(d.newAccounts),
      returning: fmtInt(d.returningAccounts),
      onsite: fmtInt(d.onsite),
    })),
  );

  protected readonly features = computed<BarItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.features.map((f) => ({ label: f.feature, value: f.accounts, note: `${fmtPct(f.accounts, d.summary.activeAccounts)} of active` }));
  });

  protected readonly tierItems = computed<BarItem[]>(() =>
    (this.data()?.tiers ?? []).map((t) => ({
      label: t.tier,
      value: t.activeAccounts,
      note: `${fmtInt(t.onsiteAccounts)} on property · ${fmtInt(t.newAccounts)} new`,
    })),
  );

  /** Feature reach by tier: share of each tier's active accounts that used the feature. */
  protected readonly tierGrid = computed(() => {
    const d = this.data();
    if (!d) return { tiers: [] as string[], rows: [] as { feature: string; cells: string[] }[] };
    const tiers = d.tiers.map((t) => t.tier);
    const active = new Map(d.tiers.map((t) => [t.tier, t.activeAccounts]));
    const used = new Map(d.featureTiers.map((f) => [`${f.feature}|${f.tier}`, f.accounts]));
    const features = d.features.filter((f) => f.accounts > 0).map((f) => f.feature);
    return {
      tiers,
      rows: features.map((feature) => ({
        feature,
        cells: tiers.map((tier) => {
          const n = used.get(`${feature}|${tier}`) ?? 0;
          return n === 0 ? '–' : `${fmtInt(n)} (${fmtPct(n, active.get(tier) ?? 0)})`;
        }),
      })),
    };
  });

  protected readonly platformItems = computed<BarItem[]>(() =>
    (this.data()?.platforms ?? []).map((p) => ({
      label: fmtPlatform(p.platform),
      value: p.accounts,
      note: `${fmtInt(p.sessions)} sessions · ${fmtInt(p.devices)} devices`,
    })),
  );

  /** Retention grid: one row per weekly cohort, one column per week after it. */
  protected readonly cohortGrid = computed(() => {
    const cohorts = this.data()?.cohorts ?? [];
    const width = Math.max(0, ...cohorts.map((c) => c.weeks.length));
    return {
      weeks: Array.from({ length: width }, (_, i) => i),
      rows: cohorts.map((c) => ({
        label: fmtDay(c.weekStart),
        size: c.size,
        cells: Array.from({ length: width }, (_, i) => {
          const w = c.weeks[i];
          if (!w) return null;
          const share = c.size > 0 ? w.accounts / c.size : 0;
          // Tint capped at 40% so the printed value keeps 4.5:1 contrast in both themes.
          return { text: fmtPct(w.accounts, c.size), title: `${fmtInt(w.accounts)} of ${fmtInt(c.size)}`, partial: !w.complete, tint: Math.round(share * 40) };
        }),
      })),
    };
  });

  protected readonly historyStart = computed(() => {
    const start = this.data()?.historyStart;
    return start ? fmtDay(start) + ', ' + start.slice(0, 4) : null;
  });
}
