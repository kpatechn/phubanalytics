import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { ItData } from '@phub/contracts';
import { BarList, type BarItem } from '../../shared/bar-list';
import { ChartCard, type TableColumn } from '../../shared/chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from '../../shared/chart.directive';
import { InsightList } from '../../shared/insight-list';
import { KpiTile } from '../../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../../shared/page-state';
import { Filters } from '../filters';
import { fmtDay, fmtInt, fmtPct, fmtRate } from '../format';
import { INSIGHT_CONFIG, itInsights } from '../insights';
import { loadView } from '../load';

const isServerError = (status: string) => /^5\d\d$/.test(status);

@Component({
  selector: 'app-it-ops-page',
  imports: [KpiTile, ChartCard, ChartDirective, InsightList, ErrorPanel, Skeleton, BarList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './it-ops.html',
})
export class ItOpsPage {
  protected readonly filters = inject(Filters);
  protected readonly state = loadView<ItData>('it');

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
    return d ? itInsights(d) : [];
  });
  protected readonly fmt = fmtInt;

  protected readonly tiles = computed(() => {
    const d = this.data();
    if (!d) return null;
    const total = d.errors.reduce((n, e) => n + e.count, 0);
    const server = d.errors.filter((e) => isServerError(e.statusCode)).reduce((n, e) => n + e.count, 0);
    const uploads = d.errors.filter((e) => e.endpoint.includes(INSIGHT_CONFIG.uploadFailures.endpoint)).reduce((n, e) => n + e.count, 0);
    const checks = d.biometrics.passed + d.biometrics.failed;
    const showBio = checks >= INSIGHT_CONFIG.biometric.minChecks;
    const loginGap = d.logins.succeeded > d.logins.started;
    const showLogin = !loginGap && d.logins.started >= INSIGHT_CONFIG.loginRate.minAttempts;
    return {
      apiErrors: fmtInt(total),
      server: { value: fmtInt(server), sub: `${fmtPct(server, total)} of API errors` },
      uploads: { value: fmtInt(uploads), sub: `${fmtPct(uploads, total)} of API errors` },
      biometric: {
        value: showBio ? fmtRate(d.biometrics.passed, checks) : '–',
        sub: showBio ? `${fmtInt(d.biometrics.passed)} of ${fmtInt(checks)} checks` : `${fmtInt(d.biometrics.passed)} passed, ${fmtInt(d.biometrics.failed)} failed: too few for a rate`,
      },
      login: {
        value: showLogin ? fmtRate(d.logins.succeeded, d.logins.started) : '–',
        sub: loginGap
          ? `${fmtInt(d.logins.succeeded)} successes, ${fmtInt(d.logins.started)} attempts: tracking gap`
          : `${fmtInt(d.logins.succeeded)} of ${fmtInt(d.logins.started)} attempts`,
      },
      push: fmtInt(d.pushReceived),
    };
  });

  protected readonly errorChart = computed<ChartBuilder>(() => {
    const days = this.data()?.daily ?? [];
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: days.map((d) => fmtDay(d.day)), ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [{ name: 'API errors', type: 'bar', data: days.map((d) => d.errors), color: t.bad, barMaxWidth: 16 }],
      };
    };
  });
  protected readonly errorDayColumns: TableColumn[] = [
    { key: 'day', label: 'Day' },
    { key: 'errors', label: 'API errors', numeric: true },
    { key: 'events', label: 'All events', numeric: true },
  ];
  protected readonly errorDayRows = computed(() =>
    (this.data()?.daily ?? []).map((d) => ({ day: fmtDay(d.day), errors: fmtInt(d.errors), events: fmtInt(d.events) })),
  );

  protected readonly hourlyChart = computed<ChartBuilder>(() => {
    const hours = this.data()?.hourly ?? [];
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: hours.map((h) => String(h.hour).padStart(2, '0')), ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'Events', type: 'bar', data: hours.map((h) => h.events), color: t.accent, barMaxWidth: 14 },
          { name: 'API errors', type: 'bar', data: hours.map((h) => h.errors), color: t.bad, barMaxWidth: 14 },
        ],
      };
    };
  });
  protected readonly hourlyColumns: TableColumn[] = [
    { key: 'hour', label: 'Hour (property time)' },
    { key: 'events', label: 'Events', numeric: true },
    { key: 'errors', label: 'API errors', numeric: true },
  ];
  protected readonly hourlyRows = computed(() =>
    (this.data()?.hourly ?? []).map((h) => ({ hour: `${String(h.hour).padStart(2, '0')}:00`, events: fmtInt(h.events), errors: fmtInt(h.errors) })),
  );

  protected readonly screens = computed<BarItem[]>(() => (this.data()?.screens ?? []).map((s) => ({ label: s.screen, value: s.opens })));
  protected readonly authMethods = computed<BarItem[]>(() =>
    (this.data()?.logins.authMethods ?? []).map((m) => ({ label: m.method.toUpperCase() === m.method ? m.method : m.method.replace(/^\w/, (c) => c.toUpperCase()), value: m.count })),
  );
  protected readonly isServerError = isServerError;
}
