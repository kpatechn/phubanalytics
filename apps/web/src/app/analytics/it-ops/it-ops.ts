import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { ItData } from '@phub/contracts';
import { BarList, type BarItem } from '../../shared/bar-list';
import { ChartCard, type TableColumn } from '../../shared/chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from '../../shared/chart.directive';
import { DeliveryCard } from '../../shared/delivery-card';
import { InsightList } from '../../shared/insight-list';
import { KpiTile } from '../../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../../shared/page-state';
import { Filters } from '../filters';
import { fmtDay, fmtDuration, fmtInt, fmtPct, fmtPlatform, fmtRate, fmtTimestamp } from '../format';
import { INSIGHT_CONFIG, itInsights } from '../insights';
import { loadView } from '../load';

const isServerError = (status: string) => /^5\d\d$/.test(status);

@Component({
  selector: 'app-it-ops-page',
  imports: [KpiTile, ChartCard, ChartDirective, InsightList, ErrorPanel, Skeleton, BarList, DeliveryCard],
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
      sendFail: (() => {
        const sent = d.delivery.byType.reduce((n, t) => n + t.sent, 0);
        const failed = d.delivery.byType.reduce((n, t) => n + t.failed, 0);
        return { value: fmtPct(failed, sent), sub: `${fmtInt(failed)} of ${fmtInt(sent)} sends` };
      })(),
      stuck: (() => {
        const real = d.jobs.filter((j) => !j.isTest);
        return { value: fmtInt(real.reduce((n, j) => n + j.stuck, 0)), sub: `of ${fmtInt(real.reduce((n, j) => n + j.runs, 0))} runs` };
      })(),
    };
  });

  protected readonly platformLabel = fmtPlatform;
  protected readonly duration = fmtDuration;

  protected readonly versionRows = computed(() =>
    (this.data()?.versions ?? []).map((v) => ({
      ...v,
      platformLabel: fmtPlatform(v.platform),
      errorsPer100: v.sessions > 0 ? ((v.errors / v.sessions) * 100).toFixed(1) : '–',
    })),
  );

  protected readonly lengthRows = computed(() =>
    (this.data()?.sessionLength ?? []).map((l) => ({
      ...l,
      platformLabel: fmtPlatform(l.platform),
      shares: l.buckets.map((b) => ({ label: b.label, text: fmtPct(b.sessions, l.ended) })),
    })),
  );
  protected readonly lengthLabels = computed(() => this.data()?.sessionLength[0]?.buckets.map((b) => b.label) ?? []);

  protected readonly platformItems = computed<BarItem[]>(() =>
    (this.data()?.platforms ?? []).map((p) => ({ label: fmtPlatform(p.platform), value: p.devices, note: `${fmtInt(p.accounts)} accounts · ${fmtInt(p.sessions)} sessions` })),
  );
  protected readonly modelItems = computed<BarItem[]>(() =>
    (this.data()?.deviceModels ?? []).map((m) => ({ label: `${m.model} (${fmtPlatform(m.platform)})`, value: m.devices, note: `${fmtInt(m.accounts)} accounts` })),
  );

  protected readonly showTestJobs = signal(false);
  protected readonly testJobs = computed(() => (this.data()?.jobs ?? []).filter((j) => j.isTest).length);
  protected readonly jobRows = computed(() => {
    const tz = this.filters.property()?.timeZone ?? 'UTC';
    return (this.data()?.jobs ?? [])
      .filter((j) => this.showTestJobs() || !j.isTest)
      .map((j) => ({
        ...j,
        failRate: fmtPct(j.failed, j.runs),
        failing: j.runs >= INSIGHT_CONFIG.jobs.minRuns && j.failed / j.runs >= INSIGHT_CONFIG.jobs.failShare,
        lastRun: j.lastStartAt ? fmtTimestamp(j.lastStartAt, tz) : '–',
      }));
  });
  protected readonly jobChart = computed<ChartBuilder>(() => {
    const days = this.data()?.jobDaily ?? [];
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: days.map((d) => fmtDay(d.day)), ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'Failed', type: 'bar', stack: 'bad', data: days.map((d) => d.failed), color: t.bad, barMaxWidth: 16 },
          { name: 'Stuck', type: 'bar', stack: 'bad', data: days.map((d) => d.stuck), color: t.warn, barMaxWidth: 16 },
        ],
      };
    };
  });
  protected readonly jobDayColumns: TableColumn[] = [
    { key: 'day', label: 'Day' },
    { key: 'runs', label: 'Runs', numeric: true },
    { key: 'failed', label: 'Failed', numeric: true },
    { key: 'stuck', label: 'Stuck', numeric: true },
  ];
  protected readonly jobDayRows = computed(() =>
    (this.data()?.jobDaily ?? []).map((d) => ({ day: fmtDay(d.day), runs: fmtInt(d.runs), failed: fmtInt(d.failed), stuck: fmtInt(d.stuck) })),
  );

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
