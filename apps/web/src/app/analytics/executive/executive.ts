import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { ExecutiveData } from '@phub/contracts';
import { ChartCard, type TableColumn } from '../../shared/chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from '../../shared/chart.directive';
import { InsightList } from '../../shared/insight-list';
import { KpiTile } from '../../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../../shared/page-state';
import { Filters } from '../filters';
import { delta, fmtDay, fmtInt, fmtPct, fmtRate } from '../format';
import { INSIGHT_CONFIG, executiveInsights } from '../insights';
import { loadView } from '../load';

@Component({
  selector: 'app-executive-page',
  imports: [KpiTile, ChartCard, ChartDirective, InsightList, ErrorPanel, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './executive.html',
})
export class ExecutivePage {
  protected readonly filters = inject(Filters);
  protected readonly state = loadView<ExecutiveData>('executive');

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
    return d ? executiveInsights(d) : [];
  });

  protected readonly tiles = computed(() => {
    const d = this.data();
    if (!d) return null;
    const k = d.kpis;
    const p = d.previous;
    const loginGap = k.loginSuccess > k.loginStarted;
    const rateShown = !loginGap && k.loginStarted >= INSIGHT_CONFIG.loginRate.minAttempts;
    return {
      sessions: { value: fmtInt(k.sessions), delta: delta(k.sessions, p.sessions) },
      appOpens: { value: fmtInt(k.appOpens), delta: delta(k.appOpens, p.appOpens) },
      loginRate: {
        value: rateShown ? fmtRate(k.loginSuccess, k.loginStarted) : '–',
        sub: loginGap
          ? `${fmtInt(k.loginSuccess)} successes, ${fmtInt(k.loginStarted)} attempts: tracking gap`
          : rateShown
            ? `${fmtInt(k.loginSuccess)} of ${fmtInt(k.loginStarted)} attempts`
            : `${fmtInt(k.loginStarted)} attempts: too few for a rate`,
      },
      playersLoggedIn: { value: fmtInt(k.playersLoggedIn), delta: delta(k.playersLoggedIn, p.playersLoggedIn) },
      activeGuests: { value: fmtInt(k.activeGuests), delta: delta(k.activeGuests, p.activeGuests) },
      onsiteShare: { value: fmtPct(k.onsiteEvents, k.totalEvents), sub: `${fmtInt(k.onsiteEvents)} of ${fmtInt(k.totalEvents)} events` },
      apiErrors: { value: fmtInt(k.apiErrors), sub: `${fmtPct(k.apiErrors, k.totalEvents)} of events`, delta: delta(k.apiErrors, p.apiErrors, false) },
      totalEvents: { value: fmtInt(k.totalEvents), delta: delta(k.totalEvents, p.totalEvents, null) },
    };
  });

  protected readonly dailyChart = computed<ChartBuilder>(() => {
    const days = this.data()?.daily ?? [];
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: b.tooltip,
        legend: b.legend,
        xAxis: { type: 'category', data: days.map((d) => fmtDay(d.day)), ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'Sessions', type: 'line', data: days.map((d) => d.sessions), color: t.accent, symbol: 'none', lineStyle: { width: 2 } },
          { name: 'Logins', type: 'line', data: days.map((d) => d.logins), color: t.ctx, symbol: 'none', lineStyle: { width: 2, type: 'dashed' } },
          { name: 'API errors', type: 'line', data: days.map((d) => d.errors), color: t.bad, symbol: 'none', lineStyle: { width: 2 } },
        ],
      };
    };
  });
  protected readonly dailyColumns: TableColumn[] = [
    { key: 'day', label: 'Day' },
    { key: 'sessions', label: 'Sessions', numeric: true },
    { key: 'logins', label: 'Logins', numeric: true },
    { key: 'errors', label: 'API errors', numeric: true },
    { key: 'events', label: 'Events', numeric: true },
  ];
  protected readonly dailyRows = computed(() =>
    (this.data()?.daily ?? []).map((d) => ({ day: fmtDay(d.day), sessions: fmtInt(d.sessions), logins: fmtInt(d.logins), errors: fmtInt(d.errors), events: fmtInt(d.events) })),
  );

  /** Features with any use, largest first. Unused features are listed under the chart. */
  private readonly usedFeatures = computed(() => (this.data()?.features ?? []).filter((f) => f.onsite + f.offsite + f.unknown > 0));
  protected readonly unusedFeatures = computed(() =>
    (this.data()?.features ?? []).filter((f) => f.onsite + f.offsite + f.unknown === 0).map((f) => f.feature),
  );

  protected readonly featureChart = computed<ChartBuilder>(() => {
    const features = [...this.usedFeatures()].reverse();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: { ...b.grid, left: 8 },
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        yAxis: { type: 'category', data: features.map((f) => f.feature), ...b.categoryAxis, axisLabel: { ...b.categoryAxis.axisLabel, color: t.ink2 } },
        series: [
          { name: 'On property', type: 'bar', stack: 'loc', data: features.map((f) => f.onsite), color: t.accent, barMaxWidth: 18 },
          { name: 'Off property', type: 'bar', stack: 'loc', data: features.map((f) => f.offsite), color: t.ctx, barMaxWidth: 18 },
        ],
      };
    };
  });
  protected readonly featureColumns: TableColumn[] = [
    { key: 'feature', label: 'Feature' },
    { key: 'onsite', label: 'On property', numeric: true },
    { key: 'offsite', label: 'Off property', numeric: true },
    { key: 'offShare', label: '% off property', numeric: true },
  ];
  protected readonly featureRows = computed(() =>
    this.usedFeatures().map((f) => ({
      feature: f.feature,
      onsite: fmtInt(f.onsite),
      offsite: fmtInt(f.offsite),
      offShare: fmtPct(f.offsite, f.onsite + f.offsite + f.unknown),
    })),
  );
}
